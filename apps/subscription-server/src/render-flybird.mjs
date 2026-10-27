#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import { enhanceMihomoConfig } from "@proxy-toolkit/flybird";

const BUILTINS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);

function usage() {
  return "Usage: render-flybird.mjs --in RAW.yaml --out DISTRIBUTION.yaml --base-url https://example.invalid";
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") return { help: true };
    if (!value.startsWith("--")) throw new Error(`unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for --${key}`);
    result[key] = next;
    index += 1;
  }
  return result;
}

function validateDistribution(text) {
  let config;
  try {
    config = YAML.parse(text, { uniqueKeys: true, maxAliasCount: 100 });
  } catch {
    throw new Error("Rendered FlyBird configuration is invalid YAML");
  }
  if (!config || !Array.isArray(config.proxies) || !config.proxies.length) {
    throw new Error("Rendered FlyBird configuration has no proxies");
  }
  const proxyNames = new Set(config.proxies.map((proxy) => proxy?.name));
  if (proxyNames.size !== config.proxies.length || [...proxyNames].some((name) => typeof name !== "string" || !name)) {
    throw new Error("Rendered FlyBird configuration has invalid or duplicate proxy names");
  }
  const groups = config["proxy-groups"];
  if (!Array.isArray(groups) || !groups.length) throw new Error("Rendered FlyBird configuration has no proxy groups");
  const groupNames = new Set(groups.map((group) => group?.name));
  if (groupNames.size !== groups.length || [...groupNames].some((name) => typeof name !== "string" || !name)) {
    throw new Error("Rendered FlyBird configuration has invalid or duplicate group names");
  }
  const targets = new Set([...proxyNames, ...groupNames, ...BUILTINS]);
  for (const group of groups) {
    if (!Array.isArray(group?.proxies) || !group.proxies.length) {
      throw new Error(`FlyBird group ${String(group?.name || "<unnamed>")} has no targets`);
    }
    for (const target of group.proxies) {
      if (!targets.has(target) || target === group.name) {
        throw new Error(`FlyBird group ${String(group.name)} has an invalid target`);
      }
    }
  }
  if (!Array.isArray(config.rules) || !config.rules.length) throw new Error("Rendered FlyBird configuration has no rules");
  for (const rule of config.rules) {
    if (typeof rule !== "string") throw new Error("Rendered FlyBird rule must be text");
    const parts = rule.split(",");
    const target = parts.at(-1) === "no-resolve" ? parts.at(-2) : parts.at(-1);
    if (!targets.has(target)) throw new Error(`FlyBird rule has an unknown target: ${target}`);
  }
  return {
    proxyCount: config.proxies.length,
    proxyGroupCount: groups.length,
    ruleCount: config.rules.length,
  };
}

export async function renderFlyBirdSubscription(source, baseUrl) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("FlyBird distribution base URL must be an HTTPS origin");
  }
  const rendered = enhanceMihomoConfig(source, origin.origin);
  const counts = validateDistribution(rendered);
  return { yaml: rendered.endsWith("\n") ? rendered : `${rendered}\n`, ...counts };
}

async function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.in || !options.out || !options["base-url"]) throw new Error(usage());
  const source = await fs.readFile(options.in, "utf8");
  const result = await renderFlyBirdSubscription(source, options["base-url"]);
  await atomicWrite(options.out, result.yaml);
  const { yaml: _yaml, ...counts } = result;
  process.stdout.write(`${JSON.stringify({ ok: true, ...counts, out: options.out })}\n`);
}

main().catch((error) => {
  process.stderr.write(`FlyBird render failed: ${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
