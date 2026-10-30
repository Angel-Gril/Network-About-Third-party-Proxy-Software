#!/usr/bin/env node
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import {
  ApexV2Error,
  DEFAULT_APEX_V2_API_DOMAINS,
  DEFAULT_APEX_V2_SUBSCRIBE_DOMAINS,
  buildApexV2DownloadUrls,
  getApexV2AccessCredential,
  loginApexV2,
} from "./apex-v2.js";
import {
  decodeHttpContent,
  decryptApxsV2Detailed,
  verifyApxsV2SignatureDetailed,
} from "./apxs-v2.js";

function usage() {
  return [
    "Usage: node src/headless.mjs --out DIR (--access-key KEY | --token TOKEN | --email EMAIL --password PASSWORD)",
    "  --base URL[,URL...]       v2 API domains",
    "  --sub URL[,URL...]        v2 subscription domains",
    "  --access-key KEY         download directly without login",
    "  --token TOKEN            exchange an existing xboard session token",
    "  --email EMAIL --password PASSWORD  perform the official v2 login",
    "  --client-cert PEM         mTLS client certificate",
    "  --client-key PEM          mTLS client private key",
    "  --insecure               skip TLS verification for controlled diagnostics",
    "  --out DIR                write raw response, credential, APXS metadata and fb_clash.yaml",
  ].join("\n");
}

function args(argv) {
  const result = {};
  const booleanKeys = new Set(["insecure"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") return { help: true };
    if (!value.startsWith("--")) throw new Error(`unexpected argument: ${value}`);
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (booleanKeys.has(key)) {
      result[key] = true;
      continue;
    }
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

function requestRawHttps(url, headers, rejectUnauthorized = true, timeoutMs = 30_000, clientCert = "", clientKey = "") {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(url), {
      method: "GET",
      headers,
      rejectUnauthorized,
      cert: clientCert || undefined,
      key: clientKey || undefined,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        url,
        status: response.statusCode || 0,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(", ") : String(value || ""),
        ])),
        body: new Uint8Array(Buffer.concat(chunks)),
      }));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
    request.end();
  });
}

