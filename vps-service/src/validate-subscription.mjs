import dns from "node:dns/promises";
import { isIP } from "node:net";
import YAML from "yaml";

function parseConfig(text, minimum) {
  if (!text || /^\s*</.test(text)) throw new Error("Upstream returned empty or HTML content");
  let config;
  try { config = YAML.parse(text, { uniqueKeys: true, maxAliasCount: 100 }); }
  catch { throw new Error("Invalid subscription YAML"); }
  if (!config || !Array.isArray(config.proxies) || config.proxies.length < minimum) {
    throw new Error(`Configuration has fewer than ${minimum} proxies`);
  }
  if (!Array.isArray(config["proxy-groups"]) || !Array.isArray(config.rules)) {
    throw new Error("Configuration is missing proxy-groups or rules");
  }
  return config;
}

function realAddress(value) {
  if (!isIP(value)) return false;
  const lower = value.toLowerCase().replace(/^::ffff:/, "");
  return !/^198\.(18|19)\./.test(lower) && !lower.startsWith("fdfe:dcba:9876:");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function recoverableIdentity(proxy) {
  // Only the exact FlyBird transport verified against the historical cache.
  if (proxy?.type !== "vless" || proxy.network !== "tcp" || !proxy.uuid ||
      proxy.flow !== "xtls-rprx-vision" || proxy.tls !== true || proxy["skip-cert-verify"] !== true) return null;
  const { name, server, servername, ...identity } = proxy;
  return JSON.stringify(stable(identity));
}

export async function prepareSubscription(text, options = {}) {
  const config = parseConfig(text, options.minimum || 1);
  const lookup = options.lookup || ((host) => dns.lookup(host, { all: true }));
  const memo = new Map();
  async function resolves(host) {
    if (typeof host !== "string" || !host) return false;
    if (isIP(host)) return realAddress(host);
    if (!memo.has(host)) memo.set(host, (async () => {
      try {
        const addresses = await lookup(host);
        return addresses.some(item => realAddress(typeof item === "string" ? item : item.address));
      } catch { return false; }
    })());
    return memo.get(host);
  }
  let previous = [];
  if (options.allowServerRecovery && options.previousYaml) {
    try { previous = parseConfig(options.previousYaml, 1).proxies; } catch { previous = []; }
  }
  const byIdentity = new Map();
  for (const proxy of previous) {
    const key = recoverableIdentity(proxy);
    if (key) {
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push(proxy);
    }
  }
  let recoveredServerCount = 0;
  const unresolved = new Set();
  for (const proxy of config.proxies) {
    if (await resolves(proxy.server)) continue;
    const key = options.allowServerRecovery ? recoverableIdentity(proxy) : null;
    for (const prior of key ? byIdentity.get(key) || [] : []) {
      if (await resolves(prior.server)) {
        proxy.server = prior.server;
        recoveredServerCount += 1;
        break;
      }
    }
    if (!await resolves(proxy.server)) unresolved.add(String(proxy.server || "<missing>"));
  }
  if (unresolved.size) throw new Error(`${unresolved.size} proxy entry host(s) failed DNS validation; cached configuration preserved`);
  return {
    yaml: recoveredServerCount ? YAML.stringify(config, { lineWidth: 0 }) : text,
    proxyCount: config.proxies.length,
    validatedHostCount: new Set(config.proxies.map(proxy => proxy.server)).size,
    recoveredServerCount,
  };
}
