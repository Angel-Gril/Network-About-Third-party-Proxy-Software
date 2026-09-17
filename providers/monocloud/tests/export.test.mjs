import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const exporter = fileURLToPath(new URL("../src/export.mjs", import.meta.url));

test("CLI creates missing parent directories and emits only a sanitized summary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monocloud-export-"));
  try {
    const credentials = path.join(root, "credentials.json");
    const output = path.join(root, "nested", "output");
    await fs.writeFile(credentials, JSON.stringify({email:"owner@example.invalid",password:"private-password"}));
    const mock = path.join(root, "upstream.mjs");
    await fs.writeFile(mock, `globalThis.fetch=async url=>{
      const path=new URL(url).pathname;
      if(path.endsWith('/oauth/token'))return Response.json({access_token:'private-access-token'});
      if(path.endsWith('/api/service'))return Response.json([{id:7,plan:{type:'shadowsocks'}}]);
      if(path.endsWith('/api/shadowsocks/7'))return Response.json([{alias:'Synthetic',emoji:'US',group:'Test',enable:1,hostname:'203.0.113.8',port:443,encryption:'chacha20-ietf-poly1305',password:'private-node-secret'}]);
      throw new Error('Unexpected request');};`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, exporter,
      "--credentials", credentials, "--out-dir", output], { encoding:"utf8", timeout:10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {ok:true,provider:"monocloud",nodeCount:1});
    assert.doesNotMatch(result.stdout + result.stderr, /private-password|private-access-token|private-node-secret/);
    assert.match(await fs.readFile(path.join(output,"monocloud_clash.yaml"),"utf8"), /private-node-secret/);
    assert.equal(JSON.parse(await fs.readFile(path.join(output,"monocloud_meta.json"),"utf8")).node_count, 1);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
