import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { atomicWrite, readJson } from "./cache.mjs";

export function usableEntryAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 &&
      !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 && [0, 2].includes(c))) &&
      !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) &&
      !(a === 203 && b === 0 && c === 113);
  }
  // Global unicast only; reject mapped IPv4, documentation and benchmark ranges.
  if (family !== 6) return false;
  const value = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return /^[23]/.test(value) && !value.startsWith("2001:2:") &&
    !value.startsWith("2001:db8:") && !value.startsWith("3fff:");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function entryBinding(proxies) {
  // Bind recovery to this subscription's exact connection identities, including SNI.
  const identities = proxies.map(({ name, server, ...identity }) =>
    JSON.stringify(stable(identity))).sort();
  return crypto.createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

export function dnsQuestion(host, type) {
  if (![1, 28].includes(type)) throw new Error("Unsupported DNS question type");
  const labels = host.replace(/\.$/, "").split(".");
  if (!labels.length || labels.some(label => !label.length || Buffer.byteLength(label) > 63)) {
    throw new Error("Invalid entry hostname");
  }
  const header = Buffer.alloc(12); header.writeUInt16BE(0x100, 2); header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5); tail.writeUInt16BE(type, 1); tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels.map(label => Buffer.concat([
    Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), tail]);
}

function readName(data, start) {
  let offset = start, end, total = 0;
  const labels = [], visited = new Set();
  for (let count = 0; count < 128; count++) {
    if (offset >= data.length || visited.has(offset)) throw new Error("Invalid DNS name");
    visited.add(offset);
    const size = data[offset++];
    if ((size & 0xc0) === 0xc0) {
      if (offset >= data.length) throw new Error("Truncated DNS pointer");
      end ??= offset + 1;
      offset = ((size & 63) << 8) | data[offset];
      continue;
    }
    if (size & 0xc0 || offset + size > data.length) throw new Error("Invalid DNS label");
    if (!size) return { name: labels.join(".").toLowerCase(), end: end ?? offset };
    total += size + 1;
    if (total > 254) throw new Error("DNS name too long");
    labels.push(data.subarray(offset, offset + size).toString("ascii")); offset += size;
  }
  throw new Error("DNS pointer limit exceeded");
}

