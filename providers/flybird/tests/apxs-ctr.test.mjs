import assert from "node:assert/strict";
import test from "node:test";
import { buildApxsCtrEnvelope, decryptApxsCtrDetailed } from "../src/apxs-ctr.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("decrypts APXS v2 AES-CTR envelope with GCM-style counter", async () => {
  const plaintext = new TextEncoder().encode([
    "mixed-port: 7890",
    "proxies:",
    "  - name: synthetic",
    "    type: vless",
    "    server: example.invalid",
    "    port: 443",
    "",
  ].join("\n"));
  const envelope = await buildApxsCtrEnvelope(plaintext, KEY, new Uint8Array(12).fill(7));
  const result = await decryptApxsCtrDetailed(envelope, KEY);
  assert.deepEqual(result.bytes, plaintext);
  assert.equal(result.aesId, 1);
  assert.equal(result.signId, 1);
  assert.equal(result.signatureVerified, null);
});

test("does not silently accept a wrong APXS AES-CTR key", async () => {
  const envelope = await buildApxsCtrEnvelope(
    new TextEncoder().encode("proxies:\n  - name: synthetic\n"),
    KEY,
    new Uint8Array(12).fill(9),
  );
  const result = await decryptApxsCtrDetailed(
    envelope, "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  );
  assert.notDeepEqual(result.bytes, new TextEncoder().encode("proxies:\n  - name: synthetic\n"));
});

test("rejects malformed APXS envelopes", async () => {
  await assert.rejects(
    decryptApxsCtrDetailed(new Uint8Array(120), KEY),
    /invalid APXS v2 CTR envelope/,
  );
});
