#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_APEX_V2_API_DOMAINS,
  DEFAULT_APEX_V2_SUBSCRIBE_DOMAINS,
  downloadApexV2Subscription,
  getApexV2AccessCredential,
  loginApexV2,
} from "./apex-v2.js";

function usage() {
  return [
    "Usage: node src/headless.mjs --out DIR (--access-key KEY | --token TOKEN | --email EMAIL --password PASSWORD)",
    "  --base URL[,URL...]       v2 API domains",
    "  --sub URL[,URL...]        v2 subscription domains",
    "  --access-key KEY         download directly without login",
    "  --token TOKEN            exchange an existing xboard session token",
    "  --email EMAIL --password PASSWORD  perform the official v2 login",
    "  --out DIR                write raw_body.bin, response_headers.json and credential.json",
  ].join("\n");
}

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") return { help: true };
    if (!value.startsWith("--")) throw new Error(`unexpected argument: ${value}`);
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for --${key}`);
    result[key] = next;
    index += 1;
  }
  return result;
}

function list(value, fallback) {
  const values = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? values : fallback;
}

function sha256(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.out) throw new Error("--out is required");
  const apiDomains = list(options.base, DEFAULT_APEX_V2_API_DOMAINS);
  const subscribeDomains = list(options.sub, DEFAULT_APEX_V2_SUBSCRIBE_DOMAINS);
  let credential;
  if (options.accessKey) {
    credential = { accessKey: options.accessKey, source: "access-key" };
  } else if (options.token) {
    credential = {
      ...(await getApexV2AccessCredential({ apiDomains, token: options.token })),
      source: "session-token",
    };
  } else if (options.email && options.password) {
    const login = await loginApexV2({ apiDomains, email: options.email, password: options.password });
    credential = {
      ...(await getApexV2AccessCredential({ apiDomains, authData: login.authData })),
      source: "account-login",
    };
    login.token = "";
    login.authData = "";
  } else {
    throw new Error("provide --access-key, --token, or --email and --password");
  }

  const downloaded = await downloadApexV2Subscription({
    accessKey: credential.accessKey,
    subscribeDomains,
  });
  const output = path.resolve(options.out);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "raw_body.bin"), downloaded.body);
  await fs.writeFile(path.join(output, "response_headers.json"), JSON.stringify({
    url: downloaded.url,
    status: downloaded.status,
    headers: downloaded.headers,
  }, null, 2));
  await fs.writeFile(path.join(output, "credential.json"), JSON.stringify({
    source: credential.source,
    accessKey: credential.accessKey,
    encryptKey: credential.encryptKey || "",
    signKey: credential.signKey || "",
    keyId: credential.keyId || "",
    expiresAt: credential.expiresAt || "",
    fetchedUrl: downloaded.url,
    bodySha256: await sha256(downloaded.body),
    bodyLength: downloaded.body.length,
    fetchedAt: new Date().toISOString(),
  }, null, 2));
  credential.accessKey = "";
  credential.encryptKey = "";
  credential.signKey = "";
  console.log(JSON.stringify({
    ok: true,
    source: credential.source,
    endpointHost: new URL(downloaded.url).host,
    status: downloaded.status,
    bodyLength: downloaded.body.length,
    output,
  }));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: String(error?.message || error).slice(0, 300) }));
  process.exitCode = 1;
}

