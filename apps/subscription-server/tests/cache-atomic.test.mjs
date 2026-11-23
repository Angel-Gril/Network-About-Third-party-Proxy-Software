import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWrite } from "../src/cache.mjs";

test("a failed atomic replacement preserves the old target and removes its temporary file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-atomic-"));
  try {
    const target = path.join(root, "existing-directory");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep"), "last-good");
    await assert.rejects(atomicWrite(target, "new-content"));
    assert.deepEqual(await fs.readdir(root), ["existing-directory"]);
    assert.equal(await fs.readFile(path.join(target, "keep"), "utf8"), "last-good");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a transient destination lock retries replacement without removing the old target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-locked-"));
  const rename = fs.rename;
  try {
    const target = path.join(root, "current");
    await fs.writeFile(target, "last-good");
    let attempts = 0;
    fs.rename = async (...args) => {
      attempts++;
      if (attempts === 1) {
        assert.equal(await fs.readFile(target, "utf8"), "last-good");
        throw Object.assign(new Error("synthetic Windows sharing lock"), { code: "EPERM" });
      }
      return rename(...args);
    };
    await atomicWrite(target, "new-value");
    assert.equal(attempts, 2);
    assert.equal(await fs.readFile(target, "utf8"), "new-value");
    assert.deepEqual(await fs.readdir(root), ["current"]);
  } finally { fs.rename = rename; await fs.rm(root, { recursive: true, force: true }); }
});
