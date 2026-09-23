import assert from "node:assert/strict";
import test from "node:test";
import { convertShadowsocksNodes, fetchMonoCloudSubscription, loginMonoCloud, shadowsocksLink } from "../src/client.js";

const secretMarker = "private-secret-must-not-appear";
const tokenMarker = "private-token-must-not-appear";
const node = { alias: "Relay-HK1", emoji: "HK", group: "Asia", enable: 1,
  hostname: "edge.example.invalid", port: 443, encryption: "chacha20-ietf-poly1305", password: secretMarker };

function response(value, status = 200, headers = {}) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers });
}

test("account flow sends the desktop protocol headers and converts complete Shadowsocks fields", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    calls.push({ url: String(url), headers: init.headers, body });
    if (String(url).endsWith("/oauth/token")) return response({ access_token: tokenMarker });
    if (String(url).endsWith("/api/service")) return response([{ id: 7, expire_date: "2099-01-01", plan: { type: "shadowsocks" } }]);
    if (String(url).endsWith("/api/bandwidth/7")) return response({ upload: 10, download: 20, allowance: 100, reset_days: 4 });
    if (String(url).endsWith("/api/shadowsocks/7")) return response([node]);
    throw new Error("Unexpected request");
  };
  const result = await fetchMonoCloudSubscription({ email: "owner@example.invalid", password: secretMarker }, { fetchImpl });
  assert.equal(result.nodeCount, 1);
  assert.deepEqual(JSON.parse(result.yaml.split("  - ")[1]), {
    name: "HK Relay-HK1 Asia", type: "ss", server: node.hostname, port: 443,
    cipher: node.encryption, password: secretMarker, udp: true,
  });
  assert.match(result.links[0], /^ss:\/\//);
  assert.equal(calls[0].headers["User-Agent"], "MonocloudGO-1.0.1");
  assert.equal(calls[0].headers["X-Client-Version"], "1.0.1");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["client_id", "client_secret", "grant_type", "password", "username"]);
  assert.equal(calls[1].headers.Authorization, `Bearer ${tokenMarker}`);
  assert.deepEqual(result.account, { checkedPlanCount: 1, maximumUsagePercent: 30, minimumResetDays: 4 });
});

test("login tries the alternate official API but stops the batch on 429", async () => {
  const calls = [];
  const fallback = async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? response({ error: secretMarker }, 503) : response({ access_token: tokenMarker });
  };
  const result = await loginMonoCloud("owner@example.invalid", secretMarker, { fetchImpl: fallback });
  assert.equal(new URL(result.baseUrl).host, "ac.applecross.link");
  assert.equal(calls.length, 2);

  calls.length = 0;
  const limited = async (url) => { calls.push(String(url)); return response({ error: secretMarker }, 429, { "Retry-After": "60" }); };
  await assert.rejects(loginMonoCloud("owner@example.invalid", secretMarker, { fetchImpl: limited }),
    error => error.status === 429 && error.retryAfter === "60" && !error.message.includes(secretMarker));
  assert.equal(calls.length, 1);

  calls.length = 0;
  const rejected = async (url) => { calls.push(String(url)); return response({ error: secretMarker }, 400); };
  await assert.rejects(loginMonoCloud("owner@example.invalid", secretMarker, { fetchImpl: rejected }),
    error => error.status === 400 && !error.message.includes(secretMarker));
  assert.equal(calls.length, 1);
});

test("unsupported plans and malformed nodes fail without exposing upstream values", async () => {
  const base = async (url) => {
    if (String(url).endsWith("/oauth/token")) return response({ access_token: tokenMarker });
    return response([{ id: 7, plan: { type: "vpn" } }]);
  };
  await assert.rejects(fetchMonoCloudSubscription({email:"owner@example.invalid",password:secretMarker},{fetchImpl:base}),
    error => /Unsupported MonoCloud plan type/.test(error.message) && !error.message.includes(secretMarker));
  assert.throws(() => convertShadowsocksNodes([{ ...node, password: "" }]), /incomplete connection fields/);
});

test("expired or exhausted plans stop before stale node credentials are exported", async () => {
  for (const mode of ["expired", "exhausted"]) {
    const calls = [];
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname.endsWith("/oauth/token")) return response({ access_token: tokenMarker });
      if (pathname.endsWith("/api/service")) return response([{
        id: 7, expire_date: mode === "expired" ? "2020-01-01" : "2099-01-01",
        plan: { type: "shadowsocks" },
      }]);
      if (pathname.endsWith("/api/bandwidth/7")) {
        return response({ upload: 60, download: 50, allowance: 100, reset_days: 4 });
      }
      if (pathname.endsWith("/api/shadowsocks/7")) return response([node]);
      throw new Error("Unexpected request");
    };
    await assert.rejects(fetchMonoCloudSubscription(
      { email: "owner@example.invalid", password: secretMarker }, { fetchImpl, nowMs: Date.parse("2026-01-01") }),
    error => new RegExp(mode === "expired" ? "expired" : "allowance").test(error.message));
    assert.equal(calls.includes("/api/shadowsocks/7"), false);
  }
});

test("SS links retain cipher, password and display name", () => {
  const converted = convertShadowsocksNodes([node])[0];
  const decoded = Buffer.from(shadowsocksLink(converted).slice(5).split("@")[0], "base64").toString("utf8");
  assert.equal(decoded, `${node.encryption}:${secretMarker}`);
  assert.match(shadowsocksLink(converted), /#HK%20Relay-HK1%20Asia$/);
});
