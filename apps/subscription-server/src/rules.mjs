import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./cache.mjs";

const RULES_BASE = "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest";
const ALLOWED_ASSETS = new Set(["geoip.dat", "geosite.dat", "country.mmdb", "GeoLite2-ASN.mmdb"]);
const MAXIMUM_BYTES = 128 * 1024 * 1024;

export function createRuleLoader(options) {
  const cacheDirectory = options.cacheDirectory;
  const maximumAgeMs = options.maximumAgeMs ?? 24 * 60 * 60 * 1000;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function loadRuleAsset(asset) {
    if (!ALLOWED_ASSETS.has(asset)) return null;
    const filePath = path.join(cacheDirectory, asset);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size > 0 && Date.now() - stat.mtimeMs < maximumAgeMs) {
        return fs.readFile(filePath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const response = await fetchImpl(`${RULES_BASE}/${asset}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Rules upstream returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAXIMUM_BYTES) throw new Error("Rules asset is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAXIMUM_BYTES) throw new Error("Rules asset has an invalid size");
    await atomicWrite(filePath, bytes);
    return bytes;
  };
}
