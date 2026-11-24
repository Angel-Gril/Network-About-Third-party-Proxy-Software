import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeHttpContent,
  decryptApxsV2,
  decryptApxsV2Detailed,
  verifyApxsV2Signature,
  verifyApxsV2SignatureDetailed,
} from "../src/apxs-v2.js";

const enc = new TextEncoder();

async function encryptPayload(payload, keyText, layout) {
  const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(keyText)));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    payload,
  ));
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);
  if (layout === "nonce-ct-tag") return new Uint8Array([...nonce, ...ciphertext, ...tag]);
  if (layout === "tag-nonce-ct") return new Uint8Array([...tag, ...nonce, ...ciphertext]);
  if (layout === "nonce-tag-ct") return new Uint8Array([...nonce, ...tag, ...ciphertext]);
  throw new Error(`unknown layout ${layout}`);
}

async function encryptYaml(yaml, keyText, layout) {
  return encryptPayload(enc.encode(yaml), keyText, layout);
}

async function encryptWithDerivedBytes(yaml, layout, decodedKey) {
  const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", decodedKey));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, key, enc.encode(yaml),
  ));
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);
  if (layout === "nonce-ct-tag") return new Uint8Array([...nonce, ...ciphertext, ...tag]);
  if (layout === "tag-nonce-ct") return new Uint8Array([...tag, ...nonce, ...ciphertext]);
  if (layout === "nonce-tag-ct") return new Uint8Array([...nonce, ...tag, ...ciphertext]);
  throw new Error(`unknown layout ${layout}`);
}

async function hmacHex(value, keyText) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

for (const [layout, expectedLayout] of [
  ["nonce-ct-tag", "nonce12+ct+tag16"],
  ["tag-nonce-ct", "tag16+nonce12+ct"],
  ["nonce-tag-ct", "nonce12+tag16+ct"],
]) {
  test(`APXS v2 decrypts ${layout} in binary and Base64 forms`, async () => {
    const yaml = "proxies:\n  - {name: demo, type: vless, server: edge.example, port: 443}\n";
    const keyText = "0123456789abcdef0123456789abcdef";
    const raw = await encryptYaml(yaml, keyText, layout);

    const binary = await decryptApxsV2Detailed(raw, { encryptKey: keyText });
    assert.equal(binary.yaml, yaml);
    assert.equal(binary.layout, expectedLayout);

    const base64 = btoa(String.fromCharCode(...raw));
    assert.equal(await decryptApxsV2(base64, { encrypt_key: keyText }), yaml);

    const hex = [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    assert.equal(await decryptApxsV2(hex, { encrypt_key: keyText }), yaml);
  });
}

test("APXS v2 verifies ciphertext and plaintext HMAC signatures", async () => {
  const yaml = "proxies:\n  - {name: demo, type: ss, server: edge.example, port: 443}\n";
  const keyText = "0123456789abcdef0123456789abcdef";
  const signKey = "signing-key-for-tests";
  const raw = await encryptYaml(yaml, keyText, "nonce-ct-tag");
  const signature = await hmacHex(raw, signKey);
  assert.equal(await verifyApxsV2Signature(raw, signature, signKey, yaml), true);
  assert.deepEqual(await verifyApxsV2SignatureDetailed(raw, signature, signKey, yaml), {
    ok: true, scope: "ciphertext", encoding: "hex",
  });
  assert.equal(await verifyApxsV2Signature(raw, signature, "wrong-key", yaml), false);
  assert.equal(await verifyApxsV2Signature(raw, "", signKey, yaml), null);
});

test("APXS v2 handles sha256= signatures and JSON envelopes", async () => {
  const yaml = "proxies:\n  - {name: json, type: vless, server: edge.example, port: 443}\n";
  const keyText = "0123456789abcdef0123456789abcdef";
  const raw = await encryptYaml(yaml, keyText, "nonce-ct-tag");
  const nonce = raw.slice(0, 12);
  const ciphertext = raw.slice(12, -16);
  const tag = raw.slice(-16);
  const json = JSON.stringify({
    data: btoa(String.fromCharCode(...ciphertext)),
    nonce: btoa(String.fromCharCode(...nonce)),
    tag: btoa(String.fromCharCode(...tag)),
  });
  const signKey = "json-sign-key";
  const signature = await hmacHex(enc.encode(json), signKey);
  assert.equal(await decryptApxsV2(json, { encryptKey: keyText }), yaml);
  assert.equal(await verifyApxsV2Signature(
    enc.encode(json), `sha256=${signature}`, signKey, enc.encode(yaml),
  ), true);
});

test("APXS v2 decompresses gzip plaintext", async () => {
  const yaml = "proxies:\n  - {name: gzip, type: ss, server: edge.example, port: 443}\n";
  const compressed = new Uint8Array(await new Response(
    new Blob([enc.encode(yaml)]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer());
  const raw = await encryptPayload(compressed, "0123456789abcdef0123456789abcdef", "nonce-ct-tag");
  assert.equal(await decryptApxsV2(raw, { encryptKey: "0123456789abcdef0123456789abcdef" }), yaml);
});

test("APXS v2 decodes an HTTP gzip wire body before envelope parsing", async () => {
  const raw = await encryptYaml(
    "proxies:\n  - {name: http-gzip, type: ss, server: edge.example, port: 443}\n",
    "0123456789abcdef0123456789abcdef",
    "nonce-ct-tag",
  );
  const wire = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer());
  const decoded = await decodeHttpContent(wire, "gzip");
  assert.equal(decoded.compressed, true);
  assert.deepEqual([...decoded.bytes], [...raw]);
});

test("APXS v2 unwraps the observed APXS 02 flag envelope", async () => {
  const keyText = "0123456789abcdef0123456789abcdef";
  const yaml = "proxies:\n  - {name: apxs02, type: vless, server: edge.example, port: 443}\n";
  const raw = await encryptYaml(yaml, keyText, "nonce-ct-tag");
  const nonce = raw.slice(0, 12);
  const ciphertext = raw.slice(12, -16);
  const tag = raw.slice(-16);
  const envelope = new Uint8Array([
    0x41, 0x50, 0x58, 0x53, 0x02,
    0, 0, 0, 1,
    0, 0, 0, 1,
    ...nonce, ...ciphertext, ...tag,
  ]);
  const detailed = await decryptApxsV2Detailed(envelope, { encryptKey: keyText });
  assert.equal(detailed.yaml, yaml);
  assert.equal(detailed.layout, "APXS02+flags+nonce12+ct+tag16");
});

test("APXS v2 tries hashes of decoded Base64 and hex keys", async () => {
  const yaml = "proxies:\n  - {name: derived, type: ss, server: edge.example, port: 443}\n";
  const decoded = enc.encode("0123456789abcdef0123456789abcdef");
  const base64Key = btoa(String.fromCharCode(...decoded));
  const hexKey = [...decoded].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const base64Body = await encryptWithDerivedBytes(yaml, "nonce-ct-tag", decoded);
  const hexBody = await encryptWithDerivedBytes(yaml, "nonce-ct-tag", decoded);
  assert.equal(await decryptApxsV2(base64Body, { encrypt_key: base64Key }), yaml);
  assert.equal(await decryptApxsV2(hexBody, { encrypt_key: hexKey }), yaml);
});
