#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJson } from "./cache.mjs";
import { PROVIDERS } from "./providers.mjs";
import { createRefreshSettingsStore, defaultRefreshSettingsPath, refreshTiming } from "./refresh-settings.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runScheduledRefresh(provider, options = {}) {
  if (!PROVIDERS.has(provider)) return { ok: false, exitCode: 2, error: "Unknown provider" };
  const cacheDirectory = options.cacheDirectory || process.env.SUBSCRIPTION_CACHE_DIR || path.join(projectRoot, "data", "cache");
  const settingsFile = options.settingsFile || process.env.REFRESH_SETTINGS_FILE || defaultRefreshSettingsPath(cacheDirectory);
  const settings = (await createRefreshSettingsStore(settingsFile).get()).providers[provider];
  const metadata = await readJson(path.join(cacheDirectory, `${provider}.json`), null);
  const timing = refreshTiming(metadata, settings, options.nowMs);
  if (!timing.enabled) return { ok: true, exitCode: 0, provider, skipped: true, reason: "disabled", ...timing };
  if (!timing.due) return { ok: true, exitCode: 0, provider, skipped: true, reason: "not_due", ...timing };

  const runner = options.runner || ((script, selectedProvider) => spawnSync(process.execPath, [script, selectedProvider], {
    cwd: projectRoot, env: process.env, stdio: "inherit", timeout: 360_000,
  }).status ?? 1);
  const status = runner(path.join(projectRoot, "src", "refresh-provider.mjs"), provider);
  return { ok: status === 0, exitCode: status, provider, skipped: false };
}

async function main() {
  const result = await runScheduledRefresh(process.argv[2]);
  if (result.skipped || result.error) process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Scheduled refresh failed: ${String(error?.message || error).slice(0, 300)}\n`);
    process.exitCode = 1;
  });
}
