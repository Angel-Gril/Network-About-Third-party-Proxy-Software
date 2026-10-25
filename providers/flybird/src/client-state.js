const APEX_URL_PREFIX = "apex-url-v2:";
const APEX_MAGIC = new Uint8Array([0x41, 0x50, 0x45, 0x58, 0x02]);
const enc = new TextEncoder();
const dec = new TextDecoder();

function base64ToBytes(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) {
    throw new Error("invalid Base64 value");
  }
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left[index] ^ right[index];
  }
  return result === 0;
}

function parseHttpsUrl(value, fieldName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use https`);
  }
  return parsed.toString();
}

/**
 * Decode the 7.2.x client envelope:
 * Base64("APEX" + version 2 + nonce(12) + ciphertext + GCM tag(16)).
 * The profile key is the Base64 text stored under apex_profile_file_key_v3.
 */
export async function decryptApexUrlV2(value, profileKey) {
  if (!String(value || "").startsWith(APEX_URL_PREFIX)) {
    throw new Error("unsupported Apex URL format");
  }

  const keyBytes = base64ToBytes(profileKey);
  if (keyBytes.length !== 16) {
    throw new Error("Apex profile key must decode to 16 bytes");
  }

  const envelope = base64ToBytes(String(value).slice(APEX_URL_PREFIX.length));
  if (envelope.length < APEX_MAGIC.length + 12 + 16 + 1) {
    throw new Error("Apex URL envelope is truncated");
  }
  if (!bytesEqual(envelope.slice(0, APEX_MAGIC.length), APEX_MAGIC)) {
    throw new Error("Apex URL envelope has an invalid header");
  }

  const nonce = envelope.slice(5, 17);
  const ciphertextAndTag = envelope.slice(17);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ciphertextAndTag,
  );
  return dec.decode(plaintext);
}

function readBundleString(bundle, ...names) {
  for (const name of names) {
    if (typeof bundle?.[name] === "string" && bundle[name].trim()) {
      return bundle[name].trim();
    }
  }
  return "";
}

/**
 * Normalize a Windows-exported client-state bundle for a Linux/Node refresher.
 * The bundle may contain encrypted apex-url-v2 values or already decoded values.
 */
export async function decodeClientStateBundle(bundle) {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("client-state bundle must be an object");
  }
  const profileKey = readBundleString(
    bundle,
    "apexProfileFileKeyV3",
    "profileKey",
  );
  if (!profileKey) throw new Error("client-state bundle is missing profile key");

  const encryptedUrl = readBundleString(bundle, "subscriptionUrl", "subscribeUrl");
  const encryptedToken = readBundleString(bundle, "subscriptionToken", "token");
  const url = encryptedUrl.startsWith(APEX_URL_PREFIX)
    ? await decryptApexUrlV2(encryptedUrl, profileKey)
    : encryptedUrl;
  const token = encryptedToken.startsWith(APEX_URL_PREFIX)
    ? await decryptApexUrlV2(encryptedToken, profileKey)
    : encryptedToken;

  const subscriptionUrl = url ? parseHttpsUrl(url, "subscriptionUrl") : "";
  let subscriptionToken = token;
  if (!subscriptionToken && subscriptionUrl) {
    subscriptionToken = new URL(subscriptionUrl).searchParams.get("token") || "";
  }
  if (!subscriptionToken) throw new Error("client-state bundle is missing subscription token");

  return {
    format: String(bundle.format || "flybird-client-state/v1"),
    clientVersion: readBundleString(bundle, "clientVersion", "version"),
    capturedAt: readBundleString(bundle, "capturedAt"),
    subscriptionUrl,
    subscriptionToken,
    xboardToken: readBundleString(bundle, "xboardToken"),
  };
}

