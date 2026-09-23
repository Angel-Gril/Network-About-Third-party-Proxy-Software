#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMonoCloudSubscription } from "./client.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const credentialPath = option("--credentials");
const outputPath = option("--out-dir");
if (!credentialPath || !outputPath) {
  process.stderr.write("Usage: monocloud-export --credentials <private.json> --out-dir <new-directory>\n");
  process.exit(2);
}

const output = path.resolve(outputPath);
let credentials;
try {
  credentials = JSON.parse(await fs.readFile(path.resolve(credentialPath), "utf8"));
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await fs.stat(output).then(() => { throw new Error("Output directory already exists"); },
    (error) => { if (error?.code !== "ENOENT") throw error; });
  const result = await fetchMonoCloudSubscription(credentials);
  const temporary = `${output}.tmp-${process.pid}`;
  await fs.mkdir(temporary, { recursive: false, mode: 0o700 });
  try {
    await fs.writeFile(path.join(temporary, "monocloud_clash.yaml"), result.yaml, { mode: 0o600 });
    const links = `${result.links.join("\n")}\n`;
    await fs.writeFile(path.join(temporary, "monocloud_ss.txt"), links, { mode: 0o600 });
    await fs.writeFile(path.join(temporary, "monocloud_v2rayn.txt"), Buffer.from(links, "utf8").toString("base64"),
      { mode: 0o600 });
    await fs.writeFile(path.join(temporary, "monocloud_meta.json"), `${JSON.stringify({
      source: "account-api", provider: "monocloud", node_count: result.nodeCount,
      plan_count: result.planCount, account: result.account,
      api_host: result.baseHost, fetched_at_utc: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, output);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, provider: "monocloud", nodeCount: result.nodeCount })}\n`);
} catch (error) {
  process.stderr.write(`MonoCloud export failed: ${String(error?.message || error).slice(0, 300)}\n`);
  process.exitCode = 1;
} finally {
  if (credentials) credentials.email = credentials.password = "";
}
