import fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "./cache.mjs";
import { PROVIDERS } from "./providers.mjs";
import { refreshTiming } from "./refresh-settings.mjs";
import { normalizeSubscriptionFormat, renderSubscription, SUBSCRIPTION_FORMATS,
  subscriptionFormatFromExtension } from "./subscription-formats.mjs";

const ADMIN_ACTION_HEADER = "private-subscription-admin";

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  if (response.req?.method === "HEAD") response.end();
  else response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, `${JSON.stringify(value, null, 2)}\n`, {
    "Content-Type": "application/json; charset=utf-8",
  });
}

async function readStatus(cacheDirectory, refreshSettings) {
  const result = {};
  for (const provider of PROVIDERS) {
    const metadata = await readJson(path.join(cacheDirectory, `${provider}.json`), null);
    let available = false;
    try {
      const stat = await fs.stat(path.join(cacheDirectory, `${provider}.yaml`));
      available = stat.isFile() && stat.size > 0;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    result[provider] = {
      available,
      ...(metadata || {}),
      refresh: refreshTiming(metadata, refreshSettings.providers[provider]),
    };
  }
  return result;
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Request body is invalid"); }
}

async function serveSubscription(response, cacheDirectory, provider, format, disposition) {
  try {
    const yaml = await fs.readFile(path.join(cacheDirectory, `${provider}.yaml`), "utf8");
    const body = renderSubscription(yaml, format);
    const details = SUBSCRIPTION_FORMATS[format];
    send(response, 200, body, {
      "Content-Type": details.contentType,
      "Content-Disposition": `${disposition}; filename=${provider}.${details.extension}`,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(response, 503, { ok: false, error: "No valid configuration is available" });
      return;
    }
    if (/configuration|proxy|share link|unsupported/i.test(String(error?.message || ""))) {
      sendJson(response, 422, { ok: false, error: "Cached configuration is unavailable in this format" });
      return;
    }
    throw error;
  }
}

export function createHandler(options) {
  const cacheDirectory = options.cacheDirectory;
  const getReadToken = options.getReadToken;
  const getSubscriptionUrl = options.getSubscriptionUrl;
  const rotateSubscriptionUrl = options.rotateSubscriptionUrl;
  const adminHtml = options.adminHtml;
  const triggerRefresh = options.triggerRefresh;
  const loadRuleAsset = options.loadRuleAsset;
  const getRefreshSettings = options.getRefreshSettings;
  const updateRefreshSettings = options.updateRefreshSettings;

  if (!cacheDirectory || !getReadToken || !getSubscriptionUrl || !rotateSubscriptionUrl || !adminHtml ||
      !triggerRefresh || !loadRuleAsset || !getRefreshSettings || !updateRefreshSettings) {
    throw new Error("Incomplete application options");
  }

  return async function handler(request, response) {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const pathName = url.pathname.replace(/\/+$/, "") || "/";

      if (pathName === "/healthz" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (pathName === "/admin" && request.method === "GET") {
        send(response, 200, adminHtml, { "Content-Type": "text/html; charset=utf-8" });
        return;
      }

      if (pathName === "/admin/api/status" && request.method === "GET") {
        sendJson(response, 200, { ok: true, providers: await readStatus(cacheDirectory, await getRefreshSettings()) });
        return;
      }

      if (pathName === "/admin/api/subscription-url" && request.method === "GET") {
        const provider = url.searchParams.get("provider") || "flybird";
        if (!PROVIDERS.has(provider)) { sendJson(response, 400, { ok: false, error: "Unknown provider" }); return; }
        let format;
        try { format = normalizeSubscriptionFormat(url.searchParams.get("format") || "clash"); }
        catch { sendJson(response, 400, { ok: false, error: "Unknown subscription format" }); return; }
        sendJson(response, 200, { ok: true, format, url: await getSubscriptionUrl(provider, format) });
        return;
      }

      if (pathName === "/admin/api/reset-subscription-url" && request.method === "POST") {
        if (request.headers["x-admin-action"] !== ADMIN_ACTION_HEADER) {
          sendJson(response, 403, { ok: false, error: "Forbidden" });
          return;
        }
        const provider = url.searchParams.get("provider") || "flybird";
        if (!PROVIDERS.has(provider)) { sendJson(response, 400, { ok: false, error: "Unknown provider" }); return; }
        let format;
        try { format = normalizeSubscriptionFormat(url.searchParams.get("format") || "clash"); }
        catch { sendJson(response, 400, { ok: false, error: "Unknown subscription format" }); return; }
        sendJson(response, 200, { ok: true, format, url: await rotateSubscriptionUrl(provider, format) });
        return;
      }

      const settingsMatch = pathName.match(/^\/admin\/api\/refresh-settings\/([a-z0-9_-]+)$/);
      if (settingsMatch && PROVIDERS.has(settingsMatch[1]) && request.method === "PUT") {
        if (request.headers["x-admin-action"] !== ADMIN_ACTION_HEADER) {
          sendJson(response, 403, { ok: false, error: "Forbidden" });
          return;
        }
        try {
          const settings = await updateRefreshSettings(settingsMatch[1], await readJsonBody(request));
          sendJson(response, 200, { ok: true, provider: settingsMatch[1], settings });
        } catch {
          sendJson(response, 400, { ok: false, error: "Refresh settings are invalid" });
        }
        return;
      }

      const downloadMatch = pathName.match(/^\/admin\/download\/([a-z0-9_-]+)\.(yaml|txt|b64)$/);
      if (downloadMatch && PROVIDERS.has(downloadMatch[1]) && (request.method === "GET" || request.method === "HEAD")) {
        await serveSubscription(response, cacheDirectory, downloadMatch[1],
          subscriptionFormatFromExtension(downloadMatch[2]), "attachment");
        return;
      }

      const refreshMatch = pathName.match(/^\/admin\/api\/refresh\/([a-z0-9_-]+)$/);
      if (refreshMatch && PROVIDERS.has(refreshMatch[1]) && request.method === "POST") {
        if (request.headers["x-admin-action"] !== ADMIN_ACTION_HEADER) {
          sendJson(response, 403, { ok: false, error: "Forbidden" });
          return;
        }
        const result = await triggerRefresh(refreshMatch[1]);
        sendJson(response, result.started ? 202 : 409, result);
        return;
      }

      const rulesMatch = pathName.match(/^\/rules\/([A-Za-z0-9.-]+)$/);
      if (rulesMatch && (request.method === "GET" || request.method === "HEAD")) {
        const asset = await loadRuleAsset(rulesMatch[1]);
        if (!asset) {
          send(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
          return;
        }
        send(response, 200, asset, {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
        });
        return;
      }

      const subscriptionMatch = pathName.match(/^\/s\/([^/]+)\/([a-z0-9_-]+)\.(yaml|txt|b64)$/);
      if (subscriptionMatch && PROVIDERS.has(subscriptionMatch[2]) && (request.method === "GET" || request.method === "HEAD")) {
        if (subscriptionMatch[1] !== await getReadToken(subscriptionMatch[2])) {
          send(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
          return;
        }
        await serveSubscription(response, cacheDirectory, subscriptionMatch[2],
          subscriptionFormatFromExtension(subscriptionMatch[3]), "inline");
        return;
      }

      send(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: "Internal server error" });
    }
  };
}
