import assert from "node:assert/strict";
import test from "node:test";
import {
  ApexV2Error,
  buildApexV2DownloadUrls,
  getApexV2AccessCredential,
  loginApexV2,
  normalizeApexV2AccessCredential,
  normalizeApexV2Login,
} from "../src/apex-v2.js";

test("Apex v2 normalizers preserve the session and access-key distinction", () => {
  assert.deepEqual(normalizeApexV2Login({ data: { token: "session", auth_data: "auth" } }), {
    token: "session", authData: "auth",
  });
  assert.deepEqual(normalizeApexV2AccessCredential({ data: {
    access_key: "access", encrypt_key: "enc", sign_key: "sig", expires_at: "later",
  } }), {
    accessKey: "access", encryptKey: "enc", signKey: "sig", keyId: "", expiresAt: "later",
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
  assert.equal(calls[1].init.headers.Authorization, "Bearer auth");
});

test("Apex v2 download URLs are built from access_key and current subscribe domains", () => {
  assert.deepEqual(buildApexV2DownloadUrls("a/b", ["https://sub.example.invalid"]), [
    "https://sub.example.invalid/v2/feed/download?access_key=a%2Fb",
  ]);
  assert.throws(() => normalizeApexV2AccessCredential({ data: {} }), ApexV2Error);
});

