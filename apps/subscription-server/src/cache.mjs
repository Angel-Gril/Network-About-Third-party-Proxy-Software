import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function atomicWrite(filePath, content, mode = 0o600) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const options = typeof content === "string" ? { encoding: "utf8", mode } : { mode };
  try {
    const handle = await fs.open(temporary, "wx", mode);
    try {
      await handle.writeFile(content, options);
      // The root publisher also records failures in the service user's metadata.
      if (process.getuid?.() === 0) {
        try {
          const previous = await fs.stat(filePath);
          await handle.chown(previous.uid, previous.gid);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, filePath); break; }
      catch (error) {
        // Windows readers/AV can briefly hold the destination. Never delete it
        // to make replacement succeed: a persistent error must preserve it.
        const maximumRetries = process.platform === "win32" ? 20 : 3;
        if (attempt >= maximumRetries || !["EPERM", "EBUSY"].includes(error.code)) throw error;
        // Avoid repeatedly colliding with a short-period Windows reader.
        await delay(Math.min(200, 10 * 2 ** attempt) + (process.platform === "win32" ? 1 + crypto.randomInt(16) : 0));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function commitLastGood(cacheDirectory, provider, yaml, details = {}) {
  const currentPath = path.join(cacheDirectory, `${provider}.yaml`);
  const metadataPath = path.join(cacheDirectory, `${provider}.json`);
  let previous = null;
  try {
    previous = await fs.readFile(currentPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const hash = sha256(yaml);
  const changed = previous === null || sha256(previous) !== hash;
  if (changed && previous !== null) {
    await atomicWrite(path.join(cacheDirectory, `${provider}.previous.yaml`), previous);
  }
  if (changed) await atomicWrite(currentPath, yaml);

  const metadata = {
    schemaVersion: 1,
    provider,
    updatedAt: new Date().toISOString(),
    changed,
    sha256: hash,
    proxyCount: Number(details.proxyCount || 0),
    validatedHostCount: Number(details.validatedHostCount || 0),
    recoveredServerCount: Number(details.recoveredServerCount || 0),
    delegatedHostCount: Number(details.delegatedHostCount || 0),
    lastError: null,
  };
  if (details.authentication) metadata.authentication = details.authentication;
  if (details.account) metadata.account = details.account;
  if (details.routing) metadata.routing = details.routing;
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function recordFailure(cacheDirectory, provider, error) {
  const metadataPath = path.join(cacheDirectory, `${provider}.json`);
  const current = await readJson(metadataPath, { schemaVersion: 1, provider, updatedAt: null, proxyCount: 0 });
  const metadata = {
    ...current,
    failedAt: new Date().toISOString(),
    lastError: String(error?.message || error || "Refresh failed").slice(0, 500),
  };
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}
