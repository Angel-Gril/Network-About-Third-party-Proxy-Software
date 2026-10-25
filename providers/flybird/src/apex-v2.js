export const DEFAULT_APEX_V2_API_DOMAINS = Object.freeze([
  "https://fbaxapi.web.ak005.com",
  "https://fbaxapi.apiv2.a047.com",
]);

export const DEFAULT_APEX_V2_SUBSCRIBE_DOMAINS = Object.freeze([
  "https://fbaxsub.web.ak005.com",
  "https://fbaxsub.apiv2.a047.com",
]);

const CLIENT_HEADERS = Object.freeze({
  Accept: "application/json",
  "User-Agent": "ua.net.fbclient.app.apex/v7.2.3",
  "x-client-platform": "windows",
});

export class ApexV2Error extends Error {
  constructor(message, { status = null, responseBody = "" } = {}) {
    super(message);
    this.name = "ApexV2Error";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function baseUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new ApexV2Error("Apex v2 API must use https");
  return url.toString().replace(/\/$/, "");
}

function normalizeDomains(values, fallback) {
  const domains = Array.isArray(values) ? values : String(values || "").split(",");
  const normalized = domains.map((value) => String(value || "").trim().replace(/\/$/, ""))
    .filter(Boolean);
  return normalized.length ? normalized : [...fallback];
}

async function requestJson(fetchImpl, url, init, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      ...init,
    });
  } catch {
    throw new ApexV2Error(`${label} request failed`);
  }
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* Report structural error below. */ }
  if (!response.ok) {
    throw new ApexV2Error(`${label} returned HTTP ${response.status}`, {
      status: response.status,
      responseBody: text.slice(0, 256),
    });
  }
  if (!payload || typeof payload !== "object") {
    throw new ApexV2Error(`${label} returned invalid JSON`);
  }
  return payload;
}

function payloadData(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

function firstString(value, names) {
  for (const name of names) {
    if (typeof value?.[name] === "string" && value[name].trim()) return value[name].trim();
  }
  return "";
}

export function normalizeApexV2Login(payload) {
  const data = payloadData(payload);
  const token = firstString(data, ["token", "access_token", "accessToken"]);
  const authData = firstString(data, ["auth_data", "authData", "token", "access_token"]);
  if (!token && !authData) throw new ApexV2Error("Apex v2 login response is missing a session token");
  return { token: token || authData, authData: authData || token };
}

export function normalizeApexV2AccessCredential(payload) {
  const data = payloadData(payload);
  const accessKey = firstString(data, [
    "access_key", "accessKey", "subscription_token", "subscriptionToken", "access_token", "accessToken",
  ]);
  if (!accessKey) throw new ApexV2Error("Apex v2 access-token response is missing access_key");
  return {
    accessKey,
    encryptKey: firstString(data, ["encrypt_key", "encryptKey"]),
    signKey: firstString(data, ["sign_key", "signKey"]),
    keyId: firstString(data, ["key_id", "keyId"]),
    expiresAt: firstString(data, ["expires_at", "expiresAt", "expire_at", "expireAt"]),
  };
}

export async function loginApexV2(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const domains = normalizeDomains(options.apiDomains, DEFAULT_APEX_V2_API_DOMAINS);
  const email = String(options.email || "").trim();
  const password = String(options.password || "");
  if (!email || !password) throw new ApexV2Error("Apex v2 login credentials are incomplete");
  const failures = [];
  for (const domain of domains) {
    try {
      const form = new URLSearchParams({ email, password });
      const payload = await requestJson(fetchImpl, `${baseUrl(domain)}/v2/auth/token`, {
        method: "POST",
        headers: {
          ...CLIENT_HEADERS,
          ...(options.headers || {}),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      }, "Apex v2 login");
      return { ...normalizeApexV2Login(payload), baseUrl: baseUrl(domain) };
    } catch (error) {
      failures.push(error);
      if (error?.status === 401 || error?.status === 403) break;
    }
  }
  const status = failures.find((error) => error?.status)?.status || null;
  throw new ApexV2Error(`Apex v2 login failed at ${failures.length} endpoint(s)`, { status });
}

export async function getApexV2AccessCredential(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const domains = normalizeDomains(options.apiDomains, DEFAULT_APEX_V2_API_DOMAINS);
  const bearer = String(options.authData || options.token || "").trim();
  if (!bearer) throw new ApexV2Error("Apex v2 session token is required");
  const failures = [];
  for (const domain of domains) {
    try {
      const payload = await requestJson(fetchImpl, `${baseUrl(domain)}/v2/feed/access-token`, {
        headers: {
          ...CLIENT_HEADERS,
          ...(options.headers || {}),
          Authorization: `Bearer ${bearer}`,
        },
      }, "Apex v2 access-token");
      return { ...normalizeApexV2AccessCredential(payload), baseUrl: baseUrl(domain) };
    } catch (error) {
      failures.push(error);
      if (error?.status === 401 || error?.status === 403) break;
    }
  }
  const status = failures.find((error) => error?.status)?.status || null;
  throw new ApexV2Error(`Apex v2 access-token failed at ${failures.length} endpoint(s)`, { status });
}

export function buildApexV2DownloadUrls(accessKey, subscribeDomains = DEFAULT_APEX_V2_SUBSCRIBE_DOMAINS) {
  const key = String(accessKey || "").trim();
  if (!key) throw new ApexV2Error("Apex v2 access_key is required");
  return normalizeDomains(subscribeDomains, DEFAULT_APEX_V2_SUBSCRIBE_DOMAINS)
    .map((domain) => `${domain}/v2/feed/download?access_key=${encodeURIComponent(key)}`);
}

