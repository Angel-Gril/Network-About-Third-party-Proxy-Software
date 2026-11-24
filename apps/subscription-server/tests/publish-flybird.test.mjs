import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const script = fileURLToPath(new URL("../src/publish-flybird.mjs", import.meta.url));
const source = { dns: { ipv6: true }, proxies: [{ name: "Japan-01", type: "anytls",
  server: "entry.example.invalid", port: 443, password: "synthetic-password", sni: "tls.example.invalid" }],
  "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["Japan-01"] }], rules: ["MATCH,PROXY"] };

test("raw fetch and domain publication advance independently of failed entry enhancement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "publish-flybird-"));
  try {
    const file = name => path.join(root, name);
    await fs.writeFile(file("input"), YAML.stringify(source));
    let result = spawnSync(process.execPath, [script, "raw", "--in", file("input"), "--out", file("raw"),
      "--metadata", file("raw.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(YAML.parse(await fs.readFile(file("raw"), "utf8")), source);
    await fs.mkdir(file("cache"));
    await fs.writeFile(file("cache/flybird.yaml"), "previous distribution");
    await fs.writeFile(file("enhanced"), "keep verified enhanced artifact");
    await fs.writeFile(file("entry.json"), JSON.stringify({ error: "Entry DNS unavailable" }));
    result = spawnSync(process.execPath, [script, "distribution", "--in", file("input"), "--out", file("output"),
      "--mode", "client-dns", "--raw-metadata", file("raw.json"), "--entry-metadata", file("entry.json"),
      "--enhanced-out", file("enhanced"), "--private", "1", "--cache-dir", file("cache")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(await fs.readFile(file("cache/flybird.json"), "utf8"));
    assert.equal(metadata.publicationMode, "client-dns");
    assert.equal(metadata.lastError, null);
    assert.equal(metadata.enhancement.status, "unavailable");
    assert.equal(metadata.delegatedHostCount, 1);
    assert.ok(metadata.rawFetchedAt);
    assert.equal(await fs.readFile(file("enhanced"), "utf8"), "keep verified enhanced artifact");
    assert.equal(await fs.readFile(file("cache/flybird.previous.yaml"), "utf8"), "previous distribution");
    assert.equal(await fs.readFile(file("output"), "utf8"), await fs.readFile(file("cache/flybird.yaml"), "utf8"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("publication cannot mix new raw identities with a previous or rewritten candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "publish-flybird-binding-"));
  try {
    const file = name => path.join(root, name);
    await fs.writeFile(file("input"), YAML.stringify(source));
    assert.equal(spawnSync(process.execPath, [script, "raw", "--in", file("input"), "--out", file("raw"),
      "--metadata", file("raw.json")]).status, 0);
    await fs.writeFile(file("output"), "last output");
    await fs.writeFile(file("entry.json"), "{}");
    for (const [field, value] of [["password", "different-password"], ["server", "93.184.216.34"]]) {
      const wrong = structuredClone(source); wrong.proxies[0][field] = value;
      await fs.writeFile(file("candidate"), YAML.stringify(wrong));
      const result = spawnSync(process.execPath, [script, "distribution", "--in", file("candidate"),
        "--out", file("output"), "--mode", "client-dns", "--raw-metadata", file("raw.json"),
        "--entry-metadata", file("entry.json"), "--private", "0"], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.equal(await fs.readFile(file("output"), "utf8"), "last output");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
