import assert from "node:assert/strict";
import test from "node:test";
import {
  ApexV2Error,
  buildApexV2DownloadUrls,
  getApexV2AccessCredential,
  loginApexV2,
  normalizeApexV2AccessCredential,
  normalizeApexV2Login,
  downloadApexV2Subscription,
} from "../src/apex-v2.js";

test("Apex v2 normalizers preserve the session and access-key distinction", () => {
  assert.deepEqual(normalizeApexV2Login({ data: { token: "session", auth_data: "auth" } }), {
    token: "session", authData: "auth",
  });
  assert.deepEqual(normalizeApexV2AccessCredential({ data: {
    access_key: "access", encrypt_key: "enc", sign_key: "sig", expires_at: "later",
    subscribe_url: "https://sub.example.invalid/v2/feed/download?access_key=access",
  } }), {
    accessKey: "access", encryptKey: "enc", signKey: "sig", keyId: "", expiresAt: "later",
    subscribeUrl: "https://sub.example.invalid/v2/feed/download?access_key=access",
  });
});

test("Apex v2 login and access-token calls use the mapped endpoints", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v2/auth/token")) {
      return Response.json({ data: { token: "session", auth_data: "auth" } });
    }
    return Response.json({ data: { access_key: "access", encrypt_key: "enc", sign_key: "sig" } });
  };
  const login = await loginApexV2({
    apiDomains: ["https://api.example.invalid"], email: "user@example.invalid", password: "secret", fetchImpl,
  });
  const access = await getApexV2AccessCredential({
    apiDomains: ["https://api.example.invalid"], authData: login.authData, fetchImpl,
  });
  assert.equal(login.authData, "auth");
  assert.equal(access.accessKey, "access");
  assert.equal(calls[0].url, "https://api.example.invalid/v2/auth/token");
  assert.equal(calls[1].url, "https://api.example.invalid/v2/feed/access-token");
  assert.equal(calls[1].init.headers.Authorization, "auth");
});

test("current access-token responses expose the subscription key as token and retain the exact authorization", async () => {
  const credential = await getApexV2AccessCredential({ apiDomains: ["https://api.example.invalid"],
    authData: "synthetic.raw.jwt", fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, "synthetic.raw.jwt");
      return Response.json({ data: { token: "subscription-key", expired_at: 1800000000 } });
    } });
  assert.equal(credential.accessKey, "subscription-key");
  assert.equal(normalizeApexV2AccessCredential({ data: { access_key: "explicit", token: "fallback" } }).accessKey, "explicit");
  await getApexV2AccessCredential({ apiDomains: ["https://api.example.invalid"], authData: "Bearer supplied-token",
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer supplied-token");
      return Response.json({ data: { token: "subscription-key" } });
    } });
});

test("login and access-token stop the batch when the upstream rate limits a request", async () => {
  for (const operation of [loginApexV2, getApexV2AccessCredential]) {
    let calls = 0;
    await assert.rejects(operation({ apiDomains: ["https://one.example.invalid", "https://two.example.invalid"],
      email: "user@example.invalid", password: "synthetic-password", authData: "synthetic-jwt",
      fetchImpl: async () => { calls++; return new Response("limited", { status: 429 }); },
    }), error => error instanceof ApexV2Error && error.status === 429);
    assert.equal(calls, 1);
  }
});

test("Apex v2 download URLs are built from access_key and current subscribe domains", () => {
  assert.deepEqual(buildApexV2DownloadUrls("a/b", ["https://sub.example.invalid"]), [
    "https://sub.example.invalid/v2/feed/download?access_key=a%2Fb",
  ]);
  assert.throws(() => normalizeApexV2AccessCredential({ data: {} }), ApexV2Error);
});

test("Apex v2 honors an explicit subscribe_url before fallback domains", () => {
  assert.deepEqual(buildApexV2DownloadUrls(
    "a/b",
    ["https://fallback.example.invalid"],
    "https://direct.example.invalid/feed?x=1",
  ), [
    "https://direct.example.invalid/feed?x=1&access_key=a%2Fb",
    "https://fallback.example.invalid/v2/feed/download?access_key=a%2Fb",
  ]);
});

test("Apex v2 download falls back across subscription domains and returns raw bytes", async () => {
  const calls = [];
  const result = await downloadApexV2Subscription({
    accessKey: "access",
    subscribeDomains: ["https://first.example.invalid", "https://second.example.invalid"],
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response("gone", { status: 404 });
      return new Response(new Uint8Array([0x41, 0x50, 0x58, 0x53]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.status, 200);
  assert.deepEqual([...result.body], [0x41, 0x50, 0x58, 0x53]);
});

