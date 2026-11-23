#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { atomicWrite, readJson, sha256 } from "./cache.mjs";
import { entryBinding } from "./flybird-entries.mjs";

const [mode, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1]) throw new Error("Invalid publication arguments");
  options[args[i].slice(2)] = args[i + 1];
}

async function ownedWrite(file, data, owner) {
  let ids;
  if (owner && process.getuid?.() === 0) {
    if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(owner)) throw new Error("Invalid cache owner");
    ids = ["-u", "-g"].map(flag => spawnSync("id", [flag, owner], { encoding: "utf8" }));
    if (ids.some(result => result.status !== 0 || !/^\d+\s*$/.test(result.stdout))) throw new Error("Cache owner not found");
  }
  await atomicWrite(file, data);
  if (ids) await fs.chown(file, Number(ids[0].stdout.trim()), Number(ids[1].stdout.trim()));
}

async function main() {
  if (!["raw", "distribution"].includes(mode) || !options.in || !options.out) throw new Error("Invalid publication mode");
  const text = await fs.readFile(options.in, "utf8");
  const config = YAML.parse(text, { uniqueKeys: true, maxAliasCount: 100 });
  if (!Array.isArray(config?.proxies) || !config.proxies.length) throw new Error("Publication has no proxies");
  const hash = sha256(text);
  if (mode === "raw") {
    if (!options.metadata) throw new Error("Raw publication metadata is required");
    const metadata = { schemaVersion: 1, provider: "flybird", fetchedAt: new Date().toISOString(),
      sha256: hash, proxyCount: config.proxies.length, nodeBinding: entryBinding(config.proxies),
      serverBinding: sha256(JSON.stringify(config.proxies.map(proxy => [proxy.name, proxy.server]))),
      proxyGroupCount: config["proxy-groups"]?.length || 0, ruleCount: config.rules?.length || 0 };
    await ownedWrite(options.out, text);
    await ownedWrite(options.metadata, JSON.stringify(metadata, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ rawSaved: true, proxyCount: metadata.proxyCount, sha256: hash }) + "\n");
    return;
  }
  if (!["resolved", "client-dns"].includes(options.mode) || !options["raw-metadata"] || !options["entry-metadata"]) {
    throw new Error("Distribution metadata is required");
  }
  const raw = await readJson(options["raw-metadata"]);
  if (raw?.nodeBinding !== entryBinding(config.proxies)) throw new Error("Publication changed upstream node identities");
  if (options.mode === "client-dns" && raw.serverBinding !==
      sha256(JSON.stringify(config.proxies.map(proxy => [proxy.name, proxy.server])))) {
    throw new Error("Client DNS publication changed upstream servers");
  }
  const entry = await readJson(options["entry-metadata"], {});
  const delegated = new Set(config.proxies.filter(proxy => !/^\d+\.\d+\.\d+\.\d+$/.test(proxy.server) &&
    !proxy.server.includes(":")).map(proxy => proxy.server)).size;
  const warnings = [];
  if (options.mode === "client-dns") warnings.push("Latest configuration published; entry enhancement unavailable, client DNS required");
  if (entry.publicFallbackHostCount) warnings.push("Using TLS-validated public node DNS fallback");
  if (entry.cachedHostCount) warnings.push("Using a matching recent entry address cache");
  if (entry.ipv6OnlyHostCount) warnings.push("Entry addresses require client IPv6 connectivity");
  if (entry.retainedCachedIpv6HostCount) warnings.push("Retained a verified IPv6 path from the matching address cache");
  const metadata = { schemaVersion: 1, provider: "flybird", updatedAt: new Date().toISOString(), sha256: hash,
    proxyCount: config.proxies.length, proxyGroupCount: config["proxy-groups"]?.length || 0,
    ruleCount: config.rules?.length || 0, publicationMode: options.mode,
    rawFetchedAt: raw.fetchedAt, rawSha256: raw.sha256,
    validatedHostCount: options.mode === "resolved" ? entry.liveHostCount || 0 : 0,
    recoveredServerCount: options.mode === "resolved" ? entry.cachedServerCount || 0 : 0,
    delegatedHostCount: options.mode === "client-dns" ? delegated : 0,
    enhancement: { status: options.mode === "resolved" ? "ready" : "unavailable",
      error: options.mode === "client-dns" ? entry.error || "Entry address discovery unavailable" : null },
    entryResolution: entry, lastWarning: warnings.join("; ") || null, lastError: null, source: "apex-pure-protocol" };
  const privateEnabled = options.private === "1";
  const current = privateEnabled ? path.join(options["cache-dir"], "flybird.yaml") : options.out;
  let previous;
  try { previous = await fs.readFile(current, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  metadata.changed = previous === undefined || sha256(previous) !== hash;
  if (privateEnabled && metadata.changed && previous !== undefined) {
    await ownedWrite(path.join(options["cache-dir"], "flybird.previous.yaml"), previous, options.owner);
  }
  // The enhanced artifact is separate: a DNS outage never replaces it with an
  // unverified address map, while the main subscription can advance normally.
  if (options.mode === "resolved" && options["enhanced-out"]) await ownedWrite(options["enhanced-out"], text);
  await ownedWrite(options.out, text);
  if (privateEnabled) await ownedWrite(current, text, options.owner);
  await ownedWrite(privateEnabled ? path.join(options["cache-dir"], "flybird.json") : options.out + ".json",
    JSON.stringify(metadata, null, 2) + "\n", privateEnabled ? options.owner : undefined);
  process.stdout.write(JSON.stringify({ published: true, mode: options.mode, proxyCount: metadata.proxyCount,
    proxyGroupCount: metadata.proxyGroupCount, ruleCount: metadata.ruleCount, sha256: hash }) + "\n");
}

main().catch(() => { process.stderr.write("FlyBird publication failed; see publication stage\n"); process.exitCode = 1; });
