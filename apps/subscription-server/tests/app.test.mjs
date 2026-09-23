import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandler } from "../src/app.mjs";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-sub-test-"));
  const calls = [];
  let readToken = "a".repeat(40);
  let leapToken = "c".repeat(40);
  let monoToken = "e".repeat(40);
  const extension = { clash:"yaml", uri:"txt", v2rayn:"b64" };
  const refreshSettings = { schemaVersion:1, providers:Object.fromEntries(
    ["flybird","leapvpn","monocloud"].map(provider => [provider,{enabled:true,intervalMinutes:360}])) };
  const handler = createHandler({
    cacheDirectory: directory,
    getReadToken: async (provider = "flybird") => provider === "leapvpn" ? leapToken : provider === "monocloud" ? monoToken : readToken,
    getSubscriptionUrl: async (provider = "flybird", format = "clash") => `https://sub.example/s/${provider === "leapvpn" ? leapToken : provider === "monocloud" ? monoToken : readToken}/${provider}.${extension[format]}`,
    rotateSubscriptionUrl: async (provider = "flybird", format = "clash") => {
      if (provider === "leapvpn") {
        leapToken = "d".repeat(40);
        return `https://sub.example/s/${leapToken}/leapvpn.${extension[format]}`;
      }
      if (provider === "monocloud") {
        monoToken = "f".repeat(40);
        return `https://sub.example/s/${monoToken}/monocloud.${extension[format]}`;
      }
      readToken = "b".repeat(40);
      return `https://sub.example/s/${readToken}/flybird.${extension[format]}`;
    },
    adminHtml: "<!doctype html><title>Admin</title>",
    triggerRefresh: async (provider) => {
      calls.push(provider);
      return { ok: true, started: true, provider };
    },
    loadRuleAsset: async (asset) => asset === "geoip.dat" ? Buffer.from("rules") : null,
    getRefreshSettings: async () => structuredClone(refreshSettings),
    updateRefreshSettings: async (provider, value) => {
      if (typeof value.enabled !== "boolean" || !Number.isInteger(value.intervalMinutes) ||
          value.intervalMinutes < 5 || value.intervalMinutes > 43_200) throw new Error("invalid settings");
      refreshSettings.providers[provider] = value;
      return value;
    },
  });
  const server = http.createServer((request, response) => handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    directory,
    calls,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test("serves only token-protected last-good subscriptions", async () => {
  const app = await fixture();
  try {
    await fs.writeFile(path.join(app.directory, "flybird.yaml"), "proxies:\n  - name: one\n", "utf8");
    const denied = await fetch(`${app.url}/s/wrong/flybird.yaml`);
    const allowed = await fetch(`${app.url}/s/${"a".repeat(40)}/flybird.yaml`);
    const download = await fetch(`${app.url}/admin/download/flybird.yaml`);
    assert.equal(denied.status, 404);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("content-type"), "text/yaml; charset=utf-8");
    assert.match(await allowed.text(), /name: one/);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-disposition"), "attachment; filename=flybird.yaml");
    assert.match(await download.text(), /name: one/);

    const rejectedReset = await fetch(`${app.url}/admin/api/reset-subscription-url`, { method: "POST" });
    assert.equal(rejectedReset.status, 403);
    const reset = await fetch(`${app.url}/admin/api/reset-subscription-url`, {
      method: "POST",
      headers: { "X-Admin-Action": "private-subscription-admin" },
    });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).url, `https://sub.example/s/${"b".repeat(40)}/flybird.yaml`);
    assert.equal((await fetch(`${app.url}/s/${"a".repeat(40)}/flybird.yaml`)).status, 404);
    assert.equal((await fetch(`${app.url}/s/${"b".repeat(40)}/flybird.yaml`)).status, 200);
  } finally {
    await app.close();
  }
});

