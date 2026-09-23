import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";

const refreshScript = fileURLToPath(new URL("../src/refresh-provider.mjs", import.meta.url));

async function fixture({ fail = false, planType = "shadowsocks" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monocloud-refresh-"));
  const cache = path.join(root, "cache");
  await fs.mkdir(cache);
  await fs.writeFile(path.join(cache, "monocloud.yaml"), "previous-validated-content");
  const credentials = path.join(root, "credentials.json");
  await fs.writeFile(credentials, JSON.stringify({ email: "owner@example.invalid", password: "private-password" }));
  const mock = path.join(root, "upstream.mjs");
  await fs.writeFile(mock, [
    "globalThis.fetch = async (url, init = {}) => {",
    ' const pathname = new URL(url).pathname;',
    ' if (pathname.endsWith("/oauth/token")) return Response.json({access_token:"private-access-token"});',
    ` if (pathname.endsWith("/api/service")) return Response.json([{id:7,expire_date:"2099-01-01",plan:{type:${JSON.stringify(planType)}}}]);`,
    ' if (pathname.endsWith("/api/bandwidth/7")) return Response.json({upload:10,download:20,allowance:100,reset_days:4});',
    ' if (pathname.endsWith("/api/shadowsocks/7")) return Response.json([{alias:"Synthetic",emoji:"US",group:"Test",enable:1,hostname:"203.0.113.8",port:443,encryption:"chacha20-ietf-poly1305",password:"private-node-secret"}]);',
    fail ? ' throw new Error("private-upstream-secret");' : ' throw new Error("Unexpected request; real networking disabled");',
    "};",
  ].join("\n"));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:FLYBIRD|LEAPVPN|MONOCLOUD)_/.test(key)));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, refreshScript, "monocloud"], {
    cwd: root,
    env: { ...environment, SUBSCRIPTION_CACHE_DIR: cache, MONOCLOUD_CREDENTIAL_FILE: credentials,
      PUBLIC_DOMAIN: "sub.example.invalid" }, encoding: "utf8", timeout: 10_000,
  });
  return { root, cache, result };
}

test("MonoCloud refresh authenticates, routes and commits a separate last-good cache", async () => {
  const value = await fixture();
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    const config = YAML.parse(await fs.readFile(path.join(value.cache, "monocloud.yaml"), "utf8"));
    assert.deepEqual(config.proxies, [{ name:"US Synthetic Test", type:"ss", server:"203.0.113.8", port:443,
      cipher:"chacha20-ietf-poly1305", password:"private-node-secret", udp:true }]);
    assert.equal(config.rules.at(-1), "MATCH,漏网之鱼");
    assert.equal(await fs.readFile(path.join(value.cache, "monocloud.previous.yaml"), "utf8"), "previous-validated-content");
    const metadata = JSON.parse(await fs.readFile(path.join(value.cache, "monocloud.json"), "utf8"));
    assert.equal(metadata.provider, "monocloud");
    assert.equal(metadata.proxyCount, 1);
    assert.deepEqual(metadata.authentication, { mode: "account_login", planCount: 1 });
    assert.deepEqual(metadata.account, { checkedPlanCount:1, maximumUsagePercent:30, minimumResetDays:4 });
    assert.doesNotMatch(value.result.stdout + value.result.stderr + JSON.stringify(metadata),
      /private-password|private-access-token|private-node-secret/);
  } finally { await fs.rm(value.root, { recursive:true, force:true }); }
});

test("exhausted MonoCloud traffic preserves the last-good cache and records a clear error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monocloud-exhausted-"));
  try {
    const cache = path.join(root, "cache");
    await fs.mkdir(cache);
    await fs.writeFile(path.join(cache, "monocloud.yaml"), "previous-validated-content");
    const credentials = path.join(root, "credentials.json");
    await fs.writeFile(credentials, JSON.stringify({ email:"owner@example.invalid", password:"private-password" }));
    const mock = path.join(root, "upstream.mjs");
    await fs.writeFile(mock, `globalThis.fetch=async url=>{
      const path=new URL(url).pathname;
      if(path.endsWith('/oauth/token'))return Response.json({access_token:'private-access-token'});
      if(path.endsWith('/api/service'))return Response.json([{id:7,expire_date:'2099-01-01',plan:{type:'shadowsocks'}}]);
      if(path.endsWith('/api/bandwidth/7'))return Response.json({upload:60,download:50,allowance:100,reset_days:4});
      throw new Error('Node list must not be requested');};`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, refreshScript, "monocloud"], {
      cwd:root, env:{...process.env,SUBSCRIPTION_CACHE_DIR:cache,MONOCLOUD_CREDENTIAL_FILE:credentials,
        PUBLIC_DOMAIN:"sub.example.invalid"}, encoding:"utf8", timeout:10_000,
    });
    assert.equal(result.status, 1);
    assert.equal(await fs.readFile(path.join(cache,"monocloud.yaml"),"utf8"), "previous-validated-content");
    const metadata = JSON.parse(await fs.readFile(path.join(cache,"monocloud.json"),"utf8"));
    assert.match(metadata.lastError, /traffic allowance is exhausted/);
    assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(metadata), /private-password|private-access-token/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("unsupported MonoCloud plans preserve the last-good cache without leaking secrets", async () => {
  const value = await fixture({ planType: "vpn" });
  try {
    assert.equal(value.result.status, 1);
    assert.equal(await fs.readFile(path.join(value.cache, "monocloud.yaml"), "utf8"), "previous-validated-content");
    const metadata = await fs.readFile(path.join(value.cache, "monocloud.json"), "utf8");
    assert.match(JSON.parse(metadata).lastError, /Unsupported MonoCloud plan type/);
    assert.doesNotMatch(value.result.stdout + value.result.stderr + metadata,
      /private-password|private-access-token|private-node-secret|private-upstream-secret/);
  } finally { await fs.rm(value.root, { recursive:true, force:true }); }
});
