import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const ROUTING_KEYS = ["proxies", "proxy-groups", "rules", "rule-providers", "geodata-mode",
  "geo-auto-update", "geo-update-interval", "geox-url"];
const BUILTINS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
const parse = text => YAML.parse(text, {uniqueKeys:true, maxAliasCount:100});

export function applyRoutingTemplate(text, baseUrl, render, defaults = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Routing resources require an HTTPS origin");
  }
  const source = parse(text);
  if (!source || !Array.isArray(source.proxies) || !source.proxies.length || typeof render !== "function") {
    throw new Error("Routing template input is incomplete");
  }
  const names = source.proxies.map(proxy => proxy?.name);
  if (names.some(name => typeof name !== "string" || !name || /[\x00-\x1f\x7f]/.test(name) || BUILTINS.has(name)) ||
      new Set(names).size !== names.length) {
    throw new Error("Routing requires unique, valid proxy names");
  }
  const preamble = {...defaults, ...source, mode:"rule"};
  for (const key of ROUTING_KEYS) delete preamble[key];
  // FlyBird's shared renderer reads one JSON flow map per node. Preserve the
  // full nested WS/TLS parameters rather than converting fields individually.
  const normalized = YAML.stringify(preamble).trimEnd() + "\nproxies:\n" +
    source.proxies.map(proxy => "  - " + JSON.stringify(proxy)).join("\n") + "\n";
  const yaml = render(normalized, base.origin);
  const config = parse(yaml);
  if (!isDeepStrictEqual(config?.proxies, source.proxies)) {
    throw new Error("Routing template changed proxy connection parameters");
  }
  const groups = config["proxy-groups"];
  if (!Array.isArray(groups) || !groups.length || !Array.isArray(config.rules) || config.rules.length < 2) {
    throw new Error("Routing template did not produce split-routing policies");
  }
  const groupNames = groups.map(group => group?.name);
  if (new Set(groupNames).size !== groupNames.length || groupNames.some(name =>
    typeof name !== "string" || !name || BUILTINS.has(name) || names.includes(name))) {
    throw new Error("Routing template contains conflicting policy names");
  }
  const targets = new Set([...BUILTINS, ...names, ...groupNames]);
  for (const group of groups) {
    if (!Array.isArray(group.proxies) || !group.proxies.length || group.proxies.some(name =>
      !targets.has(name) || name === group.name)) throw new Error("Routing group has an invalid target");
  }
  for (const rule of config.rules) {
    if (typeof rule !== "string") throw new Error("Routing rule must be text");
    const parts = rule.split(",");
    const target = parts.at(-1) === "no-resolve" ? parts.at(-2) : parts.at(-1);
    if (!targets.has(target)) throw new Error("Routing rule has an unknown policy");
  }
  if (config["geodata-mode"] !== true || config["geo-auto-update"] !== true ||
      config["geo-update-interval"] !== 24 ||
      config["geox-url"]?.geoip !== base.origin + "/rules/geoip.dat" ||
      config["geox-url"]?.geosite !== base.origin + "/rules/geosite.dat") {
    throw new Error("Routing template has invalid GeoX update settings");
  }
  return {yaml, routing:{template:"flybird", proxyGroupCount:groups.length,
    ruleCount:config.rules.length, geoUpdateIntervalHours:24}};
}