test("returns 503 without a valid cached subscription", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.url}/s/${"a".repeat(40)}/flybird.yaml`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /No valid configuration/);
  } finally {
    await app.close();
  }
});

test("reports provider status and starts refresh jobs", async () => {
  const app = await fixture();
  try {
    await fs.writeFile(path.join(app.directory, "flybird.yaml"), "proxies: []\n", "utf8");
    await fs.writeFile(path.join(app.directory, "flybird.json"), JSON.stringify({ updatedAt: "2026-07-30", proxyCount: 90 }), "utf8");
    const status = await fetch(`${app.url}/admin/api/status`).then((response) => response.json());
    const subscription = await fetch(`${app.url}/admin/api/subscription-url`).then((response) => response.json());
    const refresh = await fetch(`${app.url}/admin/api/refresh/flybird`, {
      method: "POST",
      headers: { "X-Admin-Action": "private-subscription-admin" },
    });
    assert.deepEqual(Object.keys(status.providers), ["flybird", "leapvpn", "monocloud"]);
    assert.equal(status.providers.flybird.available, true);
    assert.equal(status.providers.flybird.proxyCount, 90);
    assert.equal(status.providers.flybird.refresh.intervalMinutes, 360);
    assert.equal(subscription.url, `https://sub.example/s/${"a".repeat(40)}/flybird.yaml`);
    assert.equal(refresh.status, 202);
    assert.deepEqual(app.calls, ["flybird"]);
  } finally {
    await app.close();
  }
});

