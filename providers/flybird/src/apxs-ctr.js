const enc = new TextEncoder();

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return enc.encode(value);
  throw new TypeError("APXS body must be a byte array");
}

function base64ToBytes(value) {
  const text = String(value || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!text || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error("APXS AES key is not valid Base64");
  }
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function readU32(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3];
}

/**
 * Decode the APXS v2 envelope used by the current OpenWrt/desktop client.
 * The payload is AES-256-CTR with a GCM-style counter: nonce || uint32_be(2).
 * The final 80 bytes are excluded from encryption (16-byte legacy field plus
 * 64-byte signature); signature verification is deliberately separate because
 * the upstream signing scope is version-specific.
 */
export async function decryptApxsCtrDetailed(body, key) {
  const raw = toBytes(body);
  if (raw.length < 25 + 80 || raw[0] !== 0x41 || raw[1] !== 0x50
    || raw[2] !== 0x58 || raw[3] !== 0x53 || raw[4] !== 0x02) {
    throw new Error("invalid APXS v2 CTR envelope");
  }
  const keyBytes = typeof key === "string" ? base64ToBytes(key) : toBytes(key);
  if (keyBytes.length !== 32) throw new Error("APXS AES-CTR key must be 32 bytes");
  const nonce = raw.slice(13, 25);
  const counter = new Uint8Array(16);
  counter.set(nonce, 0);
  counter.set([0, 0, 0, 2], 12);
  const ciphertext = raw.slice(25, -80);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-CTR" }, false, ["decrypt"],
  );
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-CTR", counter, length: 32 }, cryptoKey, ciphertext,
  ));
  return {
    bytes: plain,
    aesId: readU32(raw, 5),
    signId: readU32(raw, 9),
    nonce,
    ciphertextLength: ciphertext.length,
    trailerLength: 80,
    signatureVerified: null,
  };
}

export async function decryptApxsCtr(body, key) {
  return (await decryptApxsCtrDetailed(body, key)).bytes;
}

export function buildApxsCtrEnvelope(plaintext, key, nonce, trailer = new Uint8Array(80)) {
  const keyBytes = typeof key === "string" ? base64ToBytes(key) : toBytes(key);
  if (keyBytes.length !== 32 || nonce.length !== 12 || trailer.length !== 80) {
    throw new Error("invalid APXS CTR test vector dimensions");
  }
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, ["encrypt"])
    .then((cryptoKey) => {
      const counter = new Uint8Array(16);
      counter.set(nonce, 0);
      counter.set([0, 0, 0, 2], 12);
      return crypto.subtle.encrypt(
        { name: "AES-CTR", counter, length: 32 }, cryptoKey, toBytes(plaintext),
      );
    })
    .then((ciphertext) => {
      const header = new Uint8Array(25);
      header.set([0x41, 0x50, 0x58, 0x53, 0x02], 0);
      header.set([0, 0, 0, 1], 5);
      header.set([0, 0, 0, 1], 9);
      header.set(nonce, 13);
      const out = new Uint8Array(header.length + ciphertext.byteLength + trailer.length);
      out.set(header, 0);
      out.set(new Uint8Array(ciphertext), header.length);
      out.set(trailer, header.length + ciphertext.byteLength);
      return out;
    });
}
