import YAML from "yaml";

export const SUBSCRIPTION_FORMATS = Object.freeze({
  clash: Object.freeze({ extension: "yaml", contentType: "text/yaml; charset=utf-8" }),
  uri: Object.freeze({ extension: "txt", contentType: "text/plain; charset=utf-8" }),
  v2rayn: Object.freeze({ extension: "b64", contentType: "text/plain; charset=utf-8" }),
});

const FORMAT_BY_EXTENSION = new Map(Object.entries(SUBSCRIPTION_FORMATS)
  .map(([format, value]) => [value.extension, format]));

export function normalizeSubscriptionFormat(value = "clash") {
  const format = String(value || "clash").toLowerCase();
  if (!Object.hasOwn(SUBSCRIPTION_FORMATS, format)) throw new Error("Unknown subscription format");
  return format;
}

export function subscriptionFormatFromExtension(extension) {
  const format = FORMAT_BY_EXTENSION.get(String(extension || "").toLowerCase());
  if (!format) throw new Error("Unknown subscription format");
  return format;
}

function requiredString(value) {
  if (typeof value !== "string" || !value) throw new Error("Proxy entry cannot be converted to a share link");
  return value;
}

function requiredPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Proxy entry cannot be converted to a share link");
  }
  return port;
}

function authority(host) {
  const value = requiredString(host);
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function shadowsocksLink(proxy) {
  if (proxy.plugin || proxy["plugin-opts"]) throw new Error("Cached configuration contains an unsupported proxy transport");
  const userInfo = Buffer.from(`${requiredString(proxy.cipher)}:${requiredString(proxy.password)}`, "utf8")
    .toString("base64url");
  return `ss://${userInfo}@${authority(proxy.server)}:${requiredPort(proxy.port)}#${encodeURIComponent(requiredString(proxy.name))}`;
}

function vlessLink(proxy) {
  if (proxy["reality-opts"] || ![undefined, false, true].includes(proxy.tls)) {
    throw new Error("Cached configuration contains an unsupported proxy transport");
  }
  const query = new URLSearchParams({ encryption: String(proxy.encryption || "none") });
  const network = String(proxy.network || "tcp");
  if (!["tcp", "ws"].includes(network)) throw new Error("Cached configuration contains an unsupported proxy transport");
  query.set("type", network);
  if (proxy.tls === true) query.set("security", "tls");
  if (proxy.servername) query.set("sni", String(proxy.servername));
  if (proxy.flow) query.set("flow", String(proxy.flow));
  if (proxy["client-fingerprint"]) query.set("fp", String(proxy["client-fingerprint"]));
  if (proxy["skip-cert-verify"] === true) query.set("allowInsecure", "1");
  if (Array.isArray(proxy.alpn) && proxy.alpn.length) query.set("alpn", proxy.alpn.join(","));
  if (network === "ws") {
    const options = proxy["ws-opts"] || {};
    const headers = options.headers || {};
    if (Object.keys(headers).some(key => key.toLowerCase() !== "host")) {
      throw new Error("Cached configuration contains an unsupported proxy transport");
    }
    if (options.path) query.set("path", String(options.path));
    const host = headers.Host || headers.host;
    if (host) query.set("host", String(host));
  }
  return `vless://${encodeURIComponent(requiredString(proxy.uuid))}@${authority(proxy.server)}:${requiredPort(proxy.port)}` +
    `?${query.toString()}#${encodeURIComponent(requiredString(proxy.name))}`;
}

export function proxiesToShareLinks(proxies) {
  if (!Array.isArray(proxies) || !proxies.length) throw new Error("Cached configuration has no proxies");
  return proxies.map((proxy) => {
    if (proxy?.type === "ss") return shadowsocksLink(proxy);
    if (proxy?.type === "vless") return vlessLink(proxy);
    throw new Error("Cached configuration contains an unsupported proxy type");
  });
}

export function renderSubscription(yaml, format = "clash") {
  const normalized = normalizeSubscriptionFormat(format);
  if (normalized === "clash") return yaml;
  let config;
  try { config = YAML.parse(yaml, { uniqueKeys: true, maxAliasCount: 100 }); }
  catch { throw new Error("Cached configuration is invalid"); }
  const links = `${proxiesToShareLinks(config?.proxies).join("\n")}\n`;
  return normalized === "uri" ? links : Buffer.from(links, "utf8").toString("base64");
}
