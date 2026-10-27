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
