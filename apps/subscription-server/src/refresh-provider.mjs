import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { handleRequest, enhanceMihomoConfig } from "@proxy-toolkit/flybird";
import { fetchMonoCloudSubscription } from "@proxy-toolkit/monocloud";
import { commitLastGood, recordFailure } from "./cache.mjs";
import { PROVIDERS } from "./providers.mjs";
import { prepareSubscription } from "./validate-subscription.mjs";
import { applyRoutingTemplate } from "./routing-template.mjs";
import YAML from "yaml";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDirectory = process.env.SUBSCRIPTION_CACHE_DIR || path.join(projectRoot, "data", "cache");

const runFile = promisify(execFile);

async function readCredential(filePath) {
  const value = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!value?.email || !value?.password) throw new Error("Credential file is incomplete");
  return value;
}

async function refreshFlyBird() {
  const credential = await readCredential(process.env.FLYBIRD_CREDENTIAL_FILE);
  try {
    const domain = process.env.PUBLIC_DOMAIN;
    const internalKey = "internal-refresh-key";
    const response = await handleRequest(new Request(`https://${domain}/sub?key=${internalKey}`), {
      ACCESS_KEY: internalKey,
      FLYBIRD_EMAIL: credential.email,
      FLYBIRD_PASSWORD: credential.password,
    });
    const yaml = await response.text();
    if (!response.ok) throw new Error(`FlyBird returned HTTP ${response.status}`);
    let previousYaml = null;
    const previousPath = process.env.FLYBIRD_RECOVERY_FILE || path.join(cacheDirectory, "flybird.yaml");
    try { previousYaml = await fs.readFile(previousPath, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const prepared = await prepareSubscription(yaml, {
      minimum: Number(process.env.FLYBIRD_MIN_PROXIES || 1), previousYaml, allowServerRecovery: true,
    });
    return commitLastGood(cacheDirectory, "flybird", prepared.yaml, prepared);
  } finally {
    credential.email = "";
    credential.password = "";
  }
}

async function refreshLeapVpn() {
  const python = process.env.LEAPVPN_PYTHON;
  const exporter = process.env.LEAPVPN_EXPORT_SCRIPT;
  const session = process.env.LEAPVPN_SESSION_FILE;
  const credentials = process.env.LEAPVPN_CREDENTIAL_FILE;
  const authState = process.env.LEAPVPN_AUTH_STATE_FILE;
  const automaticLogin = Boolean(credentials || authState);
  if (!python || (automaticLogin ? !credentials || !authState : !session)) {
    throw new Error("LeapVPN refresh configuration is incomplete");
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-leapvpn-"));
  try {
    const output = path.join(directory, "output");
    try {
      const entrypoint = exporter ? [exporter] : ["-m", automaticLogin ? "leapvpn.refresh" : "leapvpn.export"];
      const args = automaticLogin
        ? [...entrypoint, "--credentials", credentials, "--state", authState, "--out-dir", output]
        : [...entrypoint, "--settings", session, "--fetch-all", "--out-dir", output];
      await runFile(python, args, {
        timeout: 300000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
    } catch (error) {
      if (automaticLogin && error.code === 75) return { provider: "leapvpn", skipped: true, reason: "already_running" };
      throw new Error(`LeapVPN exporter failed (exit ${String(error.code || "unknown").replace(/[^A-Za-z0-9_-]/g, "")})`);
    }
    const text = await fs.readFile(path.join(output, "leap_clash.yaml"), "utf8");
    const domain = process.env.PUBLIC_DOMAIN;
    if (!domain) throw new Error("Shared routing configuration is incomplete");
    const defaults = YAML.parse(await fs.readFile(path.join(projectRoot, "templates/mihomo-base.yaml"), "utf8"));
    const routed = applyRoutingTemplate(text, `https://${domain}`, enhanceMihomoConfig, defaults);
    const prepared = await prepareSubscription(routed.yaml, { minimum: Number(process.env.LEAPVPN_MIN_PROXIES || 1) });
    prepared.routing = routed.routing;
    if (automaticLogin) {
      const metadata = JSON.parse(await fs.readFile(path.join(output, "leap_meta.json"), "utf8"));
      const auth = metadata.authentication;
      if (auth?.mode !== "device_credentials" || !Number.isSafeInteger(auth.session_expires_at_ms)) {
        throw new Error("LeapVPN authentication metadata is invalid");
      }
      prepared.authentication = {
        mode: auth.mode, sessionRenewed: auth.session_renewed === true,
        accountLogin: auth.account_login === true, sessionExpiresAtMs: auth.session_expires_at_ms,
      };
    }
    return commitLastGood(cacheDirectory, "leapvpn", prepared.yaml, prepared);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function refreshMonoCloud() {
  const credential = await readCredential(process.env.MONOCLOUD_CREDENTIAL_FILE);
  try {
    const result = await fetchMonoCloudSubscription(credential);
    const domain = process.env.PUBLIC_DOMAIN;
    if (!domain) throw new Error("Shared routing configuration is incomplete");
    const defaults = YAML.parse(await fs.readFile(path.join(projectRoot, "templates/mihomo-base.yaml"), "utf8"));
    const routed = applyRoutingTemplate(result.yaml, `https://${domain}`, enhanceMihomoConfig, defaults);
    const prepared = await prepareSubscription(routed.yaml, {
      minimum: Number(process.env.MONOCLOUD_MIN_PROXIES || 1),
    });
    prepared.routing = routed.routing;
    prepared.authentication = { mode: "account_login", planCount: result.planCount };
    prepared.account = result.account;
    return commitLastGood(cacheDirectory, "monocloud", prepared.yaml, prepared);
  } finally {
    credential.email = "";
    credential.password = "";
  }
}

const provider = process.argv[2];
if (!PROVIDERS.has(provider)) {
  process.stderr.write("Provider must be flybird, leapvpn or monocloud\n");
  process.exitCode = 2;
} else {
  try {
    const result = await (provider === "flybird" ? refreshFlyBird()
      : provider === "leapvpn" ? refreshLeapVpn() : refreshMonoCloud());
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    await recordFailure(cacheDirectory, provider, error);
    process.stderr.write(`Refresh failed: ${String(error?.message || error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