test("serves URI and v2rayN formats under the same provider token", async () => {
  const app = await fixture();
  try {
    const config = { proxies:[
      {name:"SS sample",type:"ss",server:"edge.example.invalid",port:443,cipher:"chacha20-ietf-poly1305",password:"synthetic-secret"},
      {name:"VLESS sample",type:"vless",server:"vless.example.invalid",port:8443,uuid:"11111111-1111-4111-8111-111111111111",network:"ws",tls:true,"skip-cert-verify":true,"ws-opts":{path:"/sample",headers:{Host:"host.example.invalid"}}},
    ], "proxy-groups":[], rules:[] };
    await fs.writeFile(path.join(app.directory,"flybird.yaml"), JSON.stringify(config));
    const token = "a".repeat(40);
    const plain = await fetch(`${app.url}/s/${token}/flybird.txt`);
    const encoded = await fetch(`${app.url}/s/${token}/flybird.b64`);
    assert.equal(plain.status, 200);
    assert.equal(encoded.status, 200);
    const links = await plain.text();
    assert.match(links, /^ss:\/\//m);
    assert.match(links, /^vless:\/\//m);
    assert.equal(Buffer.from(await encoded.text(), "base64").toString("utf8"), links);
    assert.equal((await fetch(`${app.url}/s/wrong/flybird.b64`)).status, 404);
    const link = await fetch(`${app.url}/admin/api/subscription-url?provider=flybird&format=v2rayn`).then(r=>r.json());
    assert.equal(link.url, `https://sub.example/s/${token}/flybird.b64`);
    assert.equal((await fetch(`${app.url}/admin/download/flybird.txt`)).status, 200);
    assert.equal((await fetch(`${app.url}/admin/api/subscription-url?format=unknown`)).status, 400);
  } finally { await app.close(); }
});

test("updates provider refresh settings with an explicit admin action", async () => {
  const app = await fixture();
  try {
    const denied = await fetch(`${app.url}/admin/api/refresh-settings/monocloud`, {
      method:"PUT", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({enabled:false,intervalMinutes:720}),
    });
    assert.equal(denied.status, 403);
    const saved = await fetch(`${app.url}/admin/api/refresh-settings/monocloud`, {
      method:"PUT", headers:{"Content-Type":"application/json","X-Admin-Action":"private-subscription-admin"},
      body:JSON.stringify({enabled:false,intervalMinutes:720}),
    });
    assert.equal(saved.status, 200);
    const status = await fetch(`${app.url}/admin/api/status`).then(response=>response.json());
    assert.equal(status.providers.monocloud.refresh.enabled, false);
    assert.equal(status.providers.monocloud.refresh.intervalMinutes, 720);
    const invalid = await fetch(`${app.url}/admin/api/refresh-settings/monocloud`, {
      method:"PUT", headers:{"Content-Type":"application/json","X-Admin-Action":"private-subscription-admin"},
      body:JSON.stringify({enabled:true,intervalMinutes:1}),
    });
    assert.equal(invalid.status, 400);
  } finally { await app.close(); }
});

test("serves LeapVPN under its own token and preserves the FlyBird token", async () => {
  const app = await fixture();
  try {
    await fs.writeFile(path.join(app.directory, "flybird.yaml"), "proxies: []\n");
    await fs.writeFile(path.join(app.directory, "leapvpn.yaml"), "proxies:\n  - name: leap\n");
    assert.equal((await fetch(`${app.url}/s/${"a".repeat(40)}/leapvpn.yaml`)).status, 404);
    assert.equal((await fetch(`${app.url}/s/${"c".repeat(40)}/leapvpn.yaml`)).status, 200);
    assert.equal((await fetch(`${app.url}/admin/download/leapvpn.yaml`)).status, 200);
    const link = await fetch(`${app.url}/admin/api/subscription-url?provider=leapvpn`).then(r => r.json());
    assert.equal(link.url, `https://sub.example/s/${"c".repeat(40)}/leapvpn.yaml`);
    const reset = await fetch(`${app.url}/admin/api/reset-subscription-url?provider=leapvpn`, {
      method: "POST", headers: { "X-Admin-Action": "private-subscription-admin" },
    }).then(r => r.json());
    assert.equal(reset.url, `https://sub.example/s/${"d".repeat(40)}/leapvpn.yaml`);
    assert.equal((await fetch(`${app.url}/s/${"c".repeat(40)}/leapvpn.yaml`)).status, 404);
    assert.equal((await fetch(`${app.url}/s/${"a".repeat(40)}/flybird.yaml`)).status, 200);
    const refresh = await fetch(`${app.url}/admin/api/refresh/leapvpn`, {
      method: "POST", headers: { "X-Admin-Action": "private-subscription-admin" },
    });
    assert.equal(refresh.status, 202);
    assert.deepEqual(app.calls, ["leapvpn"]);
    assert.equal((await fetch(`${app.url}/admin/api/subscription-url?provider=unknown`)).status, 400);
    assert.equal((await fetch(`${app.url}/admin/api/refresh/unknown`, {
      method: "POST", headers: { "X-Admin-Action": "private-subscription-admin" },
    })).status, 404);
  } finally { await app.close(); }
});

test("serves MonoCloud under its own token and preserves the existing provider tokens", async () => {
  const app = await fixture();
  try {
    await fs.writeFile(path.join(app.directory, "flybird.yaml"), "proxies:\n  - name: fly\n");
    await fs.writeFile(path.join(app.directory, "monocloud.yaml"), "proxies:\n  - name: mono\n");
    assert.equal((await fetch(`${app.url}/s/${"a".repeat(40)}/monocloud.yaml`)).status, 404);
    assert.equal((await fetch(`${app.url}/s/${"e".repeat(40)}/monocloud.yaml`)).status, 200);
    assert.equal((await fetch(`${app.url}/s/${"e".repeat(40)}/flybird.yaml`)).status, 404);
    const link = await fetch(`${app.url}/admin/api/subscription-url?provider=monocloud`).then(r => r.json());
    assert.equal(link.url, `https://sub.example/s/${"e".repeat(40)}/monocloud.yaml`);
    const reset = await fetch(`${app.url}/admin/api/reset-subscription-url?provider=monocloud`, {
      method:"POST", headers:{"X-Admin-Action":"private-subscription-admin"},
    }).then(r => r.json());
    assert.equal(reset.url, `https://sub.example/s/${"f".repeat(40)}/monocloud.yaml`);
    assert.equal((await fetch(`${app.url}/s/${"e".repeat(40)}/monocloud.yaml`)).status, 404);
    assert.equal((await fetch(`${app.url}/s/${"a".repeat(40)}/flybird.yaml`)).status, 200);
    const refresh = await fetch(`${app.url}/admin/api/refresh/monocloud`, {
      method:"POST", headers:{"X-Admin-Action":"private-subscription-admin"},
    });
    assert.equal(refresh.status, 202);
    assert.deepEqual(app.calls, ["monocloud"]);
  } finally { await app.close(); }
});

test("serves only allow-listed rule assets", async () => {
  const app = await fixture();
  try {
    const allowed = await fetch(`${app.url}/rules/geoip.dat`);
    const denied = await fetch(`${app.url}/rules/private.bin`);
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), "rules");
    assert.equal(denied.status, 404);
  } finally {
    await app.close();
  }
});
