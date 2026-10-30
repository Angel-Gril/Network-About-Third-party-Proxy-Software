import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { readJson } from "./cache.mjs";

export function flyBirdTriggerFile(environment, cacheDirectory) {
  return environment.FLYBIRD_REFRESH_TRIGGER_FILE ||
    (environment.FLYBIRD_OPENWRT_TRIGGER === "1"
      ? path.join(path.dirname(cacheDirectory), "state", "subscription-server", "apex-fetch.trigger") : "");
}

export async function isFlyBirdRefreshRunning(triggerFile) {
  if (!triggerFile) return false;
  const pendingFile = `${triggerFile}.pending`;
  try {
    const text = await fs.readFile(pendingFile, "utf8");
    // Another process may still be writing a newly acquired lock.
    if (!text) return true;
    const pending = JSON.parse(text);
    if (!Number.isSafeInteger(pending.pid) || pending.pid <= 0) return false;
    try { process.kill(pending.pid, 0); return true; }
    catch (error) { return error.code === "EPERM"; }
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function refreshViaFlyBirdTrigger({ triggerFile, cacheDirectory,
  timeoutMs = 210_000, pollMs = 500 }) {
  const pendingFile = `${triggerFile}.pending`;
  const requestId = randomUUID();
  await fs.mkdir(path.dirname(triggerFile), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { handle = await fs.open(pendingFile, "wx", 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await isFlyBirdRefreshRunning(triggerFile)) {
        return { provider: "flybird", skipped: true, reason: "already_running" };
      }
      // A killed worker may leave its lock behind. Its PID is no longer alive.
      await fs.rm(pendingFile, { force: true });
    }
  }
  if (!handle) throw new Error("FlyBird refresh could not acquire its request lock");
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, requestId, startedAt: new Date().toISOString() }));
    const metadataPath = path.join(cacheDirectory, "flybird.json");
    const before = await readJson(metadataPath, {});
    await fs.writeFile(triggerFile, `${requestId}\n`, { mode: 0o600 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await readJson(metadataPath, {});
      if (current.updatedAt && current.updatedAt !== before.updatedAt && !current.lastError) {
        return { ...current, provider: "flybird", source: "apex-pure-protocol" };
      }
      if (current.failedAt && current.failedAt !== before.failedAt && current.lastError) {
        throw new Error("FlyBird protocol refresh failed; cached configuration preserved");
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error("FlyBird protocol refresh timed out; cached configuration preserved");
  } finally {
    await handle.close();
    const pending = await readJson(pendingFile, null);
    if (pending?.requestId === requestId) await fs.rm(pendingFile, { force: true });
  }
}
