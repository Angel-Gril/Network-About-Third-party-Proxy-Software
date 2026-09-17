const API_BASE_URLS = [
  "https://api.bluecloudworks.com/",
  "https://ac.applecross.link/",
];

// These identify the public desktop client protocol; they are not user credentials.
const CLIENT_ID = "019f193c-bb33-70fd-80a2-b6bb9f67a3ca";
const CLIENT_SECRET = "6K0HewjY1EXWAFTxFqcKtZLbF3wrnennyN65lcl1";
const CLIENT_VERSION = "1.0.1";
const USER_AGENT = `MonocloudGO-${CLIENT_VERSION}`;

export class MonoCloudError extends Error {
  constructor(message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = "MonoCloudError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function headers(token, contentType = null) {
  const value = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "X-Client-Version": CLIENT_VERSION,
  };
  if (contentType) value["Content-Type"] = contentType;
  if (token) value.Authorization = `Bearer ${token}`;
  return value;
}

async function request(fetchImpl, baseUrl, path, init = {}) {
  const url = new URL(path, baseUrl);
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      ...init,
    });
  } catch {
    throw new MonoCloudError("MonoCloud request failed");
  }
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* The caller reports a structural error. */ }
  return { response, payload };
}

function upstreamError(label, response) {
  return new MonoCloudError(`${label} returned HTTP ${response.status}`, {
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
  });
}

async function loginAtBase(email, password, baseUrl, fetchImpl) {
  const form = new URLSearchParams({
    grant_type: "password",
    client_id: CLIENT_ID,
    username: email,
    password,
    client_secret: CLIENT_SECRET,
  });
  const { response, payload } = await request(fetchImpl, baseUrl, "oauth/token", {
    method: "POST",
    headers: headers(null, "application/x-www-form-urlencoded"),
    body: form,
  });
  if (!response.ok) throw upstreamError("MonoCloud login", response);
  if (!payload || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new MonoCloudError("MonoCloud login response is incomplete");
  }
  return payload.access_token;
}

export async function loginMonoCloud(email, password, options = {}) {
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    throw new MonoCloudError("MonoCloud credentials are incomplete");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const bases = options.baseUrls || API_BASE_URLS;
  const failures = [];
  for (const value of bases) {
    const baseUrl = new URL(value).toString();
    try {
      const token = await loginAtBase(email.trim(), password, baseUrl, fetchImpl);
      return { token, baseUrl };
    } catch (error) {
      failures.push(error);
      if (error?.status === 429) throw error;
      const retryable = error?.status === null || [408, 409, 425, 500, 502, 503, 504].includes(error?.status);
      if (!retryable) throw new MonoCloudError("MonoCloud login failed", { status: error?.status || null });
    }
  }
  const status = failures.find((error) => error?.status)?.status || null;
  throw new MonoCloudError(`MonoCloud login failed at ${failures.length} endpoint(s)`, { status });
}

async function getJson(fetchImpl, baseUrl, path, token, label) {
  const { response, payload } = await request(fetchImpl, baseUrl, path, {
    headers: headers(token),
  });
  if (!response.ok) throw upstreamError(label, response);
  if (payload === null) throw new MonoCloudError(`${label} returned invalid JSON`);
  return payload;
}

function catalogRows(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows) || !rows.length) {
    throw new MonoCloudError("MonoCloud account has no active service plans");
  }
  return rows;
}

function nodeType(row) {
  const value = String(row?.plan?.type || "").trim().toLowerCase();
  if (value !== "shadowsocks") {
    throw new MonoCloudError("Unsupported MonoCloud plan type");
  }
  return value;
}

function uniqueName(row, index, used) {
  const parts = [row.emoji, row.alias || row.location, row.group]
    .map((value) => String(value || "").trim()).filter(Boolean);
  const base = parts.join(" ") || `MonoCloud ${index + 1}`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base} ${suffix++}`;
  used.add(name);
  return name;
}

export function convertShadowsocksNodes(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new MonoCloudError("MonoCloud node list is empty");
  const used = new Set();
  return rows.filter((row) => Number(row?.enable) === 1).map((row, index) => {
    const server = String(row?.hostname || "").trim();
    const cipher = String(row?.encryption || "").trim();
    const password = String(row?.password || "");
    const port = Number(row?.port);
    if (!server || !cipher || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new MonoCloudError("MonoCloud node response contains incomplete connection fields");
    }
    return {
      name: uniqueName(row, index, used),
      type: "ss",
      server,
      port,
      cipher,
      password,
      udp: true,
    };
  });
}

export function nodesToClashYaml(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) throw new MonoCloudError("MonoCloud has no enabled nodes");
  return `proxies:\n${nodes.map((node) => `  - ${JSON.stringify(node)}`).join("\n")}\n`;
}

export function shadowsocksLink(node) {
  const userInfo = Buffer.from(`${node.cipher}:${node.password}`, "utf8").toString("base64");
  return `ss://${userInfo}@${node.server}:${node.port}#${encodeURIComponent(node.name)}`;
}

export async function fetchMonoCloudSubscription(credentials, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const login = await loginMonoCloud(credentials?.email, credentials?.password, {
    fetchImpl,
    baseUrls: options.baseUrls,
  });
  try {
    const catalog = catalogRows(await getJson(fetchImpl, login.baseUrl, "api/service", login.token, "MonoCloud catalog"));
    const sourceRows = [];
    for (const plan of catalog) {
      const type = nodeType(plan);
      const id = String(plan?.id || "").trim();
      if (!id) throw new MonoCloudError("MonoCloud plan is missing its identifier");
      const payload = await getJson(fetchImpl, login.baseUrl, `api/${type}/${encodeURIComponent(id)}`,
        login.token, "MonoCloud node list");
      const rows = Array.isArray(payload) ? payload : payload?.data;
      if (!Array.isArray(rows)) throw new MonoCloudError("MonoCloud node list has an invalid structure");
      sourceRows.push(...rows);
    }
    const nodes = convertShadowsocksNodes(sourceRows);
    return {
      yaml: nodesToClashYaml(nodes),
      links: nodes.map(shadowsocksLink),
      nodeCount: nodes.length,
      planCount: catalog.length,
      baseHost: new URL(login.baseUrl).host,
    };
  } finally {
    login.token = "";
  }
}

export const protocol = Object.freeze({ clientVersion: CLIENT_VERSION, userAgent: USER_AGENT });
