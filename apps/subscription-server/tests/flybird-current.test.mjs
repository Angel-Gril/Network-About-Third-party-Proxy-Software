import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";

const refreshScript = fileURLToPath(new URL("../src/refresh-provider.mjs", import.meta.url));
const node = { name: "synthetic", type: "vless", server: "203.0.113.8", port: 443,
  uuid: "11111111-1111-4111-8111-111111111111", tls: true,
  servername: "tls.example", flow: "xtls-rprx-vision", network: "tcp", "skip-cert-verify": false };

for (const tampered of [false, true]) {
  test(tampered ? "bad GCM tag preserves the last-good FlyBird cache" : "FlyBird refresh publishes authenticated current-client nodes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "flybird-current-"));
    try {
      const cache = path.join(root, "cache");
      await fs.mkdir(cache);
      await fs.writeFile(path.join(cache, "flybird.yaml"), "previous-validated-content");
      const credentials = path.join(root, "credentials.json");
      await fs.writeFile(credentials, JSON.stringify({ email: "owner@example.invalid", password: "synthetic-secret" }));
      const nonce = Buffer.from("000102030405060708090a0b", "hex");
      const key = createHash("sha256").update("fd53c838dbceff962d5d2aed5cdc548e").digest();
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const plaintext = "proxies:\n  - " + JSON.stringify(node) + "\n";
      const bytes = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      if (tampered) bytes[bytes.length - 1] ^= 1;
      const mock = path.join(root, "upstream.mjs");
      await fs.writeFile(mock, [
        "globalThis.fetch = async (url, init = {}) => {",
        " const path = new URL(url).pathname;",
        ' if (path.endsWith("/passport/auth/login")) return Response.json({status:"success",data:{token:"synthetic-token",auth_data:"synthetic-auth"}});',
        ' if (path.endsWith("/user/getSubscribe")) return Response.json({status:"success",data:{}});',
        ' if (path.endsWith("/client/subscribe")) {',
        '  if (init.headers["User-Agent"] !== "securitynet/v3.1.8 clash-verge Platform/windows") return new Response("invalid token", {status:401});',
        "  return new Response(" + JSON.stringify(bytes.toString("base64")) + ");",
        " }",
        ' throw new Error("Unexpected upstream request; real networking disabled");',
        "};",
      ].join("\n"));
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:FLYBIRD|LEAPVPN)_/.test(key)));
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, refreshScript, "flybird"], {
        cwd: root, env: { ...environment, SUBSCRIPTION_CACHE_DIR: cache, FLYBIRD_CREDENTIAL_FILE: credentials,
          PUBLIC_DOMAIN: "sub.example.invalid" }, encoding: "utf8", timeout: 10000,
      });
      const cached = await fs.readFile(path.join(cache, "flybird.yaml"), "utf8");
      const metadata = JSON.parse(await fs.readFile(path.join(cache, "flybird.json"), "utf8"));
      if (tampered) {
        assert.equal(result.status, 1);
        assert.equal(cached, "previous-validated-content");
        assert.ok(metadata.lastError);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(YAML.parse(cached).proxies, [node]);
        assert.equal(metadata.proxyCount, 1);
        assert.equal(await fs.readFile(path.join(cache, "flybird.previous.yaml"), "utf8"), "previous-validated-content");
      }
      assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(metadata), /synthetic-secret|synthetic-auth/);
      assert.ok(!(result.stdout + result.stderr).includes(bytes.toString("base64")));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
