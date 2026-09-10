import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const refreshScript = fileURLToPath(new URL("../src/refresh-provider.mjs", import.meta.url));

async function runFixture(fail, automaticLogin = false, busy = false, brokenRouting = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-refresh-"));
  const cache = path.join(root, "cache");
  await fs.mkdir(cache);
  const source = path.join(root, "source.yaml");
  const valid = JSON.stringify({ proxies: [{ name: "one", type: "vless", server: "203.0.113.8", port: 443 }], "proxy-groups": [], rules: [] });
  await fs.writeFile(source, valid);
  await fs.writeFile(path.join(cache, "leapvpn.yaml"), "previous-validated-content");
  const exporter = path.join(root, "exporter.mjs");
  const worker = path.join(root, "worker.mjs");
  await fs.writeFile(worker, brokenRouting ? 'export function enhanceMihomoConfig(){throw new Error("Template unavailable");}' :
    `export function handleRequest(){throw new Error('FlyBird account API must not be called');}
     export function enhanceMihomoConfig(text, base){
       const nodes=text.split('\\n').filter(line=>line.trim().startsWith('- {')).map(line=>JSON.parse(line.trim().slice(2)));
       return JSON.stringify({proxies:nodes,'proxy-groups':[{name:'shared',type:'select',proxies:nodes.map(n=>n.name)}],
         rules:['GEOSITE,cn,DIRECT','MATCH,shared'],'geodata-mode':true,'geo-auto-update':true,'geo-update-interval':24,
         'geox-url':{geoip:base+'/rules/geoip.dat',geosite:base+'/rules/geosite.dat'}});
     }`);
  await fs.writeFile(exporter, busy ? 'process.exit(75);' : fail ?
    'process.stderr.write("private-session-token-must-not-be-logged"); process.exit(3);' :
    `import fs from 'node:fs/promises'; import path from 'node:path';
     const args=process.argv.slice(2); const out=args[args.indexOf('--out-dir')+1];
     const automatic=args.includes('--credentials');
     const input=args[args.indexOf(automatic?'--credentials':'--settings')+1];
     if (automatic ? !args.includes('--state') : !args.includes('--fetch-all')) process.exit(4);
     await fs.mkdir(out); await fs.copyFile(input,path.join(out,'leap_clash.yaml'));
     if(automatic) await fs.writeFile(path.join(out,'leap_meta.json'), JSON.stringify({authentication:{
       mode:'device_credentials',session_renewed:true,account_login:false,session_expires_at_ms:4102444800000,
       password:'private-account-password-must-not-be-logged'}}));`);
  const result = spawnSync(process.execPath, [refreshScript, "leapvpn"], {
    env: { ...process.env, SUBSCRIPTION_CACHE_DIR: cache,
      LEAPVPN_SESSION_FILE: source, LEAPVPN_PYTHON: process.execPath, LEAPVPN_EXPORT_SCRIPT: exporter,
      PUBLIC_DOMAIN: "sub.example.invalid", FLYBIRD_WORKER_MODULE: worker,
      LEAPVPN_CREDENTIAL_FILE: automaticLogin ? source : undefined,
      LEAPVPN_AUTH_STATE_FILE: automaticLogin ? path.join(root,'state.json') : undefined },
    encoding: "utf8", timeout: 10000,
  });
  return { root, cache, valid, result };
}

test("LeapVPN refresh validates the exported file and commits the last-good cache", async () => {
  const f = await runFixture(false);
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    const config = YAML.parse(await fs.readFile(path.join(f.cache, "leapvpn.yaml"), "utf8"));
    assert.deepEqual(config.proxies, JSON.parse(f.valid).proxies);
    assert.deepEqual(config.rules, ["GEOSITE,cn,DIRECT", "MATCH,shared"]);
    assert.equal(await fs.readFile(path.join(f.cache, "leapvpn.previous.yaml"), "utf8"), "previous-validated-content");
    const meta = JSON.parse(await fs.readFile(path.join(f.cache, "leapvpn.json")));
    assert.equal(meta.provider, "leapvpn");
    assert.equal(meta.proxyCount, 1);
    assert.equal(meta.routing.template, "flybird");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("failed LeapVPN refresh keeps the old file and does not log child secrets", async () => {
  const f = await runFixture(true);
  try {
    assert.equal(f.result.status, 1);
    assert.equal(await fs.readFile(path.join(f.cache, "leapvpn.yaml"), "utf8"), "previous-validated-content");
    const metadata = await fs.readFile(path.join(f.cache, "leapvpn.json"), "utf8");
    assert.ok(JSON.parse(metadata).lastError);
    assert.doesNotMatch(f.result.stderr + metadata, /private-session-token-must-not-be-logged/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("automatic login passes only private file paths and publishes sanitized authentication status", async () => {
  const f = await runFixture(false, true);
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    const text = await fs.readFile(path.join(f.cache, "leapvpn.json"), "utf8");
    const meta = JSON.parse(text);
    assert.deepEqual(meta.authentication, {mode:"device_credentials", sessionRenewed:true,
      accountLogin:false, sessionExpiresAtMs:4102444800000});
    assert.doesNotMatch(text + f.result.stdout + f.result.stderr, /private-account-password/);
  } finally { await fs.rm(f.root, {recursive:true, force:true}); }
});

test("failed automatic login preserves the previously published subscription", async () => {
  const f = await runFixture(true, true);
  try {
    assert.equal(f.result.status, 1);
    assert.equal(await fs.readFile(path.join(f.cache,"leapvpn.yaml"),"utf8"), "previous-validated-content");
    assert.doesNotMatch(f.result.stderr, /private-session-token/);
  } finally { await fs.rm(f.root, {recursive:true, force:true}); }
});

test("a concurrent automatic refresh skips without replacing cache or recording a failure", async () => {
  const f = await runFixture(false, true, true);
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(JSON.parse(f.result.stdout).skipped, true);
    assert.equal(await fs.readFile(path.join(f.cache,"leapvpn.yaml"),"utf8"), "previous-validated-content");
    await assert.rejects(fs.stat(path.join(f.cache,"leapvpn.json")), {code:"ENOENT"});
  } finally { await fs.rm(f.root, {recursive:true, force:true}); }
});

test("a routing failure retains the last-good subscription instead of publishing only nodes", async()=>{
  const f = await runFixture(false, true, false, true);
  try {
    assert.equal(f.result.status, 1);
    assert.equal(await fs.readFile(path.join(f.cache,"leapvpn.yaml"),"utf8"),"previous-validated-content");
    assert.ok(JSON.parse(await fs.readFile(path.join(f.cache,"leapvpn.json"),"utf8")).lastError);
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});
