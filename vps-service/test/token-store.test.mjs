import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTokenStore } from "../src/token-store.mjs";

test("token store rotates a persistent opaque token atomically", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-token-test-"));
  const file = path.join(directory, "read-token");
  const initial = "a".repeat(64);
  try {
    await fs.writeFile(file, `${initial}\n`, { mode: 0o600 });
    const store = await createTokenStore(file);
    assert.equal(store.get(), initial);

    const rotated = await store.rotate();
    assert.match(rotated, /^[a-f0-9]{64}$/);
    assert.notEqual(rotated, initial);
    assert.equal(store.get(), rotated);
    assert.equal((await fs.readFile(file, "utf8")).trim(), rotated);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
