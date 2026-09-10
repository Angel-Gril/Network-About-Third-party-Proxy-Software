import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuleLoader } from "../src/rules.mjs";

test("downloads allow-listed assets once and reuses the cache", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rules-test-"));
  let calls = 0;
  const loader = createRuleLoader({
    cacheDirectory: directory,
    fetchImpl: async () => {
      calls += 1;
      return new Response(Buffer.from("asset"), { status: 200 });
    },
  });
  try {
    assert.equal((await loader("geoip.dat")).toString(), "asset");
    assert.equal((await loader("geoip.dat")).toString(), "asset");
    assert.equal(await loader("not-allowed.dat"), null);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