function fetchMtls(clientCert, clientKey, rejectUnauthorized = true) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const body = init.body instanceof URLSearchParams ? init.body.toString() : init.body || null;
    const headers = { ...(init.headers || {}) };
    if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = https.request(new URL(url), {
      method: init.method || "GET",
      headers,
      cert: clientCert,
      key: clientKey,
      rejectUnauthorized,
      timeout: 30_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode || 0,
        headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [
          key, Array.isArray(value) ? value.join(", ") : String(value || ""),
        ])),
      })));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function downloadRawApexV2Subscription({ accessKey, subscribeDomains, subscribeUrl, insecure, clientCert, clientKey }) {
  const urls = buildApexV2DownloadUrls(accessKey, subscribeDomains, subscribeUrl);
  const failures = [];
  for (const url of urls) {
    try {
      const response = await requestRawHttps(url, {
        Accept: "application/json",
        "User-Agent": "ua.net.fbclient.app.apex/v7.2.3",
        "x-client-platform": "windows",
        "Accept-Encoding": "gzip",
      }, !insecure, 30_000, clientCert, clientKey);
      if (response.status >= 200 && response.status < 300) return response;
      failures.push({ url, status: response.status, bodyLength: response.body.length });
    } catch (error) {
      failures.push({ url, error: error?.name || "request_failed" });
    }
  }
  const status = failures.find((failure) => failure.status)?.status || null;
  throw new ApexV2Error(`Apex v2 subscription download failed at ${failures.length} endpoint(s)`, { status });
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
  const transport = {
    clientCert: options.clientCert || "",
    clientKey: options.clientKey || "",
    rejectUnauthorized: !options.insecure,
  };
  const fetchImpl = transport.clientCert && transport.clientKey
    ? fetchMtls(transport.clientCert, transport.clientKey, transport.rejectUnauthorized)
    : undefined;
  let credential;
  if (options.accessKey) {
    credential = { accessKey: options.accessKey, source: "access-key" };
  } else if (options.token) {
    credential = {
      ...(await getApexV2AccessCredential({ apiDomains, token: options.token, fetchImpl })),
      source: "session-token",
    };
  } else if (options.email && options.password) {
    const login = await loginApexV2({ apiDomains, email: options.email, password: options.password, fetchImpl });
    credential = {
      ...(await getApexV2AccessCredential({ apiDomains, authData: login.authData, fetchImpl })),
      source: "account-login",
    };
    login.token = "";
    login.authData = "";
  } else {
    throw new Error("provide --access-key, --token, or --email and --password");
  }

  const downloaded = await downloadRawApexV2Subscription({
    accessKey: credential.accessKey,
    subscribeDomains,
    subscribeUrl: credential.subscribeUrl,
    insecure: options.insecure === "true" || options.insecure === true,
    clientCert: options.clientCert || "",
    clientKey: options.clientKey || "",
  });
  const output = path.resolve(options.out);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "raw_body.bin"), downloaded.body);
  await fs.writeFile(path.join(output, "response_headers.json"), JSON.stringify({
    url: downloaded.url,
    status: downloaded.status,
    headers: downloaded.headers,
  }, null, 2));
  const httpBody = await decodeHttpContent(
    downloaded.body,
    downloaded.headers["content-encoding"] || "",
  );
  await fs.writeFile(path.join(output, "credential.json"), JSON.stringify({
    source: credential.source,
    accessKey: credential.accessKey,
    encryptKey: credential.encryptKey || "",
    signKey: credential.signKey || "",
    keyId: credential.keyId || "",
    expiresAt: credential.expiresAt || "",
    subscribeUrl: credential.subscribeUrl || "",
    fetchedUrl: downloaded.url,
    bodySha256: await sha256(downloaded.body),
    bodyLength: downloaded.body.length,
    wireBodyLength: downloaded.body.length,
    decodedBodyLength: httpBody.bytes.length,
    contentEncoding: downloaded.headers["content-encoding"] || "",
    fetchedAt: new Date().toISOString(),
  }, null, 2));
  const signature = downloaded.headers["apex-sub-sign-v2"]
    || downloaded.headers["x-apex-signature"]
    || downloaded.headers["apex-signature"]
    || "";
  const decrypted = await decryptApxsV2Detailed(httpBody.bytes, credential);
  let signatureDetails = { ok: null, scope: null, encoding: null, over: null };
  if (signature && credential.signKey) {
    signatureDetails = {
      ...(await verifyApxsV2SignatureDetailed(
        httpBody.bytes,
        signature,
        credential.signKey,
        decrypted.bytes,
      )),
      over: "logical",
    };
    if (!signatureDetails.ok && httpBody.compressed) {
      signatureDetails = {
        ...(await verifyApxsV2SignatureDetailed(
          downloaded.body,
          signature,
          credential.signKey,
          decrypted.bytes,
        )),
        over: "wire",
      };
    }
    if (!signatureDetails.ok) throw new Error("APXS v2 signature verification failed");
  }
  await fs.writeFile(path.join(output, "fb_clash.yaml"), decrypted.bytes);
  await fs.writeFile(path.join(output, "apxs_meta.json"), JSON.stringify({
    source: "headless",
    captured_at: new Date().toISOString(),
    http_status: downloaded.status,
    content_encoding: downloaded.headers["content-encoding"] || "",
    wire_body_len: downloaded.body.length,
    decoded_body_len: httpBody.bytes.length,
    bodyEncoding: decrypted.bodyEncoding,
    layout: decrypted.layout,
    key: decrypted.key,
    signatureVerified: signatureDetails.ok === true,
    signature: {
      header: signature ? (downloaded.headers["apex-sub-sign-v2"] ? "apex-sub-sign-v2"
        : downloaded.headers["x-apex-signature"] ? "x-apex-signature" : "apex-signature") : null,
      scope: signatureDetails.scope,
      encoding: signatureDetails.encoding,
      over: signatureDetails.over,
      ok: signatureDetails.ok,
    },
    credential_expires_at: credential.expiresAt || null,
    reused_without_session: credential.source !== "account-login",
    yaml_sha256: await sha256(decrypted.bytes),
    live_verified: false,
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
    decodedBodyLength: httpBody.bytes.length,
    yamlLength: decrypted.bytes.length,
    apxsLayout: decrypted.layout,
    output,
  }));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: String(error?.message || error).slice(0, 300) }));
  process.exitCode = 1;
}

