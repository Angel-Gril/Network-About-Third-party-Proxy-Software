import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";

const refreshScript = fileURLToPath(new URL("../src/refresh-provider.mjs", import.meta.url));

async function runFixture({ fail = false, automaticLogin = false, busy = false, nodeName = "one", moduleMode = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-refresh-"));
  const cache = path.join(root, "cache");
  await fs.mkdir(cache);
  const source = path.join(root, "source.yaml");
  const valid = JSON.stringify({ proxies: [{
    name: nodeName, type: "vless", server: "203.0.113.8", port: 443,
    uuid: "11111111-1111-4111-8111-111111111111", network: "ws", tls: true,
    "skip-cert-verify": true, "ws-opts": { path: "/synthetic?ed=2048", headers: { Host: "edge.example.invalid" } },
  }], "proxy-groups": [{ name: "PROXY", type: "select", proxies: [nodeName] }], rules: ["MATCH,PROXY"] });
  await fs.writeFile(source, valid);
  await fs.writeFile(path.join(cache, "leapvpn.yaml"), "previous-validated-content");
  const exporter = path.join(root, "exporter.mjs");
  const networkGuard = path.join(root, "network-guard.mjs");
  await fs.writeFile(networkGuard,
    'globalThis.fetch = async () => { throw new Error("Network access is disabled in subscription refresh tests"); };');
  await fs.writeFile(exporter, busy ? 'process.exit(75);' : fail ?
    'process.stderr.write("private-session-token-must-not-be-logged"); process.exit(3);' :
    `import fs from 'node:fs/promises'; import path from 'node:path';
     const args=process.argv.slice(2); const out=args[args.indexOf('--out-dir')+1];
     const automatic=args.includes('--credentials');
     const input=args[args.indexOf(automatic?'--credentials':'--settings')+1];
     if (automatic ? !args.includes('--state') : !args.includes('--fetch-all')) process.exit(4);
     await fs.mkdir(out); await fs.copyFile(input,path.join(out,'leap_clash.yaml'));
     if(automatic) await fs.writeFile(path.join(out,'leap_meta.json'), JSON.stringify({authentication:{
       mode:'device_credentials',session_renewed:true,account_login:false,session_expires_at_ms:4102444800000,
        password:'private-account-password-must-not-be-logged'}}));`);
  const moduleTrace = path.join(root, "module-call.json");
  if (moduleMode) {
    const packageDirectory = path.join(root, "leapvpn");
    await fs.mkdir(packageDirectory);
    await fs.writeFile(path.join(packageDirectory, "__init__.py"), "");
    const moduleSource = `import argparse, json, os
from pathlib import Path

automatic = __spec__.name == 'leapvpn.refresh'
parser = argparse.ArgumentParser()
parser.add_argument('--out-dir', required=True)
if automatic:
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--state', required=True)
else:
    parser.add_argument('--settings', required=True)
    parser.add_argument('--fetch-all', action='store_true')
args = parser.parse_args()
if not automatic and not args.fetch_all:
    parser.error('--fetch-all is required')
source = Path(args.credentials if automatic else args.settings)
output = Path(args.out_dir)
output.mkdir()
(output / 'leap_clash.yaml').write_bytes(source.read_bytes())
if automatic:
    (output / 'leap_meta.json').write_text(json.dumps({'authentication': {
        'mode': 'device_credentials', 'session_renewed': True,
        'account_login': False, 'session_expires_at_ms': 4102444800000}}))
Path(os.environ['MODULE_TRACE_FILE']).write_text(json.dumps({
    'module': __spec__.name, 'arguments': vars(args)}))
`;
    for (const name of ["refresh", "export"]) {
      await fs.writeFile(path.join(packageDirectory, `${name}.py`), moduleSource);
    }
  }
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:FLYBIRD|LEAPVPN)_/.test(key)));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(networkGuard).href, refreshScript, "leapvpn"], {
    cwd: root,
    env: { ...environment, SUBSCRIPTION_CACHE_DIR: cache,
      LEAPVPN_SESSION_FILE: source,
      LEAPVPN_PYTHON: moduleMode ? (process.platform === "win32" ? "python" : "python3") : process.execPath,
      LEAPVPN_EXPORT_SCRIPT: moduleMode ? undefined : exporter,
      PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1", MODULE_TRACE_FILE: moduleTrace,
      PUBLIC_DOMAIN: "sub.example.invalid",
      LEAPVPN_CREDENTIAL_FILE: automaticLogin ? source : undefined,
      LEAPVPN_AUTH_STATE_FILE: automaticLogin ? path.join(root,'state.json') : undefined },
    encoding: "utf8", timeout: 10000,
  });
  return { root, cache, source, valid, result, moduleTrace };
}

