import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { atomicWrite } from "../src/cache.mjs";
import { flyBirdTriggerFile, isFlyBirdRefreshRunning, refreshViaFlyBirdTrigger } from "../src/flybird-refresh-trigger.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flybird-trigger-"));
  const cacheDirectory = path.join(root, "cache");
  const triggerFile = path.join(root, "state", "apex.trigger");
  const metadataPath = path.join(cacheDirectory, "flybird.json");
  await atomicWrite(path.join(cacheDirectory, "flybird.yaml"), "last-good-yaml");
  await atomicWrite(metadataPath, JSON.stringify({ updatedAt: "2026-10-30T10:00:00Z", proxyCount: 74, lastError: null }));
  return { root, cacheDirectory, triggerFile, metadataPath, timeoutMs: 1000, pollMs: 5 };
}

async function requested(f) {
  for (let n = 0; n < 200; n += 1) {
    try { await fs.stat(f.triggerFile); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await sleep(5);
  }
  throw new Error("Fixture did not receive the refresh request");
}

test("external refresh waits for publication and coalesces concurrent manual/scheduled jobs", async () => {
  const f = await fixture();
  try {
    let finished = false;
    const first = refreshViaFlyBirdTrigger(f).then(value => { finished = true; return value; });
    await requested(f);
    assert.equal(await isFlyBirdRefreshRunning(f.triggerFile), true);
    assert.equal(finished, false, "a trigger write is not a successful refresh");
    const request = await fs.readFile(f.triggerFile, "utf8");
    assert.deepEqual(await refreshViaFlyBirdTrigger(f), { provider: "flybird", skipped: true, reason: "already_running" });
    assert.equal(await fs.readFile(f.triggerFile, "utf8"), request, "duplicate requests must not queue another root job");
    await atomicWrite(f.metadataPath, JSON.stringify({ updatedAt: "2026-10-30T12:00:00Z", proxyCount: 74, lastError: null }));
    assert.equal((await first).updatedAt, "2026-10-30T12:00:00Z");
    assert.equal(await isFlyBirdRefreshRunning(f.triggerFile), false);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("external refresh failures preserve last-good YAML and release the pending state", async () => {
  const f = await fixture();
  try {
    const first = refreshViaFlyBirdTrigger(f);
    const rejected = assert.rejects(first, /protocol refresh failed/);
    await requested(f);
    await atomicWrite(f.metadataPath, JSON.stringify({ updatedAt: "2026-10-30T10:00:00Z",
      failedAt: "2026-10-30T12:00:00Z", lastError: "synthetic root job failure" }));
    await rejected;
    assert.equal(await fs.readFile(path.join(f.cacheDirectory, "flybird.yaml"), "utf8"), "last-good-yaml");
    assert.equal(await isFlyBirdRefreshRunning(f.triggerFile), false);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("an unchanged cache cannot report trigger success when the root publisher never responds", async () => {
  const f = await fixture();
  try {
    await assert.rejects(refreshViaFlyBirdTrigger({ ...f, timeoutMs: 40 }), /timed out/);
    assert.equal(await isFlyBirdRefreshRunning(f.triggerFile), false);
    assert.equal(await fs.readFile(path.join(f.cacheDirectory, "flybird.yaml"), "utf8"), "last-good-yaml");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("the pure protocol trigger uses an explicit path and supports the previous deployment flag", () => {
  assert.equal(flyBirdTriggerFile({}, "/var/lib/sub/cache"), "");
  assert.equal(flyBirdTriggerFile({ FLYBIRD_REFRESH_TRIGGER_FILE: "/run/apex.trigger" }, "/var/lib/sub/cache"), "/run/apex.trigger");
  assert.equal(flyBirdTriggerFile({ FLYBIRD_OPENWRT_TRIGGER: "1" }, "/var/lib/sub/cache"),
    path.join("/var/lib/sub", "state", "subscription-server", "apex-fetch.trigger"));
});
