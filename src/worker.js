const API_BASE_URL = "https://fbesa.apiv2.a047.com/api/v1";
const LOGIN_URL = `${API_BASE_URL}/passport/auth/login`;
const USER_SUB_INFO_URL = `${API_BASE_URL}/user/getSubscribe`;
const DEFAULT_CLASH_SUB_URL =
  "https://fbesa.apiv2.a047.com/api/v1/client/subscribe?token={token}";
const CLASH_SUB_URL_CANDIDATES = [
  DEFAULT_CLASH_SUB_URL,
  "https://fbapid.web.ak005.com/api/v1/client/subscribe?flag=meta&token={token}",
  "https://fbapi.web.ak005.com/api/v1/client/subscribe?token={token}",
  "https://fbapi.web.ak005.com/api/v1/client/subscribe?flag=meta&token={token}",
];

const LOGIN_HEADERS = {
  "User-Agent": "NetFlow/v3.0.3 clash-verge Platform/windows",
  Accept: "application/json",
  "x-auth-token": "K9rM2bA7vP5wN8x",
  "x-app-package-name": "atlas",
  "x-client-platform": "windows",
};

const USER_INFO_HEADERS = LOGIN_HEADERS;

const CLASH_HEADERS = {
  "User-Agent": "NetFlow/v3.0.3 clash-verge Platform/windows",
  "x-auth-token": "K9rM2bA7vP5wN8x",
  "x-app-package-name": "atlas",
  "x-client-platform": "windows",
};

const DEFAULT_PROFILE_KEY = "14f521a32997b257";
const DEFAULT_PROFILE_IV = "d217125f4b9cc9c8";

const META_RULES_BASE =
  "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest";

const SUPPORTED_RULE_ASSETS = new Set([
  "geoip.dat",
  "geoip-lite.dat",
  "geoip.db",
  "geoip-lite.db",
  "geosite.dat",
  "geosite-lite.dat",
  "geosite.db",
  "geosite-lite.db",
  "country.mmdb",
  "country-lite.mmdb",
  "GeoLite2-ASN.mmdb",
  "geoip.metadb",
  "geoip-lite.metadb",
]);

const enc = new TextEncoder();
const dec = new TextDecoder();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bytesToBase64(bytes) {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const normalized = String(b64)
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + "=".repeat(4 - (normalized.length % 4));

  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  return base64ToBytes(value);
}

function base64EncodeUtf8(text) {
  return bytesToBase64(enc.encode(text));
}

function base64DecodeUtf8(text) {
  return dec.decode(base64ToBytes(text));
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function getWorkerBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function envFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function requestFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, defaultValue) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : defaultValue;
}

function extractSubscriptionToken(value) {
  return parseSubscriptionInput(value).token;
}

