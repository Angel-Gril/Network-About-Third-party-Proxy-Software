import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const script = fileURLToPath(new URL("../src/render-flybird.mjs", import.meta.url));

const raw = [
  "mixed-port: 7890",
  "mode: rule",
  "proxies:",
  `  - ${JSON.stringify({ name: "Hong Kong-01", type: "vless", server: "hk.example.invalid", port: 443,
    uuid: "11111111-1111-4111-8111-111111111111", tls: true })}`,
  `  - ${JSON.stringify({ name: "USA-01", type: "vless", server: "us.example.invalid", port: 443,
    uuid: "22222222-2222-4222-8222-222222222222", tls: true })}`,
  "proxy-groups:",
  '  - {name: "upstream", type: select, proxies: ["Hong Kong-01", "USA-01"]}',
  "rules:",
  "  - MATCH,upstream",
  "",
].join("\n");

const blockStyleRaw = YAML.stringify({
  "mixed-port": 7890,
  mode: "rule",
  proxies: [
    { name: "Hong Kong-01", type: "trojan", server: "hk.example.invalid", port: 443,
      password: "synthetic-password", sni: "sni.example.invalid", "skip-cert-verify": true },
    { name: "USA-01", type: "ss", server: "us.example.invalid", port: 11011,
      cipher: "aes-256-cfb", password: "synthetic-password" },
  ],
  "proxy-groups": [{ name: "upstream", type: "select", proxies: ["Hong Kong-01", "USA-01"] }],
  rules: ["MATCH,upstream"],
});

test("pure protocol rendering restores distribution groups and valid rule targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-flybird-"));
  try {
    const input = path.join(root, "raw.yaml");
    const output = path.join(root, "flybird.yaml");
    await fs.writeFile(input, raw);
    const result = spawnSync(process.execPath, [script, "--in", input, "--out", output,
      "--base-url", "https://sub.example.invalid"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const config = YAML.parse(await fs.readFile(output, "utf8"));
    assert.equal(config.proxies.length, 2);
    assert.deepEqual(config["proxy-groups"].map((group) => group.name), [
      "节点选择", "自动选择", "故障转移", "香港节点", "台湾节点", "新加坡节点", "日本节点", "美国节点",
      "国外媒体", "AI服务", "电报消息", "微软服务", "苹果服务", "游戏平台", "漏网之鱼",
    ]);
    const known = new Set([
      ...config.proxies.map((proxy) => proxy.name),
      ...config["proxy-groups"].map((group) => group.name),
      "DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE",
    ]);
    for (const group of config["proxy-groups"]) {
      assert.ok(group.proxies.length > 0);
      for (const target of group.proxies) assert.ok(known.has(target), `${group.name} -> ${target}`);
    }
    for (const rule of config.rules) {
      const parts = rule.split(",");
      const target = parts.at(-1) === "no-resolve" ? parts.at(-2) : parts.at(-1);
      assert.ok(known.has(target), `${rule} -> ${target}`);
    }
    assert.match(await fs.readFile(output, "utf8"), /https:\/\/sub\.example\.invalid\/rules\/geoip\.dat/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pure protocol rendering rejects malformed upstream YAML before publishing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-flybird-invalid-"));
  try {
    const input = path.join(root, "raw.yaml");
    const output = path.join(root, "flybird.yaml");
    await fs.writeFile(input, raw.replace("proxies:\n", "proxies:\n  - malformed\n"));
    const result = spawnSync(process.execPath, [script, "--in", input, "--out", output,
      "--base-url", "https://sub.example.invalid"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FlyBird render failed/);
    await assert.rejects(fs.stat(output), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pure protocol rendering accepts block-style YAML from the v1+v2 merger", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-flybird-block-"));
  try {
    const input = path.join(root, "raw.yaml");
    const output = path.join(root, "flybird.yaml");
    await fs.writeFile(input, blockStyleRaw);
    const result = spawnSync(process.execPath, [script, "--in", input, "--out", output,
      "--base-url", "https://sub.example.invalid"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const config = YAML.parse(await fs.readFile(output, "utf8"));
    assert.equal(config.proxies.length, 2);
    assert.equal(config["proxy-groups"].length, 15);
    assert.equal(config.rules.length, 21);
    assert.ok(config.proxies.some((proxy) => proxy.type === "trojan"));
    assert.ok(config.proxies.some((proxy) => proxy.type === "ss"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("network template protects application DNS and preserves node TLS credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-flybird-network-"));
  try {
    const source = YAML.parse(blockStyleRaw);
    source.proxies.push({
      name: "WS TLS node", type: "vless", server: "edge.example.invalid", port: 8443,
      uuid: "11111111-1111-4111-8111-111111111111", tls: true, "skip-cert-verify": false,
      servername: "sni.example.invalid", network: "ws", "ip-version": "ipv6-prefer",
      "ws-opts": { path: "/tunnel?ed=2048", headers: { Host: "host.example.invalid" } },
    });
    source.dns = {
      enable: true, ipv6: true, "enhanced-mode": "fake-ip",
      nameserver: ["223.5.5.5"], fallback: ["119.29.29.29"],
      "fallback-filter": { geoip: true },
      "fake-ip-filter": ["+.device.example.invalid"],
      "nameserver-policy": { "+.private.example.invalid": "https://dns.example.invalid/dns-query" },
    };
    source.sniffer = { enable: false, "skip-domain": ["printer.example.invalid"] };
    const input = path.join(root, "raw.yaml");
    const output = path.join(root, "flybird.yaml");
    await fs.writeFile(input, YAML.stringify(source));
    const result = spawnSync(process.execPath, [script, "--in", input, "--out", output,
      "--base-url", "https://sub.example.invalid"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const config = YAML.parse(await fs.readFile(output, "utf8"));
    assert.deepEqual(config.proxies, source.proxies);
    assert.equal(config.dns.ipv6, false);
    assert.deepEqual(config.dns.nameserver, [
      "https://1.1.1.1/dns-query#节点选择", "https://8.8.8.8/dns-query#节点选择",
    ]);
    assert.deepEqual(config.dns["proxy-server-nameserver"], [
      "https://doh.pub/dns-query", "https://dns.alidns.com/dns-query",
    ]);
    assert.equal(config.dns.fallback, undefined);
    assert.equal(config.dns["fallback-filter"], undefined);
    for (const domain of ["agentrouter.org", "anyrouter.top"]) {
      assert.deepEqual(config.dns["nameserver-policy"][`+.${domain}`], config.dns.nameserver);
      const rule = `DOMAIN-SUFFIX,${domain},AI服务`;
      assert.ok(config.rules.indexOf(rule) >= 0);
      assert.ok(config.rules.indexOf(rule) < config.rules.indexOf("GEOIP,CN,DIRECT,no-resolve"));
    }
    assert.ok(config.dns["fake-ip-filter"].includes("+.device.example.invalid"));
    assert.equal(config.dns["nameserver-policy"]["+.private.example.invalid"], source.dns["nameserver-policy"]["+.private.example.invalid"]);
    assert.equal(config.sniffer.enable, true);
    assert.equal(config.sniffer["parse-pure-ip"], true);
    assert.equal(config.sniffer.sniff.TLS["override-destination"], true);
    assert.ok(config.sniffer["skip-domain"].includes("printer.example.invalid"));
    assert.equal(config.tun, undefined, "publishing must not enable TUN on the host");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