export function dnsAddresses(data, host, type) {
  if (!Buffer.isBuffer(data) || data.length < 12 || data.length > 65535 ||
      data.readUInt16BE(0) !== 0 || !(data[2] & 0x80) || (data[2] & 0x7a) ||
      (data[3] & 15) || data.readUInt16BE(4) !== 1) throw new Error("DNS response rejected");
  const question = readName(data, 12);
  let offset = question.end;
  if (question.name !== host.replace(/\.$/, "").toLowerCase() || offset + 4 > data.length ||
      data.readUInt16BE(offset) !== type || data.readUInt16BE(offset + 2) !== 1) {
    throw new Error("DNS question mismatch");
  }
  offset += 4;
  const records = [], aliases = new Map();
  const count = data.readUInt16BE(6);
  if (count > 1024) throw new Error("DNS answer limit exceeded");
  for (let index = 0; index < count; index++) {
    const owner = readName(data, offset); offset = owner.end;
    if (offset + 10 > data.length) throw new Error("Truncated DNS record");
    const kind = data.readUInt16BE(offset), recordClass = data.readUInt16BE(offset + 2);
    const length = data.readUInt16BE(offset + 8); offset += 10;
    if (offset + length > data.length) throw new Error("Truncated DNS data");
    if (recordClass === 1 && kind === 5) {
      const alias = readName(data, offset);
      if (alias.end !== offset + length || aliases.has(owner.name)) throw new Error("Invalid DNS alias");
      aliases.set(owner.name, alias.name);
    }
    if (recordClass === 1 && kind === type && (kind === 1 && length === 4 || kind === 28 && length === 16)) {
      const bytes = data.subarray(offset, offset + length);
      const address = kind === 1 ? [...bytes].join(".") : Array.from({ length: 8 },
        (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":");
      records.push({ owner: owner.name, address });
    }
    offset += length;
  }
  const chain = new Set([question.name]);
  let name = question.name;
  while (aliases.has(name)) {
    name = aliases.get(name);
    if (chain.has(name) || chain.size >= 16) throw new Error("DNS alias cycle");
    chain.add(name);
  }
  return records.filter(record => chain.has(record.owner) && usableEntryAddress(record.address))
    .map(record => record.address);
}

async function queryDoh(endpoint, host, type, options) {
  const url = new URL(endpoint.split("#", 1)[0]);
  if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname)) {
    throw new Error("Invalid upstream node resolver");
  }
  url.searchParams.set("dns", dnsQuestion(host, type).toString("base64url"));
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      cert: options.cert, key: options.key, rejectUnauthorized: true,
      headers: { accept: "application/dns-message", "user-agent": options.userAgent || "ua.net.fbclient.app.apex/7.3.1" },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(Object.assign(new Error("Node DoH HTTP failure"), response.statusCode === 429 ? { code: "UPSTREAM_RATE_LIMIT" } : {}));
        return;
      }
      let length = 0; const chunks = [];
      response.on("data", chunk => {
        length += chunk.length;
        if (length > 65535) request.destroy(new Error("Node DoH response too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(dnsAddresses(Buffer.concat(chunks), host, type)); } catch { reject(new Error("Node DoH answer rejected")); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("Node DoH timeout")), options.timeoutMs || 4000);
    request.once("close", () => clearTimeout(timer));
    request.once("error", () => reject(new Error("Node DoH connection failed")));
  });
}

export async function resolveFlyBirdEntries(text, options = {}) {
  const config = YAML.parse(text, { uniqueKeys: true, maxAliasCount: 100 });
  if (!config || !Array.isArray(config.proxies) || !config.proxies.length) throw new Error("FlyBird has no proxy entries");
  const addressMode = options.addressMode ?? "literal";
  if (!["literal", "hosts"].includes(addressMode)) throw new Error("Invalid entry address mode");
  if (config.hosts && (Array.isArray(config.hosts) || typeof config.hosts !== "object")) {
    throw new Error("Invalid FlyBird hosts mapping");
  }
  const groups = new Map();
  const literalHosts = new Set();
  for (const proxy of config.proxies) {
    if (!proxy || typeof proxy.server !== "string" || !proxy.server || !proxy.name || !proxy.type) {
      throw new Error("FlyBird has an invalid proxy entry");
    }
    if (isIP(proxy.server)) {
      if (!usableEntryAddress(proxy.server)) throw new Error("FlyBird entry address is not public");
      if (options.requireIPv4 && isIP(proxy.server) !== 4) {
        throw Object.assign(new Error("FlyBird has no validated IPv4 entry; publication refused"), { code: "ENTRY_IPV4_REQUIRED" });
      }
      literalHosts.add(proxy.server);
      continue;
    }
    if (!groups.has(proxy.server)) groups.set(proxy.server, []);
    groups.get(proxy.server).push(proxy);
  }
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 7 * 24 * 60 * 60 * 1000) throw new Error("Invalid entry cache age");
  const previous = options.state || { schemaVersion: 1, hosts: {} };
  if (previous.schemaVersion !== 1 || !previous.hosts || typeof previous.hosts !== "object") throw new Error("Invalid FlyBird entry cache");
  const state = { schemaVersion: 1, hosts: Object.create(null) };
  const endpoints = config.dns?.["proxy-server-nameserver"]?.filter(value =>
    typeof value === "string" && value.startsWith("https://")) || [];
  const lookup = options.lookup || (host => dns.lookup(host, { all: true }));
  const dohLookup = options.dohLookup || ((endpoint, host, type) => queryDoh(endpoint, host, type, options));
  let liveHostCount = 0, cachedHostCount = 0, changedServerCount = 0, cachedServerCount = 0;
  let ipv6OnlyHostCount = [...literalHosts].filter(address => isIP(address) === 6).length;
  const observations = [];
  for (const [host, proxies] of groups) {
    const binding = entryBinding(proxies);
    const cached = previous.hosts[host];
    const cacheAge = now - Date.parse(cached?.observedAt);
    const cacheReady = cached?.binding === binding && Number.isFinite(cacheAge) && cacheAge >= 0 && cacheAge <= maxAgeMs &&
      Array.isArray(cached.addresses) && cached.addresses.length > 0 && cached.addresses.every(usableEntryAddress);
    let usedCache = false;
    let addresses = [], source = "upstream-doh";
    // A signed subscription's node DNS is authoritative for its private entry zone.
    for (const endpoint of endpoints.slice(0, 3)) {
      const replies = await Promise.allSettled([1, 28].map(type => dohLookup(endpoint, host, type)));
      if (replies.some(reply => reply.status === "rejected" && reply.reason?.code === "UPSTREAM_RATE_LIMIT")) {
        throw new Error("FlyBird node resolver rate limited; publication refused");
      }
      addresses = replies.flatMap(reply => reply.status === "fulfilled" ? reply.value : []).filter(usableEntryAddress);
      if (addresses.length) break;
    }
    // A previously verified private-zone mapping is stronger evidence than an
    // unrelated recursive resolver's answer after the provider DoH has failed.
    if (!addresses.length && endpoints.length && cacheReady) {
      addresses = cached.addresses; usedCache = true;
    }
    // Public recursive DNS can return plausible but unusable decoy addresses
    // for a provider's private entry zone. Do not promote those answers when
    // the authenticated resolver failed and no verified mapping is available.
    if (!addresses.length && !endpoints.length) {
      source = "system-dns";
      try {
        addresses = (await lookup(host)).map(value => typeof value === "string" ? value : value.address).filter(usableEntryAddress);
      } catch { /* A failed resolver is not evidence that a node is valid. */ }
    }
    let observedAt = new Date(now).toISOString();
    if (!addresses.length) {
      if (!cacheReady) {
        throw new Error("FlyBird entry DNS failed without a matching recent address cache; publication refused");
      }
      addresses = cached.addresses; usedCache = true;
    }
    if (usedCache) { observedAt = cached.observedAt; source = "cached"; cachedHostCount++; cachedServerCount += proxies.length; }
    else liveHostCount++;
    addresses = [...new Set(addresses)];
    if (options.requireIPv4 && !addresses.some(address => isIP(address) === 4)) {
      throw Object.assign(new Error("FlyBird has no validated IPv4 entry; publication refused"), { code: "ENTRY_IPV4_REQUIRED" });
    }
    if (addresses.every(address => isIP(address) === 6)) ipv6OnlyHostCount++;
    // The host-map output retains every address and the provider's IP preference.
    // Literal output is retained for consumers that cannot preserve hosts.
    addresses.sort((a, b) => isIP(a) - isIP(b) || a.localeCompare(b));
    state.hosts[host] = { addresses, binding, observedAt, source };
    observations.push(observedAt);
    if (addressMode === "hosts") {
      config.hosts = { ...config.hosts, [host]: addresses };
      config.dns = { ...config.dns, "use-hosts": true };
    } else {
      for (const proxy of proxies) {
        if (proxy.type === "anytls" && !proxy.sni && !proxy.servername) proxy.sni = host;
        else if (proxy.tls === true && !proxy.servername && !proxy.sni) proxy.servername = host;
        proxy.server = addresses[0]; changedServerCount++;
      }
    }
  }
  return { yaml: YAML.stringify(config, { lineWidth: 0 }), state,
    metadata: { addressMode, resolvedHostCount: groups.size + literalHosts.size, upstreamLiteralHostCount: literalHosts.size,
      liveHostCount, cachedHostCount, ipv6OnlyHostCount,
      changedServerCount, cachedServerCount, oldestAddressObservation: observations.sort()[0] || null, maxCacheAgeSeconds: maxAgeMs / 1000 } };
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1]) throw new Error("Invalid entry resolver arguments");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.in || !options.out || !options.state || !options.metadata) throw new Error("Entry resolver requires in, out, state and metadata");
  if (options["require-ipv4"] && !["0", "1"].includes(options["require-ipv4"])) throw new Error("Invalid IPv4 publication policy");
  const identity = {};
  if (options.cert || options.key) {
    if (!options.cert || !options.key) throw new Error("Node DNS requires both client identity files");
    identity.cert = await fs.readFile(options.cert); identity.key = await fs.readFile(options.key);
  }
  const result = await resolveFlyBirdEntries(await fs.readFile(options.in, "utf8"), {
    ...identity, state: await readJson(options.state, { schemaVersion: 1, hosts: {} }),
    addressMode: options["address-mode"] || "hosts",
    requireIPv4: options["require-ipv4"] !== "0",
    maxAgeMs: options["max-age-seconds"] ? Number(options["max-age-seconds"]) * 1000 : undefined,
  });
  await atomicWrite(options.out, result.yaml);
  await atomicWrite(options.state, `${JSON.stringify(result.state)}\n`);
  await atomicWrite(options.metadata, `${JSON.stringify(result.metadata)}\n`);
  process.stdout.write(`${JSON.stringify({ entryResolution: result.metadata })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const ipv4Missing = error?.code === "ENTRY_IPV4_REQUIRED";
    process.stderr.write(ipv4Missing
      ? "FlyBird has no validated IPv4 entry; cached subscription preserved\n"
      : "FlyBird entry resolution failed; cached subscription preserved\n");
    process.exitCode = ipv4Missing ? 4 : 1;
  });
}