function parseSubscriptionInput(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return {
      token: "",
      subscriptionUrl: "",
    };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      throw new HttpError(400, "subscription url must use https");
    }
    const token = parsed.searchParams.get("token");
    if (token) {
      return {
        token: token.trim(),
        subscriptionUrl: parsed.toString(),
      };
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Plain tokens and token= fragments are accepted below.
  }

  const tokenMatch =
    raw.match(/(?:^|[?&])token=([^&#\s]+)/i) ||
    raw.match(/^token=([^&#\s]+)/i);
  if (tokenMatch) {
    try {
      return {
        token: decodeURIComponent(tokenMatch[1]).trim(),
        subscriptionUrl: "",
      };
    } catch {
      return {
        token: tokenMatch[1].trim(),
        subscriptionUrl: "",
      };
    }
  }

  return {
    token: raw,
    subscriptionUrl: "",
  };
}

function makeProfileId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToBase64Url(bytes).toLowerCase();
}

function getSubscriptionOptions(source = {}, fallback = {}) {
  const geoSource =
    source.geoAutoUpdate ?? source.geo ?? source.geox ?? fallback.geoAutoUpdate;
  const intervalSource =
    source.geoUpdateInterval ?? source.geoInterval ?? fallback.geoUpdateInterval;

  return {
    geoAutoUpdate: requestFlag(geoSource, fallback.geoAutoUpdate ?? true),
    geoUpdateInterval: parsePositiveInt(intervalSource, fallback.geoUpdateInterval ?? 24),
    enableProfileSync: requestFlag(
      source.enableProfileSync ?? fallback.enableProfileSync,
      fallback.enableProfileSync ?? false,
    ),
  };
}

function getUrlSubscriptionOptions(request, fallback = {}) {
  const url = new URL(request.url);
  return getSubscriptionOptions(
    {
      geoAutoUpdate: url.searchParams.get("geoAutoUpdate"),
      geo: url.searchParams.get("geo"),
      geox: url.searchParams.get("geox"),
      geoUpdateInterval: url.searchParams.get("geoUpdateInterval"),
      geoInterval: url.searchParams.get("geoInterval"),
    },
    fallback,
  );
}

function getRequestAccessKey(request, body = {}) {
  const url = new URL(request.url);
  const bearer = request.headers.get("Authorization") || "";
  return (
    url.searchParams.get("key") ||
    request.headers.get("x-access-key") ||
    body.accessKey ||
    (bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7) : "")
  );
}

function assertAccessAllowed(request, env, body = {}) {
  if (!env.ACCESS_KEY) return;
  const provided = getRequestAccessKey(request, body);
  if (provided !== env.ACCESS_KEY) {
    throw new HttpError(401, "invalid access key");
  }
}

async function parseJsonBody(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid json body");
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function loginFlyBird(email, password) {
  const form = new URLSearchParams();
  form.set("email", email);
  form.set("password", password);

  const resp = await fetchWithTimeout(
    LOGIN_URL,
    {
      method: "POST",
      headers: {
        ...LOGIN_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
    20000,
  );
  const text = await resp.text();
  if (!resp.ok) {
    throw new HttpError(502, `login upstream ${resp.status}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new HttpError(502, "login upstream returned invalid JSON"); }
  if (data?.status !== "success") {
    throw new HttpError(401, "login failed");
  }

  const token = data.data?.token;
  const authData = data.data?.auth_data;
  if (!token || !authData) {
    throw new HttpError(502, "login response missing token/auth_data");
  }
  return { token, authData };
}

export async function getSubscribeInfo(authData) {
  const resp = await fetchWithTimeout(
    USER_SUB_INFO_URL,
    {
      headers: {
        ...USER_INFO_HEADERS,
        Authorization: `Bearer ${authData}`,
      },
    },
    20000,
  );
  const text = await resp.text();
  if (!resp.ok) {
    throw new HttpError(502, `subscribe info upstream ${resp.status}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new HttpError(502, "subscribe info upstream returned invalid JSON"); }
  if (data?.status !== "success") {
    throw new HttpError(502, "subscribe info failed");
  }
  return data.data || {};
}

export async function downloadClashYaml(token, env = {}) {
  const urls = buildSubscriptionUrls(token, env);
  const failures = [];
  for (const url of urls) {
    try {
      return await downloadClashYamlFromUrl(url, env);
    } catch (err) {
      failures.push(err instanceof HttpError ? err.message : "clash upstream request failed");
    }
  }

  throw new HttpError(502, `all clash upstreams failed: ${failures.join(" | ")}`);
}

function buildSubscriptionUrls(source, env = {}, hintedUrls = []) {
  const input =
    typeof source === "object" && source !== null
      ? {
          token: source.token || "",
          subscriptionUrl: source.subscriptionUrl || "",
        }
      : parseSubscriptionInput(source);
  const token = input.token || extractSubscriptionToken(input.subscriptionUrl);
  const urls = [];

  if (input.subscriptionUrl) {
    urls.push(input.subscriptionUrl);
  }
  for (const hint of hintedUrls) {
    const parsed = parseSubscriptionInput(hint);
    if (parsed.subscriptionUrl) {
      urls.push(parsed.subscriptionUrl);
    }
  }
  if (env.FLYBIRD_SUB_URL_TEMPLATE) {
    urls.push(formatSubscriptionUrl(env.FLYBIRD_SUB_URL_TEMPLATE, token));
  }
  for (const template of CLASH_SUB_URL_CANDIDATES) {
    urls.push(formatSubscriptionUrl(template, token));
  }

  return [...new Set(urls.filter(Boolean))];
}

async function resolveWorkingSubscriptionSource(token, env = {}, hintedUrls = []) {
  const failures = [];
  for (const url of buildSubscriptionUrls({ token }, env, hintedUrls)) {
    try {
      await downloadClashYamlFromUrl(url, env);
      return {
        token,
        subscriptionUrl: url,
      };
    } catch (err) {
      failures.push(err instanceof HttpError ? err.message : "clash upstream request failed");
    }
  }

  throw new HttpError(
    502,
    `could not resolve a working subscription url: ${failures.join(" | ")}`,
  );
}

function formatSubscriptionUrl(template, token) {
  if (!template || !token) return "";
  if (String(template).includes("{token}")) {
    return String(template).replace("{token}", encodeURIComponent(token));
  }
  const url = new URL(String(template));
  url.searchParams.set("token", token);
  return url.toString();
}

async function downloadClashYamlFromUrl(url, env = {}) {
  const resp = await fetchWithTimeout(
    url,
    {
      headers: CLASH_HEADERS,
      cf: {
        cacheTtl: 0,
        cacheEverything: false,
      },
    },
    30000,
  );
  const text = await resp.text();
  if (!resp.ok) {
    throw new HttpError(502, `clash upstream ${resp.status} at ${new URL(url).host}`);
  }

  const plaintext = looksLikeMihomoYaml(text);
  if (!plaintext && looksLikeHtml(text, resp.headers.get("Content-Type"))) {
    throw new HttpError(
      502,
      `clash upstream returned html instead of subscription yaml at ${new URL(url).host}`,
    );
  }

  const clashYaml = plaintext ? text : await decryptProfile(
    text,
    env.PROFILE_AES_KEY || DEFAULT_PROFILE_KEY,
    env.PROFILE_AES_IV || DEFAULT_PROFILE_IV,
  );
  validateProxyEntries(extractProxiesBlock(clashYaml));
  return clashYaml;
}

export function looksLikeMihomoYaml(text) {
  return /(^|\n)\s*proxies:\s*(\n|$)/.test(text) || /(^|\n)\s*proxy-groups:\s*(\n|$)/.test(text);
}

function looksLikeHtml(text, contentType = "") {
  return (
    String(contentType || "").toLowerCase().includes("text/html") ||
    /^\s*<!doctype\s+html/i.test(text) ||
    /^\s*<html[\s>]/i.test(text)
  );
}

export async function decryptProfile(ciphertext, keyAscii, ivAscii) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyAscii),
    { name: "AES-CBC", length: 128 },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-CBC",
      iv: enc.encode(ivAscii),
    },
    key,
    base64ToBytes(ciphertext),
  );

  const inner = dec.decode(plain).trim();
  try {
    return base64DecodeUtf8(inner);
  } catch {
    return inner;
  }
}

export function extractProxiesBlock(clashYaml) {
  const lines = clashYaml.split(/\r?\n/);
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "proxies:") {
      start = i;
      continue;
    }
    if (
      start >= 0 &&
      i > start &&
      line.trim() &&
      !/^\s/.test(line) &&
      /^[A-Za-z0-9_-]+:/.test(line)
    ) {
      end = i;
      break;
    }
  }

  if (start < 0) {
    throw new HttpError(422, "missing proxies section");
  }
  return lines.slice(start, end);
}

export function extractProxyDicts(proxyLines) {
  const proxies = [];
  for (const line of proxyLines) {
    const stripped = line.trim();
    if (!stripped || stripped === "proxies:" || stripped.startsWith("#")) continue;
    if (!stripped.startsWith("- {")) {
      throw new HttpError(422, "proxy entries must use single-line JSON objects");
    }
    try {
      proxies.push(JSON.parse(stripped.slice(2).trim()));
    } catch {
      throw new HttpError(422, "invalid proxy entry JSON");
    }
  }
  return proxies;
}

function validateProxyEntries(proxyLines) {
  const proxies = extractProxyDicts(proxyLines);
  if (!proxies.length) throw new HttpError(422, "subscription has no proxy entries");
  if (proxies.some((proxy) => !proxy || typeof proxy.name !== "string" || !proxy.name.trim()
    || typeof proxy.type !== "string" || !proxy.type.trim()
    || typeof proxy.server !== "string" || !proxy.server.trim()
    || !Number.isInteger(Number(proxy.port)) || Number(proxy.port) < 1 || Number(proxy.port) > 65535)) {
    throw new HttpError(422, "subscription contains an incomplete proxy entry");
  }
  return proxies;
}

function cleanParams(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "boolean") {
      out.set(key, value ? "1" : "0");
    } else if (Array.isArray(value)) {
      out.set(key, value.join(","));
    } else {
      out.set(key, String(value));
    }
  }
  return out.toString();
}

function nested(obj, key) {
  return obj && typeof obj === "object" ? obj[key] : undefined;
}

function getNetworkPath(proxy) {
  const wsOpts = proxy["ws-opts"] || {};
  const httpOpts = proxy["http-opts"] || {};
  const grpcOpts = proxy["grpc-opts"] || {};
  return (
    proxy["ws-path"] ||
    wsOpts.path ||
    proxy["http-path"] ||
    httpOpts.path ||
    proxy.path ||
    grpcOpts.path ||
    ""
  );
}

