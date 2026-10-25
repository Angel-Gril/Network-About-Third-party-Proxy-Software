import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { decryptApexUrlV2, decodeClientStateBundle } from "../src/client-state.js";

const profileKey = Buffer.from("0123456789abcdef").toString("base64");

function encryptApexUrl(plaintext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-128-gcm", Buffer.from("0123456789abcdef"), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = Buffer.concat([
    Buffer.from("APEX\x02", "binary"),
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]);
  return `apex-url-v2:${envelope.toString("base64")}`;
}

test("decryptApexUrlV2 decodes the current APEX 02 AES-GCM envelope", async () => {
  const url = "https://sub.example.invalid/api/v1/client/subscribe?token=synthetic";
  assert.equal(await decryptApexUrlV2(encryptApexUrl(url), profileKey), url);
});

test("decryptApexUrlV2 rejects tampered and unsupported envelopes", async () => {
  const encrypted = encryptApexUrl("https://sub.example.invalid/api/v1/client/subscribe?token=x");
  const bytes = Buffer.from(encrypted.slice("apex-url-v2:".length), "base64");
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(
    decryptApexUrlV2(`apex-url-v2:${bytes.toString("base64")}`, profileKey),
  );
  await assert.rejects(decryptApexUrlV2("legacy:value", profileKey), /unsupported/);
});

test("decodeClientStateBundle normalizes encrypted URL and token fields", async () => {
  const url = "https://sub.example.invalid/api/v1/client/subscribe?token=synthetic";
  const normalized = await decodeClientStateBundle({
    format: "flybird-client-state/v1",
    clientVersion: "7.2.3",
    apexProfileFileKeyV3: profileKey,
    subscriptionUrl: encryptApexUrl(url),
    subscriptionToken: encryptApexUrl("synthetic"),
    xboardToken: "jwt-synthetic",
    apexV2ApiDomains: ["https://api.example.invalid"],
    apexV2SubscribeDomains: ["https://sub.example.invalid"],
  });
  assert.equal(normalized.clientVersion, "7.2.3");
  assert.equal(normalized.subscriptionUrl, url);
  assert.equal(normalized.subscriptionToken, "synthetic");
  assert.equal(normalized.xboardToken, "jwt-synthetic");
  assert.deepEqual(normalized.apexV2SubscribeDomains, ["https://sub.example.invalid"]);
});

