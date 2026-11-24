// Independent APXS v2 oracle and current Web Crypto implementation verifier.
// Run from this package with: node tests/verify-apxs-fixtures.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import reference from "./apxs-v2.reference.mjs";
import {
  decryptApxsV2Detailed,
  verifyApxsV2Signature,
} from "../src/apxs-v2.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixtures", "apxs");
const index = JSON.parse(await readFile(path.join(fixtureRoot, "index.json"), "utf8"));

async function loadCase(entry) {
  assert.equal(typeof entry.case, "string", "fixture case must be a string");
  assert.match(entry.case, /^[A-Za-z0-9_.-]+$/, "fixture case contains an unsafe path");
  const directory = path.join(fixtureRoot, entry.case);
  return {
    body: await readFile(path.join(directory, "body.bin")),
    credential: JSON.parse(await readFile(path.join(directory, "credential.json"), "utf8")),
    headers: JSON.parse(await readFile(path.join(directory, "headers.json"), "utf8")),
    expected: await readFile(path.join(directory, "expected.yaml")),
    meta: JSON.parse(await readFile(path.join(directory, "meta.json"), "utf8")),
  };
}

async function currentFixture({ body, credential, headers }) {
  const result = await decryptApxsV2Detailed(body, credential);
  const signature = headers["apex-sub-sign-v2"]
    || headers["apex-signature"]
    || headers["x-apex-signature"]
    || "";
  const signKey = credential.sign_key || credential.signKey || "";
  const signatureOk = signature && signKey
    ? await verifyApxsV2Signature(body, signature, signKey, result.bytes)
    : null;
  return {
    plaintext: Buffer.from(result.bytes),
    layout: result.layout,
    keyDerivation: result.key,
    signatureOk,
  };
}

async function assertImplementation(name, implementation, fixture) {
  if (fixture.meta.expect === "fail") {
    let failed = false;
    try {
      await implementation(fixture);
    } catch (error) {
      assert.match(
        String(error?.message || error),
        /(APXS|decrypt|auth|signature|key)/i,
        `${name} failure must describe a crypto/authentication error`,
      );
      failed = true;
    }
    assert.equal(failed, true, `${name} must reject ${fixture.meta.negative_kind}`);
    return;
  }

  const result = await implementation(fixture);
  assert.ok(result?.plaintext instanceof Uint8Array, `${name} must return plaintext bytes`);
  assert.deepEqual(Buffer.from(result.plaintext), fixture.expected, `${name} plaintext`);
  if (fixture.meta.signature) assert.equal(result.signatureOk, true, `${name} signature`);
}

let passed = 0;
for (const entry of index) {
  const fixture = await loadCase(entry);
  // The independent oracle proves the fixture is internally coherent first.
  await assertImplementation("reference", reference.decryptFixture, fixture);
  await assertImplementation("webcrypto", currentFixture, fixture);
  console.log(`[PASS] ${entry.case}`);
  passed += 1;
}

console.log(`RESULT: ${passed} passed, 0 failed`);