function getNetworkHost(proxy) {
  const wsOpts = proxy["ws-opts"] || {};
  const wsHeaders = proxy["ws-headers"] || {};
  const headers = wsOpts.headers || {};
  const httpOpts = proxy["http-opts"] || {};
  return (
    wsHeaders.Host ||
    headers.Host ||
    httpOpts.host ||
    proxy.host ||
    ""
  );
}

function buildVmessLink(proxy) {
  const vmess = {
    v: "2",
    ps: proxy.name || "Unnamed",
    add: proxy.server,
    port: String(proxy.port),
    id: proxy.uuid,
    aid: String(proxy.alterId || 0),
    scy: proxy.cipher || "auto",
    net: proxy.network || "tcp",
    type: "none",
    host: getNetworkHost(proxy),
    path: getNetworkPath(proxy),
    tls: proxy.tls ? "tls" : "",
    sni: proxy.servername || "",
  };
  return `vmess://${base64EncodeUtf8(JSON.stringify(vmess))}`;
}

function buildVlessLink(proxy) {
  const query = cleanParams({
    type: proxy.network || "tcp",
    security: proxy.tls ? "tls" : "none",
    encryption: proxy.encryption || "none",
    flow: proxy.flow,
    sni: proxy.servername || proxy.sni,
    host: getNetworkHost(proxy),
    path: getNetworkPath(proxy),
    serviceName:
      proxy["grpc-service-name"] || nested(proxy["grpc-opts"], "grpc-service-name"),
    fp: proxy["client-fingerprint"],
    alpn: proxy.alpn,
    pbk: nested(proxy["reality-opts"], "public-key"),
    sid: nested(proxy["reality-opts"], "short-id"),
    spx: nested(proxy["reality-opts"], "spider-x"),
    allowInsecure: proxy["skip-cert-verify"],
  });
  const suffix = query ? `?${query}` : "";
  return `vless://${proxy.uuid}@${proxy.server}:${proxy.port}${suffix}#${encodeURIComponent(
    proxy.name || "Unnamed",
  )}`;
}

function buildTrojanLink(proxy) {
  const query = cleanParams({
    type: proxy.network || "tcp",
    security: proxy.tls === false ? "none" : "tls",
    sni: proxy.sni || proxy.servername,
    host: getNetworkHost(proxy),
    path: getNetworkPath(proxy),
    serviceName:
      proxy["grpc-service-name"] || nested(proxy["grpc-opts"], "grpc-service-name"),
    fp: proxy["client-fingerprint"],
    alpn: proxy.alpn,
    allowInsecure: proxy["skip-cert-verify"],
  });
  const suffix = query ? `?${query}` : "";
  return `trojan://${proxy.password}@${proxy.server}:${proxy.port}${suffix}#${encodeURIComponent(
    proxy.name || "Unnamed",
  )}`;
}

function buildSsLink(proxy) {
  const userinfo = base64EncodeUtf8(`${proxy.cipher}:${proxy.password}`);
  return `ss://${userinfo}@${proxy.server}:${proxy.port}#${encodeURIComponent(
    proxy.name || "Unnamed",
  )}`;
}

export function convertProxyToLink(proxy) {
  const type = String(proxy.type || "").toLowerCase();
  if (type === "vmess") return buildVmessLink(proxy);
  if (type === "vless") return buildVlessLink(proxy);
  if (type === "trojan") return buildTrojanLink(proxy);
  if (type === "ss") return buildSsLink(proxy);
  return null;
}

