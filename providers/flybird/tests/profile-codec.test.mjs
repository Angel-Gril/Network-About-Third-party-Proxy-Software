import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import test from "node:test";
import { decryptProfile, handleRequest } from "../src/subscription.js";

// Protocol constant from the 3.1.8 client, never an account credential.
const secret = "fd53c838dbceff962d5d2aed5cdc548e";
const decode = (value) => decryptProfile(value, "14f521a32997b257", "d217125f4b9cc9c8");
const yaml = 'proxies:\n  - {"name":"合成节点","type":"vless","server":"edge.example","port":443,"uuid":"11111111-1111-4111-8111-111111111111","tls":true,"servername":"tls.example","flow":"xtls-rprx-vision","network":"tcp","skip-cert-verify":false}\n';

function currentEnvelope(plaintext) {
  const nonce = Buffer.from("000102030405060708090a0b", "hex");
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), nonce);
  return Buffer.concat([nonce, cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
}

test("current subscription authenticates the nonce, ciphertext and tag and preserves UTF-8 YAML", async () => {
  assert.equal(await decode(currentEnvelope(yaml).toString("base64")), yaml);
});

test("legacy CBC subscriptions remain readable with and without the inner Base64 layer", async () => {
  for (const inner of [yaml, Buffer.from(yaml).toString("base64")]) {
    const cipher = createCipheriv("aes-128-cbc", Buffer.from("14f521a32997b257"), Buffer.from("d217125f4b9cc9c8"));
    const encoded = Buffer.concat([cipher.update(inner, "utf8"), cipher.final()]).toString("base64");
    assert.equal((await decryptProfile(encoded, "14f521a32997b257", "d217125f4b9cc9c8")).trim(), yaml.trim());
  }
});

test("tampered or truncated GCM envelopes fail without returning unauthenticated plaintext", async () => {
  const original = currentEnvelope(yaml);
  for (const offset of [0, 12, original.length - 1]) {
    const broken = Buffer.from(original);
    broken[offset] ^= 1;
    await assert.rejects(decode(broken.toString("base64")), /subscription.*(?:authenticate|decode)/i);
  }
  await assert.rejects(decode(original.subarray(0, 27).toString("base64")), /subscription.*(?:authenticate|decode)/i);
});

test("token subscription uses the current native User-Agent and decodes the GCM response", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    const accepted = init.headers["User-Agent"] === "securitynet/v3.1.8 clash-verge Platform/windows";
    return new Response(accepted ? currentEnvelope(yaml).toString("base64") : "invalid token\n", { status: accepted ? 200 : 401 });
  };
  try {
    const response = await handleRequest(new Request("https://worker.example/sub?key=example&token=synthetic-token"), { ACCESS_KEY: "example" });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /合成节点/);
    assert.match(body, /xtls-rprx-vision/);
    assert.match(body, /"skip-cert-verify":false/);
    assert.equal(urls.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
