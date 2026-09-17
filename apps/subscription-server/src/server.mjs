import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "./app.mjs";
import { createRuleLoader } from "./rules.mjs";
import { createTokenStore } from "./token-store.mjs";
import { PROVIDERS } from "./providers.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDirectory = process.env.SUBSCRIPTION_CACHE_DIR || path.join(projectRoot, "data", "cache");
const readTokenFile = String(process.env.SUBSCRIPTION_READ_TOKEN_FILE || "");
const publicDomain = String(process.env.PUBLIC_DOMAIN || "").toLowerCase();
const listenHost = process.env.LISTEN_HOST || "127.0.0.1";
const listenPort = Number(process.env.LISTEN_PORT || 3100);
const refreshScript = path.join(projectRoot, "src", "refresh-provider.mjs");
const running = new Set();

if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(publicDomain)) {
  throw new Error("PUBLIC_DOMAIN must be a valid DNS name");
}

const adminHtml = await fs.readFile(path.join(projectRoot, "public", "admin.html"), "utf8");
const loadRuleAsset = createRuleLoader({ cacheDirectory: path.join(cacheDirectory, "rules") });
const tokenStores = new Map([
  ["flybird", await createTokenStore(readTokenFile)],
  ["leapvpn", await createTokenStore(process.env.LEAPVPN_READ_TOKEN_FILE)],
  ["monocloud", await createTokenStore(process.env.MONOCLOUD_READ_TOKEN_FILE)],
]);
const buildSubscriptionUrl = (provider, token) => `https://${publicDomain}/s/${token}/${provider}.yaml`;

async function triggerRefresh(provider) {
  if (!PROVIDERS.has(provider)) return { ok: false, started: false, error: "Unknown provider" };
  if (running.has(provider)) return { ok: false, started: false, provider, error: "Refresh already running" };
  running.add(provider);
  const child = spawn(process.execPath, [refreshScript, provider], {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errorOutput = "";
  child.stderr.on("data", (chunk) => {
    if (errorOutput.length < 4096) errorOutput += chunk.toString("utf8");
  });
  child.once("exit", (code) => {
    running.delete(provider);
    if (code !== 0) process.stderr.write(`Refresh ${provider} failed: ${errorOutput.trim().slice(0, 500)}\n`);
  });
  child.once("error", (error) => {
    running.delete(provider);
    process.stderr.write(`Refresh ${provider} failed to start: ${error.message}\n`);
  });
  return { ok: true, started: true, provider };
}

const handler = createHandler({
  cacheDirectory,
  getReadToken: (provider) => tokenStores.get(provider).get(),
  getSubscriptionUrl: (provider) => buildSubscriptionUrl(provider, tokenStores.get(provider).get()),
  rotateSubscriptionUrl: async (provider) => buildSubscriptionUrl(provider, await tokenStores.get(provider).rotate()),
  adminHtml,
  triggerRefresh,
  loadRuleAsset,
});
const server = http.createServer((request, response) => handler(request, response));
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(listenPort, listenHost, () => {
  process.stdout.write(`Private subscription service listening on ${listenHost}:${listenPort}\n`);
});
