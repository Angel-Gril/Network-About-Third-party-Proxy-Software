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
  const handler = createHandler({
    cacheDirectory: directory,
    getReadToken: async (provider = "flybird") => provider === "leapvpn" ? leapToken : readToken,
    getSubscriptionUrl: async (provider = "flybird") => `https://sub.example/s/${provider === "leapvpn" ? leapToken : readToken}/${provider}.yaml`,
    rotateSubscriptionUrl: async (provider = "flybird") => {
      if (provider === "leapvpn") {
        leapToken = "d".repeat(40);
        return `https://sub.example/s/${leapToken}/leapvpn.yaml`;
      }
      readToken = "b".repeat(40);
      return `https://sub.example/s/${readToken}/flybird.yaml`;
    },
    adminHtml: "<!doctype html><title>Admin</title>",
    triggerRefresh: async (provider) => {
      calls.push(provider);
      return { ok: true, started: true, provider };
    },
    loadRuleAsset: async (asset) => asset === "geoip.dat" ? Buffer.from("rules") : null,
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
    assert.deepEqual(Object.keys(status.providers), ["flybird", "leapvpn"]);
    assert.equal(status.providers.flybird.available, true);
    assert.equal(status.providers.flybird.proxyCount, 90);
    assert.equal(subscription.url, `https://sub.example/s/${"a".repeat(40)}/flybird.yaml`);
    assert.equal(refresh.status, 202);
    assert.deepEqual(app.calls, ["flybird"]);
  } finally {
    await app.close();
  }
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
