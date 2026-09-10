import fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "./cache.mjs";
import { PROVIDERS } from "./providers.mjs";

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

async function readStatus(cacheDirectory) {
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
    result[provider] = { available, ...(metadata || {}) };
  }
  return result;
}

export function createHandler(options) {
  const cacheDirectory = options.cacheDirectory;
  const getReadToken = options.getReadToken;
  const getSubscriptionUrl = options.getSubscriptionUrl;
  const rotateSubscriptionUrl = options.rotateSubscriptionUrl;
  const adminHtml = options.adminHtml;
  const triggerRefresh = options.triggerRefresh;
  const loadRuleAsset = options.loadRuleAsset;

  if (!cacheDirectory || !getReadToken || !getSubscriptionUrl || !rotateSubscriptionUrl || !adminHtml || !triggerRefresh || !loadRuleAsset) {
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
        sendJson(response, 200, { ok: true, providers: await readStatus(cacheDirectory) });
        return;
      }

      if (pathName === "/admin/api/subscription-url" && request.method === "GET") {
        const provider = url.searchParams.get("provider") || "flybird";
        if (!PROVIDERS.has(provider)) { sendJson(response, 400, { ok: false, error: "Unknown provider" }); return; }
        sendJson(response, 200, { ok: true, url: await getSubscriptionUrl(provider) });
        return;
      }

      if (pathName === "/admin/api/reset-subscription-url" && request.method === "POST") {
        if (request.headers["x-admin-action"] !== ADMIN_ACTION_HEADER) {
          sendJson(response, 403, { ok: false, error: "Forbidden" });
          return;
        }
        const provider = url.searchParams.get("provider") || "flybird";
        if (!PROVIDERS.has(provider)) { sendJson(response, 400, { ok: false, error: "Unknown provider" }); return; }
        sendJson(response, 200, { ok: true, url: await rotateSubscriptionUrl(provider) });
        return;
      }

      const downloadMatch = pathName.match(/^\/admin\/download\/([a-z0-9_-]+)\.yaml$/);
      if (downloadMatch && PROVIDERS.has(downloadMatch[1]) && (request.method === "GET" || request.method === "HEAD")) {
        const provider = downloadMatch[1];
        try {
          const yaml = await fs.readFile(path.join(cacheDirectory, `${provider}.yaml`), "utf8");
          send(response, 200, yaml, {
            "Content-Type": "text/yaml; charset=utf-8",
            "Content-Disposition": `attachment; filename=${provider}.yaml`,
          });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          sendJson(response, 503, { ok: false, error: "No valid configuration is available" });
        }
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

      const subscriptionMatch = pathName.match(/^\/s\/([^/]+)\/([a-z0-9_-]+)\.yaml$/);
      if (subscriptionMatch && PROVIDERS.has(subscriptionMatch[2]) && (request.method === "GET" || request.method === "HEAD")) {
        if (subscriptionMatch[1] !== await getReadToken(subscriptionMatch[2])) {
          send(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
          return;
        }
        const provider = subscriptionMatch[2];
        try {
          const yaml = await fs.readFile(path.join(cacheDirectory, `${provider}.yaml`), "utf8");
          send(response, 200, yaml, {
            "Content-Type": "text/yaml; charset=utf-8",
            "Content-Disposition": `inline; filename=${provider}.yaml`,
          });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          sendJson(response, 503, { ok: false, error: "No valid configuration is available" });
        }
        return;
      }

      send(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: "Internal server error" });
    }
  };
}
