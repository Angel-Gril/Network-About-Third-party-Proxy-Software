import path from "node:path";
import { atomicWrite, readJson } from "./cache.mjs";
import { PROVIDERS } from "./providers.mjs";

export const DEFAULT_REFRESH_INTERVAL_MINUTES = 360;
export const MIN_REFRESH_INTERVAL_MINUTES = 5;
export const MAX_REFRESH_INTERVAL_MINUTES = 43_200;

function defaultProviderSettings() {
  return { enabled: true, intervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES };
}

function normalizeProviderSettings(value) {
  const fallback = defaultProviderSettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const enabled = typeof value.enabled === "boolean" ? value.enabled : fallback.enabled;
  const interval = Number(value.intervalMinutes);
  const intervalMinutes = Number.isInteger(interval) && interval >= MIN_REFRESH_INTERVAL_MINUTES &&
    interval <= MAX_REFRESH_INTERVAL_MINUTES ? interval : fallback.intervalMinutes;
  return { enabled, intervalMinutes };
}

function normalizeDocument(value) {
  const providers = {};
  for (const provider of PROVIDERS) providers[provider] = normalizeProviderSettings(value?.providers?.[provider]);
  return { schemaVersion: 1, providers };
}

export function defaultRefreshSettingsPath(cacheDirectory) {
  return path.join(path.dirname(cacheDirectory), "state", "subscription-server", "refresh-settings.json");
}

export function refreshTiming(metadata, settings, nowMs = Date.now()) {
  const value = normalizeProviderSettings(settings);
  const attempts = [metadata?.updatedAt, metadata?.failedAt]
    .map(item => Date.parse(item || ""))
    .filter(Number.isFinite);
  const lastAttemptMs = attempts.length ? Math.max(...attempts) : null;
  const nextAtMs = lastAttemptMs === null ? nowMs : lastAttemptMs + value.intervalMinutes * 60_000;
  return {
    ...value,
    due: value.enabled && nextAtMs <= nowMs,
    nextAt: value.enabled ? new Date(nextAtMs).toISOString() : null,
  };
}

export function createRefreshSettingsStore(filePath) {
  if (!filePath) throw new Error("Refresh settings file is required");
  let writes = Promise.resolve();

  async function get() {
    return normalizeDocument(await readJson(filePath, null));
  }

  async function update(provider, value) {
    if (!PROVIDERS.has(provider)) throw new Error("Unknown provider");
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.enabled !== "boolean") {
      throw new Error("Refresh settings are invalid");
    }
    const intervalMinutes = Number(value.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_REFRESH_INTERVAL_MINUTES ||
      intervalMinutes > MAX_REFRESH_INTERVAL_MINUTES) {
      throw new Error("Refresh interval is outside the allowed range");
    }
    const operation = writes.then(async () => {
      const document = await get();
      document.providers[provider] = { enabled: value.enabled, intervalMinutes };
      await atomicWrite(filePath, `${JSON.stringify(document, null, 2)}\n`);
      return document.providers[provider];
    });
    writes = operation.catch(() => {});
    return operation;
  }

  return { get, update };
}