export function convertClashYamlToLinks(clashYaml) {
  const proxies = extractProxyDicts(extractProxiesBlock(clashYaml));
  return proxies
    .map((proxy) => {
      try {
        return convertProxyToLink(proxy);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function linksToBase64Subscription(links) {
  return base64EncodeUtf8(links.join("\n"));
}

function getPreambleBeforeProxies(clashYaml) {
  const lines = clashYaml.split(/\r?\n/);
  const proxyIndex = lines.findIndex((line) => line.trim() === "proxies:");
  const preamble = proxyIndex < 0 ? [] : lines.slice(0, proxyIndex);
  const dropRootKeys = new Set([
    "geodata-mode",
    "geo-auto-update",
    "geo-update-interval",
    "geox-url",
    "rule-providers",
  ]);

  const filtered = [];
  let skippingBlock = null;
  for (const line of preamble) {
    const rootMatch = line.match(/^([A-Za-z0-9_-]+):/);
    if (rootMatch) {
      skippingBlock = dropRootKeys.has(rootMatch[1]) ? rootMatch[1] : null;
      if (skippingBlock) continue;
    }
    if (skippingBlock) {
      if (/^\s/.test(line) || !line.trim()) continue;
      skippingBlock = null;
    }
    filtered.push(line);
  }
  return filtered.join("\n").trimEnd();
}

function quoteYaml(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlScalar(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => quoteYaml(item)).join(",")}]`;
  return quoteYaml(value);
}

function flowMap(obj) {
  const pairs = Object.entries(obj).map(
    ([key, value]) => `${key}: ${yamlScalar(value)}`,
  );
  return `{ ${pairs.join(", ")} }`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function namesMatching(names, patterns) {
  const matched = names.filter((name) =>
    patterns.some((pattern) => pattern.test(name)),
  );
  return matched.length ? matched : names;
}

function buildProxyGroups(proxyNames) {
  const all = proxyNames.length ? proxyNames : ["DIRECT"];
  const hk = namesMatching(all, [/Hong Kong/i, /\bHK\b/i, /香港/]);
  const tw = namesMatching(all, [/Taiwan/i, /\bTW\b/i, /台湾/, /台灣/]);
  const sg = namesMatching(all, [/Singapore/i, /\bSG\b/i, /新加坡/]);
  const jp = namesMatching(all, [/Japan/i, /\bJP\b/i, /日本/]);
  const us = namesMatching(all, [/USA/i, /United States/i, /\bUS\b/i, /美国/, /美國/]);

  const selectTargets = unique([
    "自动选择",
    "故障转移",
    "香港节点",
    "台湾节点",
    "新加坡节点",
    "日本节点",
    "美国节点",
    "DIRECT",
    ...all,
  ]);

  const groups = [
    { name: "节点选择", type: "select", proxies: selectTargets },
    {
      name: "自动选择",
      type: "url-test",
      proxies: all,
      url: "http://www.gstatic.com/generate_204",
      interval: 600,
      tolerance: 50,
      lazy: true,
    },
    {
      name: "故障转移",
      type: "fallback",
      proxies: all,
      url: "http://www.gstatic.com/generate_204",
      interval: 300,
      lazy: true,
    },
    { name: "香港节点", type: "url-test", proxies: hk, url: "http://www.gstatic.com/generate_204", interval: 600, lazy: true },
    { name: "台湾节点", type: "url-test", proxies: tw, url: "http://www.gstatic.com/generate_204", interval: 600, lazy: true },
    { name: "新加坡节点", type: "url-test", proxies: sg, url: "http://www.gstatic.com/generate_204", interval: 600, lazy: true },
    { name: "日本节点", type: "url-test", proxies: jp, url: "http://www.gstatic.com/generate_204", interval: 600, lazy: true },
    { name: "美国节点", type: "url-test", proxies: us, url: "http://www.gstatic.com/generate_204", interval: 600, lazy: true },
    { name: "国外媒体", type: "select", proxies: ["节点选择", "自动选择", "故障转移", "DIRECT", ...all] },
    { name: "AI服务", type: "select", proxies: ["节点选择", "美国节点", "日本节点", "新加坡节点", "DIRECT", ...all] },
    { name: "电报消息", type: "select", proxies: ["节点选择", "自动选择", "故障转移", "DIRECT", ...all] },
    { name: "微软服务", type: "select", proxies: ["DIRECT", "节点选择", "自动选择", ...all] },
    { name: "苹果服务", type: "select", proxies: ["DIRECT", "节点选择", "自动选择", ...all] },
    { name: "游戏平台", type: "select", proxies: ["节点选择", "自动选择", "DIRECT", ...all] },
    { name: "漏网之鱼", type: "select", proxies: ["节点选择", "自动选择", "故障转移", "DIRECT", ...all] },
  ];

  return ["proxy-groups:", ...groups.map((group) => `  - ${flowMap(group)}`)].join("\n");
}

function buildRules() {
  return [
    "rules:",
    "  - DOMAIN-SUFFIX,intranet.example,DIRECT",
    "  - DOMAIN-SUFFIX,office.example,DIRECT",
    "  - GEOSITE,private,DIRECT",
    "  - GEOIP,private,DIRECT,no-resolve",
    "  - GEOSITE,category-ads-all,REJECT",
    "  - GEOSITE,telegram,电报消息",
    "  - GEOIP,telegram,电报消息,no-resolve",
    "  - GEOSITE,openai,AI服务",
    "  - GEOSITE,github,节点选择",
    "  - GEOSITE,youtube,国外媒体",
    "  - GEOSITE,netflix,国外媒体",
    "  - GEOSITE,disney,国外媒体",
    "  - GEOSITE,microsoft,微软服务",
    "  - GEOSITE,apple,苹果服务",
    "  - GEOSITE,steam,游戏平台",
    "  - GEOSITE,geolocation-!cn,节点选择",
    "  - GEOSITE,cn,DIRECT",
    "  - GEOIP,CN,DIRECT,no-resolve",
    "  - MATCH,漏网之鱼",
  ].join("\n");
}

function buildGeoxConfig(workerBaseUrl, options = {}) {
  return [
    "geodata-mode: true",
    `geo-auto-update: ${options.geoAutoUpdate === false ? "false" : "true"}`,
    `geo-update-interval: ${parsePositiveInt(options.geoUpdateInterval, 24)}`,
    "geox-url:",
    `  geoip: "${workerBaseUrl}/rules/geoip.dat"`,
    `  geosite: "${workerBaseUrl}/rules/geosite.dat"`,
    `  mmdb: "${workerBaseUrl}/rules/country.mmdb"`,
    `  asn: "${workerBaseUrl}/rules/GeoLite2-ASN.mmdb"`,
  ].join("\n");
}

export function enhanceMihomoConfig(clashYaml, workerBaseUrl, options = {}) {
  const proxyLines = extractProxiesBlock(clashYaml);
  const proxies = extractProxyDicts(proxyLines);
  const proxyNames = proxies.map((proxy) => proxy.name || "Unnamed");
  const preamble = getPreambleBeforeProxies(clashYaml);

  return [
    preamble,
    buildGeoxConfig(workerBaseUrl, options),
    proxyLines.join("\n").trimEnd(),
    buildProxyGroups(proxyNames),
    buildRules(),
    "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

async function credentialKey(secret) {
  if (!secret || String(secret).length < 12) {
    throw new HttpError(500, "LINK_SECRET is missing or too short");
  }
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCredentialToken(credentials, secret) {
  const key = await credentialKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payloadData = {
    createdAt: new Date().toISOString(),
  };
  const subscription = parseSubscriptionInput(
    credentials.subscriptionUrl || credentials.token,
  );
  if (subscription.token) {
    payloadData.token = subscription.token;
    if (subscription.subscriptionUrl) {
      payloadData.subscriptionUrl = subscription.subscriptionUrl;
    }
  } else {
    payloadData.email = credentials.email;
    payloadData.password = credentials.password;
  }
  const payload = enc.encode(JSON.stringify(payloadData));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload),
  );
  const token = new Uint8Array(1 + iv.length + encrypted.length);
  token[0] = 1;
  token.set(iv, 1);
  token.set(encrypted, 1 + iv.length);
  return bytesToBase64Url(token);
}

export async function decryptCredentialToken(token, secret) {
  const bytes = base64UrlToBytes(token);
  if (bytes[0] !== 1 || bytes.length < 30) {
    throw new HttpError(400, "invalid credential token");
  }
  const key = await credentialKey(secret);
  const iv = bytes.slice(1, 13);
  const ciphertext = bytes.slice(13);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(dec.decode(plain));
}

export function buildDistributionLinks(workerBaseUrl, options = {}) {
  const params = new URLSearchParams();
  if (options.accessKey) params.set("key", options.accessKey);
  if (options.credentialToken) params.set("cred", options.credentialToken);
  if (options.subscriptionToken) {
    params.set("token", extractSubscriptionToken(options.subscriptionToken));
  }
  if (!options.profileId) {
    if (options.geoAutoUpdate === false) params.set("geoAutoUpdate", "false");
    if (options.geoUpdateInterval && options.geoUpdateInterval !== 24) {
      params.set("geoUpdateInterval", String(options.geoUpdateInterval));
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const basePath = options.profileId
    ? `${workerBaseUrl}/p/${encodeURIComponent(options.profileId)}`
    : workerBaseUrl;

  return {
    clash: `${basePath}/sub${suffix}`,
    clashFull: `${basePath}/sub/clash${suffix}`,
    rawClash: `${basePath}/sub/raw${suffix}`,
    nodes: `${basePath}/sub/nodes${suffix}`,
    plainLinks: `${basePath}/sub/links${suffix}`,
    v2rayn: `${basePath}/sub/base64${suffix}`,
    meta: `${basePath}/sub/meta${suffix}`,
    rulesGeoip: `${workerBaseUrl}/rules/geoip.dat`,
    rulesGeosite: `${workerBaseUrl}/rules/geosite.dat`,
  };
}

export function buildMetaRulesAssetUrl(asset) {
  if (!SUPPORTED_RULE_ASSETS.has(asset)) {
    throw new HttpError(404, `Unsupported rules asset: ${asset}`);
  }
  return `${META_RULES_BASE}/${asset}`;
}

function getProfileKey(profileId) {
  return `profile:${profileId}`;
}

function assertValidProfileId(profileId) {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(String(profileId || ""))) {
    throw new HttpError(400, "invalid profile id");
  }
}

async function readProfile(env, profileId) {
  if (!env.SUB_CACHE) {
    throw new HttpError(500, "SUB_CACHE KV binding is required for profile links");
  }
  assertValidProfileId(profileId);
  const text = await env.SUB_CACHE.get(getProfileKey(profileId));
  if (!text) throw new HttpError(404, "profile not found");
  return JSON.parse(text);
}

async function writeProfile(env, profile) {
  if (!env.SUB_CACHE) {
    throw new HttpError(500, "SUB_CACHE KV binding is required for profile storage");
  }
  assertValidProfileId(profile.id);
  await env.SUB_CACHE.put(
    getProfileKey(profile.id),
    JSON.stringify(profile, null, 2),
  );
}

async function listProfiles(env) {
  if (!env.SUB_CACHE) return [];
  const result = await env.SUB_CACHE.list({ prefix: "profile:" });
  const profiles = [];
  for (const key of result.keys || []) {
    const text = await env.SUB_CACHE.get(key.name);
    if (!text) continue;
    try {
      profiles.push(JSON.parse(text));
    } catch {
      // Ignore corrupt profile records so one bad entry does not block cron.
    }
  }
  return profiles;
}

async function resolveCredentials(request, env, profile = null) {
  const url = new URL(request.url);
  const queryToken = extractSubscriptionToken(url.searchParams.get("token"));
  if (queryToken) {
    return {
      token: queryToken,
      source: "token-query",
    };
  }

  const credentialToken = url.searchParams.get("cred");
  if (credentialToken) {
    const credentials = await decryptCredentialToken(credentialToken, env.LINK_SECRET);
    return normalizeCredentials(credentials, "credential-token");
  }

  if (profile?.credentialToken) {
    const credentials = await decryptCredentialToken(profile.credentialToken, env.LINK_SECRET);
    return normalizeCredentials(credentials, "profile-token");
  }

  const envSubscription = parseSubscriptionInput(env.FLYBIRD_TOKEN);
  if (envSubscription.token) {
    return {
      token: envSubscription.token,
      subscriptionUrl: envSubscription.subscriptionUrl,
      source: "worker-token",
    };
  }

  if (env.FLYBIRD_EMAIL && env.FLYBIRD_PASSWORD) {
    return {
      email: env.FLYBIRD_EMAIL,
      password: env.FLYBIRD_PASSWORD,
      source: "worker-secret",
    };
  }

  throw new HttpError(400, "missing credentials: use token=, cred=, or configure FLYBIRD_TOKEN/FLYBIRD_EMAIL/FLYBIRD_PASSWORD");
}

function normalizeCredentials(credentials, source) {
  const subscription = parseSubscriptionInput(
    credentials.subscriptionUrl || credentials.token,
  );
  if (subscription.token) {
    return {
      token: subscription.token,
      subscriptionUrl: subscription.subscriptionUrl,
      source,
    };
  }

  if (credentials.email && credentials.password) {
    return {
      email: credentials.email,
      password: credentials.password,
      source,
    };
  }

  throw new HttpError(400, "invalid credential token payload");
}

async function loadSubscription(request, env, profile = null) {
  assertAccessAllowed(request, env);
  const credentials = await resolveCredentials(request, env, profile);
  let login = null;
  let subscriptionToken = credentials.token;
  if (!subscriptionToken) {
    login = await loginFlyBird(credentials.email, credentials.password);
    subscriptionToken = login.token;
  }
  const clashYaml = await downloadClashYaml(
    {
      token: subscriptionToken,
      subscriptionUrl: credentials.subscriptionUrl,
    },
    env,
  );
  return {
    credentials,
    login,
    clashYaml,
  };
}

async function handleCreateLinks(request, env) {
  const body = await parseJsonBody(request);
  assertAccessAllowed(request, env, body);

  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email || !password) {
    throw new HttpError(400, "email and password are required");
  }

  const login = await loginFlyBird(email, password);
  const subInfo = await getSubscribeInfo(login.authData);
  const subscriptionSource = await resolveWorkingSubscriptionSource(login.token, env, [
    subInfo.subscribe_url,
    subInfo.subscription_url,
  ]);
  const credentialToken = await encryptCredentialToken(subscriptionSource, env.LINK_SECRET);
  const options = getSubscriptionOptions(body, {
    geoAutoUpdate: true,
    geoUpdateInterval: 24,
    enableProfileSync: false,
  });
  const shouldStoreProfile = requestFlag(body.storeProfile, false);
  let profile = {
    stored: false,
  };

  let profileId = "";
  if (shouldStoreProfile) {
    if (!env.SUB_CACHE) {
      throw new HttpError(400, "storeProfile requires SUB_CACHE KV binding");
    }
    profileId = makeProfileId();
    const now = new Date().toISOString();
    await writeProfile(env, {
      id: profileId,
      credentialToken,
      baseUrl: getWorkerBaseUrl(request),
      options,
      createdAt: now,
      updatedAt: now,
      cache: null,
    });
    profile = {
      stored: true,
      id: profileId,
      enableProfileSync: options.enableProfileSync,
    };
  }

  const links = buildDistributionLinks(getWorkerBaseUrl(request), {
    accessKey: env.ACCESS_KEY || body.accessKey || "",
    credentialToken: shouldStoreProfile ? "" : credentialToken,
    profileId,
    geoAutoUpdate: options.geoAutoUpdate,
    geoUpdateInterval: options.geoUpdateInterval,
  });

  return jsonResponse({
    email,
    links,
    profile,
    subscribe: {
      subscribe_url: subInfo.subscribe_url,
      subscription_url: subInfo.subscription_url,
    },
  });
}

async function handleCreateTokenLinks(request, env) {
  const body = await parseJsonBody(request);
  assertAccessAllowed(request, env, body);

  const subscription = parseSubscriptionInput(
    body.subscriptionUrl || body.url || body.token || body.subscriptionToken,
  );
  if (!subscription.token) {
    throw new HttpError(400, "token is required");
  }

  const credentialToken = await encryptCredentialToken(subscription, env.LINK_SECRET);
  const options = getSubscriptionOptions(body, {
    geoAutoUpdate: true,
    geoUpdateInterval: 24,
    enableProfileSync: false,
  });
  const shouldStoreProfile = requestFlag(body.storeProfile, false);
  let profile = {
    stored: false,
  };

  let profileId = "";
  if (shouldStoreProfile) {
    if (!env.SUB_CACHE) {
      throw new HttpError(400, "storeProfile requires SUB_CACHE KV binding");
    }
    profileId = makeProfileId();
    const now = new Date().toISOString();
    await writeProfile(env, {
      id: profileId,
      credentialToken,
      baseUrl: getWorkerBaseUrl(request),
      options,
      createdAt: now,
      updatedAt: now,
      cache: null,
    });
    profile = {
      stored: true,
      id: profileId,
      enableProfileSync: options.enableProfileSync,
    };
  }

  const links = buildDistributionLinks(getWorkerBaseUrl(request), {
    accessKey: env.ACCESS_KEY || body.accessKey || "",
    credentialToken: shouldStoreProfile ? "" : credentialToken,
    profileId,
    geoAutoUpdate: options.geoAutoUpdate,
    geoUpdateInterval: options.geoUpdateInterval,
  });

  return jsonResponse({
    tokenSource: "token",
    links,
    profile,
  });
}

async function readExistingProfileOrNull(env, profileId) {
  if (!profileId) return null;
  try {
    return await readProfile(env, profileId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

async function handleUploadCache(request, env) {
  const body = await parseJsonBody(request);
  assertAccessAllowed(request, env, body);
  if (!env.SUB_CACHE) {
    throw new HttpError(400, "SUB_CACHE KV binding is required for cache upload");
  }

  const clashYaml = String(body.clashYaml || body.yaml || body.content || "");
  if (!clashYaml.trim()) {
    throw new HttpError(400, "clashYaml is required");
  }

  const url = new URL(request.url);
  const requestedProfileId = String(
    body.profileId || url.searchParams.get("profileId") || "",
  ).trim();
  const profileId = requestedProfileId || makeProfileId();
  assertValidProfileId(profileId);

  const existing = await readExistingProfileOrNull(env, profileId);
  const options = getSubscriptionOptions(body, {
    ...(existing?.options || {}),
    geoAutoUpdate: existing?.options?.geoAutoUpdate ?? true,
    geoUpdateInterval: existing?.options?.geoUpdateInterval ?? 24,
    enableProfileSync: false,
  });
  const baseUrl = String(body.baseUrl || existing?.baseUrl || getWorkerBaseUrl(request));
  const cache = buildSubscriptionCache(clashYaml, baseUrl, options);
  const now = new Date().toISOString();

  await writeProfile(env, {
    ...(existing || {}),
    id: profileId,
    baseUrl,
    options,
    cache,
    cacheOnly: true,
    source: "manual-cache",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastError: null,
  });

  const links = buildDistributionLinks(getWorkerBaseUrl(request), {
    accessKey: env.ACCESS_KEY || body.accessKey || "",
    profileId,
  });
  links.clash = links.rawClash;

  return jsonResponse({
    links,
    profile: {
      stored: true,
      id: profileId,
      cacheOnly: true,
      nodeCount: cache.nodeCount,
      linkCount: cache.linkCount,
      syncedAt: cache.syncedAt,
    },
  });
}

function buildSubscriptionCache(clashYaml, baseUrl, options = {}) {
  const proxyLines = extractProxiesBlock(clashYaml);
  const proxies = validateProxyEntries(proxyLines);
  const enhancedClash = enhanceMihomoConfig(clashYaml, baseUrl, options);
  const links = convertClashYamlToLinks(clashYaml);

  return {
    rawClash: clashYaml,
    enhancedClash,
    nodes: proxyLines.join("\n") + "\n",
    links: links.join("\n") + "\n",
    base64: linksToBase64Subscription(links) + "\n",
    nodeCount: proxies.length,
    linkCount: links.length,
    syncedAt: new Date().toISOString(),
  };
}

async function refreshProfileCache(profile, env, baseUrl) {
  const credentials = normalizeCredentials(
    await decryptCredentialToken(profile.credentialToken, env.LINK_SECRET),
    "profile-token",
  );
  let subscriptionToken = credentials.token;
  if (!subscriptionToken) {
    const login = await loginFlyBird(credentials.email, credentials.password);
    subscriptionToken = login.token;
  }
  const clashYaml = await downloadClashYaml(
    {
      token: subscriptionToken,
      subscriptionUrl: credentials.subscriptionUrl,
    },
    env,
  );
  const options = getSubscriptionOptions(profile.options || {}, {
    geoAutoUpdate: true,
    geoUpdateInterval: 24,
    enableProfileSync: false,
  });
  return buildSubscriptionCache(clashYaml, baseUrl, options);
}

function isCacheOnlyProfile(profile) {
  return Boolean(profile?.cache && (profile.cacheOnly || !profile.credentialToken));
}

function cachedProfileResponse(profile, mode, options = {}) {
  const cache = profile?.cache;
  if (!cache) throw new HttpError(503, "profile cache is empty");

  if (mode === "clash" && cache.enhancedClash) {
    return new Response(cache.enhancedClash, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Cache-Control": "no-store",
        "profile-update-interval": String(options.geoUpdateInterval || 24),
        "X-Subscription-Cache": "HIT",
      },
    });
  }
  if (mode === "raw" && cache.rawClash) {
    return new Response(cache.rawClash, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Subscription-Cache": "HIT",
      },
    });
  }
  if (mode === "nodes" && cache.nodes) {
    return new Response(cache.nodes, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Subscription-Cache": "HIT",
      },
    });
  }
  if (mode === "links" && cache.links) {
    return textResponse(cache.links, {
      headers: { "X-Subscription-Cache": "HIT" },
    });
  }
  if (mode === "base64" && cache.base64) {
    return textResponse(cache.base64, {
      headers: { "X-Subscription-Cache": "HIT" },
    });
  }
  if (mode === "meta") {
    return jsonResponse({
      email: null,
      credentialSource: profile.cacheOnly ? "cache-only" : "profile-cache",
      profileId: profile.id || null,
      nodeCount: cache.nodeCount || 0,
      linkCount: cache.linkCount || 0,
      options,
      cache: {
        hit: true,
        cacheOnly: Boolean(profile.cacheOnly),
        syncedAt: cache.syncedAt || null,
      },
    });
  }

  throw new HttpError(404, "not found");
}

async function handleSubRequest(request, env, mode, profile = null) {
  const baseUrl = getWorkerBaseUrl(request);
  const options = getUrlSubscriptionOptions(request, profile?.options || {});
  let loaded;

  if (isCacheOnlyProfile(profile)) {
    assertAccessAllowed(request, env);
    return cachedProfileResponse(profile, mode, options);
  }

  try {
    loaded = await loadSubscription(request, env, profile);
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) throw err;
    if (!profile?.cache) throw err;
    return cachedProfileResponse(profile, mode, options);
  }

  const { credentials, login, clashYaml } = loaded;

  if (mode === "raw") {
    return new Response(clashYaml, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (mode === "clash") {
    return new Response(enhanceMihomoConfig(clashYaml, baseUrl, options), {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Cache-Control": "no-store",
        "profile-update-interval": String(options.geoUpdateInterval),
      },
    });
  }

  if (mode === "nodes") {
    return new Response(extractProxiesBlock(clashYaml).join("\n") + "\n", {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (mode === "links" || mode === "base64") {
    const links = convertClashYamlToLinks(clashYaml);
    const body = mode === "base64" ? linksToBase64Subscription(links) : links.join("\n");
    return textResponse(body + "\n");
  }

  if (mode === "meta") {
    const subInfo = login?.authData ? await getSubscribeInfo(login.authData) : {};
    const proxies = extractProxyDicts(extractProxiesBlock(clashYaml));
    const links = convertClashYamlToLinks(clashYaml);
    return jsonResponse({
      email: credentials.email || null,
      credentialSource: credentials.source,
      profileId: profile?.id || null,
      nodeCount: proxies.length,
      linkCount: links.length,
      options,
      subscribe: {
        subscribe_url: subInfo.subscribe_url,
        subscription_url: subInfo.subscription_url,
      },
      rules: {
        geoip: `${baseUrl}/rules/geoip.dat`,
        geosite: `${baseUrl}/rules/geosite.dat`,
      },
    });
  }

  throw new HttpError(404, "not found");
}

async function handleRulesAsset(request, env, ctx, asset) {
  const upstreamUrl = buildMetaRulesAssetUrl(asset);
  const cacheSeconds = Number(env.RULES_CACHE_SECONDS || 86400);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(upstreamUrl);

  if (cache && request.method === "GET") {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const upstream = await fetch(upstreamUrl, {
    cf: {
      cacheEverything: true,
      cacheTtl: cacheSeconds,
    },
  });
  if (!upstream.ok) {
    throw new HttpError(502, `rules upstream ${upstream.status}`);
  }

  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", `public, max-age=${cacheSeconds}`);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("X-Rules-Source", upstreamUrl);

  const response = new Response(upstream.body, {
    status: upstream.status,
    headers,
  });

  if (cache && ctx?.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

function renderPage(workerBaseUrl) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlyingBird CF 订阅分发</title>
<style>
:root {
  color-scheme: light;
  --bg: #f5f7f3;
  --ink: #17201a;
  --muted: #647067;
  --line: #d8ded5;
  --panel: #ffffff;
  --accent: #0f766e;
  --accent-dark: #115e59;
  --danger: #b42318;
  --code: #10231f;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 28px 0 40px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 16px;
  margin-bottom: 22px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 18px;
}
h1 {
  margin: 0;
  font-size: clamp(26px, 4vw, 42px);
  line-height: 1.05;
  letter-spacing: 0;
}
.status {
  color: var(--muted);
  font-size: 13px;
  text-align: right;
}
.layout {
  display: grid;
  grid-template-columns: minmax(280px, 380px) 1fr;
  gap: 18px;
  align-items: start;
}
section {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 18px;
}
h2 {
  margin: 0 0 14px;
  font-size: 16px;
  letter-spacing: 0;
}
label {
  display: block;
  margin: 14px 0 6px;
  color: var(--muted);
  font-size: 13px;
}
input {
  width: 100%;
  height: 42px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 12px;
  color: var(--ink);
  background: #fbfcfa;
  font: inherit;
}
input:focus, button:focus, textarea:focus {
  outline: 2px solid color-mix(in srgb, var(--accent), white 35%);
  outline-offset: 2px;
}
button {
  border: 0;
  border-radius: 6px;
  min-height: 40px;
  padding: 0 13px;
  background: var(--accent);
  color: white;
  font-weight: 650;
  cursor: pointer;
}
button:hover { background: var(--accent-dark); }
button.secondary {
  background: #e9eee8;
  color: var(--ink);
}
button.secondary:hover { background: #dfe7dd; }
.actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.actions button { flex: 1; }
.options {
  display: grid;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.check-row {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--ink);
  font-size: 13px;
}
.check-row input {
  width: 17px;
  height: 17px;
  padding: 0;
  margin: 0;
}
.inline-field {
  display: grid;
  grid-template-columns: 1fr 90px;
  gap: 10px;
  align-items: center;
}
.inline-field label {
  margin: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.link-row {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  min-width: 0;
}
.link-row strong {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
}
.link-row code {
  display: block;
  min-height: 40px;
  color: var(--code);
  word-break: break-all;
  font-size: 12px;
  line-height: 1.45;
}
.link-row button {
  width: 100%;
  margin-top: 10px;
}
.error {
  margin-top: 12px;
  color: var(--danger);
  font-size: 13px;
  min-height: 18px;
}
.rules {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 840px) {
  header { align-items: start; flex-direction: column; }
  .status { text-align: left; }
  .layout, .grid, .rules { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<main>
  <header>
    <h1>FlyingBird CF 订阅分发</h1>
    <div class="status">MetaCubeX GeoX latest<br>${workerBaseUrl}</div>
  </header>
  <div class="layout">
    <section>
      <h2>来源</h2>
      <label for="token">订阅 token / URL</label>
      <input id="token" autocomplete="off" spellcheck="false">
      <label for="email">Email</label>
      <input id="email" autocomplete="username" inputmode="email">
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password">
      <label for="accessKey">Access key</label>
      <input id="accessKey" type="password">
      <div class="options">
        <label class="check-row" for="storeProfile">
          <input id="storeProfile" type="checkbox">
          <span>保存为 profile 链接</span>
        </label>
        <label class="check-row" for="enableProfileSync">
          <input id="enableProfileSync" type="checkbox">
          <span>定时拉取账号配置</span>
        </label>
        <label class="check-row" for="geoAutoUpdate">
          <input id="geoAutoUpdate" type="checkbox" checked>
          <span>mihomo 自动更新 GeoX</span>
        </label>
        <div class="inline-field">
          <label for="geoUpdateInterval">GeoX 间隔</label>
          <input id="geoUpdateInterval" type="number" min="1" max="168" value="24">
        </div>
      </div>
      <div class="actions">
        <button id="generate">生成链接</button>
        <button class="secondary" id="clear">清空</button>
      </div>
      <div class="error" id="error"></div>
    </section>
    <section>
      <h2>订阅</h2>
      <div class="grid" id="links"></div>
      <div class="rules">
        <div class="link-row">
          <strong>geoip.dat</strong>
          <code>${workerBaseUrl}/rules/geoip.dat</code>
          <button class="secondary" data-copy="${workerBaseUrl}/rules/geoip.dat">复制</button>
        </div>
        <div class="link-row">
          <strong>geosite.dat</strong>
          <code>${workerBaseUrl}/rules/geosite.dat</code>
          <button class="secondary" data-copy="${workerBaseUrl}/rules/geosite.dat">复制</button>
        </div>
      </div>
    </section>
  </div>
</main>
<script>
const linksEl = document.getElementById("links");
const errorEl = document.getElementById("error");
const labels = {
  clash: "mihomo 分流订阅",
  clashFull: "mihomo 完整路径",
  rawClash: "原始 Clash",
  v2rayn: "v2rayN Base64",
  plainLinks: "明文节点链接",
  nodes: "proxies 节点段",
  meta: "订阅元数据"
};

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function renderLinks(links) {
  linksEl.innerHTML = "";
  for (const key of Object.keys(labels)) {
    const value = links[key];
    if (!value) continue;
    const row = document.createElement("div");
    row.className = "link-row";
    row.innerHTML = "<strong>" + labels[key] + "</strong><code></code><button class='secondary'>复制</button>";
    row.querySelector("code").textContent = value;
    row.querySelector("button").addEventListener("click", () => copyText(value));
    linksEl.appendChild(row);
  }
}

document.getElementById("generate").addEventListener("click", async () => {
  errorEl.textContent = "";
  const token = document.getElementById("token").value.trim();
  const payload = {
    token,
    email: document.getElementById("email").value.trim(),
    password: document.getElementById("password").value,
    accessKey: document.getElementById("accessKey").value,
    storeProfile: document.getElementById("storeProfile").checked,
    enableProfileSync: document.getElementById("enableProfileSync").checked,
    geoAutoUpdate: document.getElementById("geoAutoUpdate").checked,
    geoUpdateInterval: document.getElementById("geoUpdateInterval").value
  };
  try {
    const resp = await fetch(token ? "/api/token-links" : "/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "request failed");
    renderLinks(data.links);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("clear").addEventListener("click", () => {
  document.getElementById("token").value = "";
  document.getElementById("email").value = "";
  document.getElementById("password").value = "";
  document.getElementById("storeProfile").checked = false;
  document.getElementById("enableProfileSync").checked = false;
  document.getElementById("geoAutoUpdate").checked = true;
  document.getElementById("geoUpdateInterval").value = "24";
  linksEl.innerHTML = "";
  errorEl.textContent = "";
});

document.addEventListener("click", (event) => {
  const text = event.target?.dataset?.copy;
  if (text) copyText(text);
});
</script>
</body>
</html>`;
}

async function handleHealth(request) {
  return jsonResponse({
    ok: true,
    worker: getWorkerBaseUrl(request),
    rules: [...SUPPORTED_RULE_ASSETS],
  });
}

export async function handleRequest(request, env = {}, ctx = {}) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,x-access-key",
      },
    });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/g, "") || "/";

  try {
    if (path === "/" && request.method === "GET") {
      return new Response(renderPage(getWorkerBaseUrl(request)), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (path === "/health") return handleHealth(request);

    if (path === "/api/links" && request.method === "POST") {
      return await handleCreateLinks(request, env);
    }

    if (path === "/api/token-links" && request.method === "POST") {
      return await handleCreateTokenLinks(request, env);
    }

    if (path === "/api/cache" && request.method === "POST") {
      return await handleUploadCache(request, env);
    }

    if (path === "/api/decrypt" && request.method === "POST") {
      assertAccessAllowed(request, env);
      const plain = await decryptProfile(
        await request.text(),
        env.PROFILE_AES_KEY || DEFAULT_PROFILE_KEY,
        env.PROFILE_AES_IV || DEFAULT_PROFILE_IV,
      );
      return new Response(plain, {
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const profileSubMatch = path.match(/^\/p\/([^/]+)\/sub(?:\/(clash|raw|nodes|links|base64|meta))?$/);
    if (profileSubMatch && request.method === "GET") {
      const profile = await readProfile(env, decodeURIComponent(profileSubMatch[1]));
      return await handleSubRequest(request, env, profileSubMatch[2] || "clash", profile);
    }

    if (path === "/sub" && request.method === "GET") {
      return await handleSubRequest(request, env, "clash");
    }

    const subMatch = path.match(/^\/sub\/(clash|raw|nodes|links|base64|meta)$/);
    if (subMatch && request.method === "GET") {
      return await handleSubRequest(request, env, subMatch[1]);
    }

    const rulesMatch = path.match(/^\/rules\/([^/]+)$/);
    if (rulesMatch && request.method === "GET") {
      return await handleRulesAsset(request, env, ctx, rulesMatch[1]);
    }

    return textResponse("not found", { status: 404 });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : "internal error";
    const wantsJson =
      path.startsWith("/api/") ||
      request.headers.get("Accept")?.includes("application/json");
    if (wantsJson) {
      return jsonResponse({ error: message }, { status });
    }
    return textResponse(message, { status });
  }
}

async function syncRulesCache(env) {
  const cacheSeconds = Number(env.RULES_CACHE_SECONDS || 86400);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (!cache) return;

  for (const asset of ["geoip.dat", "geosite.dat", "country.mmdb", "GeoLite2-ASN.mmdb"]) {
    const upstreamUrl = buildMetaRulesAssetUrl(asset);
    const upstream = await fetch(upstreamUrl, {
      cf: {
        cacheEverything: true,
        cacheTtl: cacheSeconds,
      },
    });
    if (!upstream.ok) continue;
    const headers = new Headers(upstream.headers);
    headers.set("Cache-Control", `public, max-age=${cacheSeconds}`);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("X-Rules-Source", upstreamUrl);
    await cache.put(
      new Request(upstreamUrl),
      new Response(upstream.body, {
        status: upstream.status,
        headers,
      }),
    );
  }
}

async function syncSavedProfiles(env) {
  const profiles = await listProfiles(env);
  for (const profile of profiles) {
    const options = getSubscriptionOptions(profile.options || {}, {
      geoAutoUpdate: true,
      geoUpdateInterval: 24,
      enableProfileSync: false,
    });
    if (!options.enableProfileSync) continue;

    try {
      const cache = await refreshProfileCache(profile, env, profile.baseUrl || "");
      await writeProfile(env, {
        ...profile,
        options,
        cache,
        updatedAt: new Date().toISOString(),
        lastError: null,
      });
    } catch (err) {
      await writeProfile(env, {
        ...profile,
        options,
        updatedAt: new Date().toISOString(),
        lastError: err instanceof HttpError ? err.message : "profile sync failed",
      });
    }
  }
}

export async function scheduled(_event, env, ctx) {
  if (envFlag(env.ENABLE_RULES_CRON, true)) {
    ctx.waitUntil(syncRulesCache(env));
  }
  if (envFlag(env.ENABLE_PROFILE_CRON, false)) {
    ctx.waitUntil(syncSavedProfiles(env));
  }
}

export default {
  fetch: handleRequest,
  scheduled,
};