test("LeapVPN refresh validates the exported file and commits the last-good cache", async () => {
  const f = await runFixture();
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    const config = YAML.parse(await fs.readFile(path.join(f.cache, "leapvpn.yaml"), "utf8"));
    assert.deepEqual(config.proxies, JSON.parse(f.valid).proxies);
    assert.ok(config.rules.includes("GEOSITE,openai,AI服务"));
    assert.equal(config.rules.at(-1), "MATCH,漏网之鱼");
    assert.deepEqual(config["proxy-groups"].find(group => group.name === "自动选择").proxies, ["one"]);
    assert.equal(config["geox-url"].geoip, "https://sub.example.invalid/rules/geoip.dat");
    assert.equal(await fs.readFile(path.join(f.cache, "leapvpn.previous.yaml"), "utf8"), "previous-validated-content");
    const meta = JSON.parse(await fs.readFile(path.join(f.cache, "leapvpn.json")));
    assert.equal(meta.provider, "leapvpn");
    assert.equal(meta.proxyCount, 1);
    assert.equal(meta.routing.template, "flybird");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("failed LeapVPN refresh keeps the old file and does not log child secrets", async () => {
  const f = await runFixture({ fail: true });
  try {
    assert.equal(f.result.status, 1);
    assert.equal(await fs.readFile(path.join(f.cache, "leapvpn.yaml"), "utf8"), "previous-validated-content");
    const metadata = await fs.readFile(path.join(f.cache, "leapvpn.json"), "utf8");
    assert.ok(JSON.parse(metadata).lastError);
    assert.doesNotMatch(f.result.stderr + metadata, /private-session-token-must-not-be-logged/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("automatic login passes only private file paths and publishes sanitized authentication status", async () => {
  const f = await runFixture({ automaticLogin: true });
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    const text = await fs.readFile(path.join(f.cache, "leapvpn.json"), "utf8");
    const meta = JSON.parse(text);
    assert.deepEqual(meta.authentication, {mode:"device_credentials", sessionRenewed:true,
      accountLogin:false, sessionExpiresAtMs:4102444800000});
    assert.doesNotMatch(text + f.result.stdout + f.result.stderr, /private-account-password/);
  } finally { await fs.rm(f.root, {recursive:true, force:true}); }
});

test("failed automatic login preserves the previously published subscription", async () => {
  const f = await runFixture({ fail: true, automaticLogin: true });
  try {
    assert.equal(f.result.status, 1);
    assert.equal(await fs.readFile(path.join(f.cache,"leapvpn.yaml"),"utf8"), "previous-validated-content");
    assert.doesNotMatch(f.result.stderr, /private-session-token/);
  } finally { await fs.rm(f.root, {recursive:true, force:true}); }
});

test("a concurrent automatic refresh skips without replacing cache or recording a failure", async () => {
  const f = await runFixture({ automaticLogin: true, busy: true });
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(JSON.parse(f.result.stdout).skipped, true);
    assert.equal(await fs.readFile(path.join(f.cache,"leapvpn.yaml"),"utf8"), "previous-validated-content");
    await assert.rejects(fs.stat(path.join(f.cache,"leapvpn.json")), {code:"ENOENT"});
  } finally { await fs.rm(f.root, {recursive:true, force:true}); }
});

test("invalid node or policy names retain the last-good subscription instead of publishing only nodes", async()=>{
  for (const nodeName of ["DIRECT", "节点选择"]) {
    const f = await runFixture({ automaticLogin: true, nodeName });
    try {
      assert.equal(f.result.status, 1);
      assert.equal(await fs.readFile(path.join(f.cache,"leapvpn.yaml"),"utf8"),"previous-validated-content");
      const metadata = JSON.parse(await fs.readFile(path.join(f.cache,"leapvpn.json"),"utf8"));
      assert.match(metadata.lastError, /valid proxy names|conflicting policy names/);
    } finally { await fs.rm(f.root,{recursive:true,force:true}); }
  }
});

for (const automaticLogin of [true, false]) {
  const moduleName = automaticLogin ? "leapvpn.refresh" : "leapvpn.export";
  test(`LeapVPN defaults to the installed ${moduleName} module without a command-file override`, async () => {
    const f = await runFixture({ automaticLogin, moduleMode: true });
    try {
      assert.equal(f.result.status, 0, f.result.stderr);
      const call = JSON.parse(await fs.readFile(f.moduleTrace, "utf8"));
      assert.equal(call.module, moduleName);
      if (automaticLogin) {
        assert.equal(call.arguments.credentials, f.source);
        assert.equal(call.arguments.state, path.join(f.root, "state.json"));
      } else {
        assert.equal(call.arguments.settings, f.source);
        assert.equal(call.arguments.fetch_all, true);
      }
      const config = YAML.parse(await fs.readFile(path.join(f.cache, "leapvpn.yaml"), "utf8"));
      assert.deepEqual(config.proxies, JSON.parse(f.valid).proxies);
      assert.equal(config.rules.at(-1), "MATCH,漏网之鱼");
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
}
