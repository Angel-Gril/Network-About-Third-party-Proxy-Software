const enc = new TextEncoder();
const dec = new TextDecoder();

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return enc.encode(value);
  throw new TypeError("APXS body must be a string or byte array");
}

function concat(...parts) {
  const total = parts.reduce((size, part) => size + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base64ToBytes(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("invalid Base64 APXS value");
  }
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function ascii(value) {
  return new TextDecoder("latin1").decode(value).trim();
}

function looksBase64(value) {
  const text = String(value || "").trim();
  return text.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(text);
}

function looksHex(value) {
  const text = String(value || "").trim();
  return text.length >= 32 && text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text);
}

function uniqueBytes(values) {
  const seen = new Set();
  return values.filter(({ value }) => {
    const key = [...value].join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

async function keyVariants(credential) {
  const fields = [
    ["encryptKey", credential?.encryptKey],
    ["encrypt_key", credential?.encrypt_key],
    ["accessKey", credential?.accessKey],
    ["access_key", credential?.access_key],
    ["key", credential?.key],
    ["token", credential?.token],
  ];
  const candidates = [];
  for (const [name, source] of fields) {
    if (typeof source !== "string" || !source.trim()) continue;
    const value = source.trim();
    const raw = enc.encode(value);
    candidates.push({ name: `${name}:raw`, value: raw });
    if (looksBase64(value)) {
      try {
        const decoded = base64ToBytes(value);
        candidates.push({ name: `${name}:base64`, value: decoded });
        candidates.push({ name: `${name}:sha256(base64)`, value: await sha256(decoded) });
      } catch { /* Try the raw form. */ }
    }
    if (looksHex(value)) {
      try {
        const decoded = new Uint8Array(value.length / 2);
        for (let index = 0; index < decoded.length; index += 1) {
          decoded[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
        }
        candidates.push({ name: `${name}:hex`, value: decoded });
        candidates.push({ name: `${name}:sha256(hex)`, value: await sha256(decoded) });
      } catch { /* Try the raw form. */ }
    }
    candidates.push({ name: `${name}:sha256`, value: await sha256(raw) });
  }
  return uniqueBytes(candidates).filter(({ value }) => [16, 24, 32].includes(value.length));
}

function layouts(raw) {
  const out = [];
  // APXS 02 wire envelope observed from the mTLS v2 endpoint:
  // "APXS" + version(02) + u32 flags(1) + u32 flags(1) + nonce(12) + ct + tag(16).
  if (raw.length >= 4 + 1 + 4 + 4 + 12 + 16
    && raw[0] === 0x41 && raw[1] === 0x50 && raw[2] === 0x58 && raw[3] === 0x53
    && raw[4] === 0x02) {
    const start = 4 + 1 + 4 + 4;
    out.push(["APXS02+flags+nonce12+ct+tag16", raw.slice(start, start + 12), raw.slice(start + 12, -16), raw.slice(-16)]);
  }
  if (raw.length >= 28) {
    out.push(["nonce12+ct+tag16", raw.slice(0, 12), raw.slice(12, -16), raw.slice(-16)]);
    out.push(["tag16+nonce12+ct", raw.slice(16, 28), raw.slice(28), raw.slice(0, 16)]);
    out.push(["nonce12+tag16+ct", raw.slice(0, 12), raw.slice(28), raw.slice(12, 28)]);
  }
  return out;
}

function looksLikeMihomoYaml(value) {
  return /(^|\n)\s*(proxies|proxy-providers):\s*(\n|$)/.test(value);
}

async function maybeDecodePlaintext(value) {
  const text = dec.decode(value);
  if (looksLikeMihomoYaml(text)) return { bytes: value, text };

  if (looksBase64(text)) {
    try {
      const decoded = base64ToBytes(text);
      const decodedText = dec.decode(decoded);
      if (looksLikeMihomoYaml(decodedText)) return { bytes: decoded, text: decodedText };
    } catch { /* Continue with the raw plaintext. */ }
  }

  const decoded = await decodeCompressedBytes(value);
  if (decoded) {
    const decompressedText = dec.decode(decoded);
    if (looksLikeMihomoYaml(decompressedText)) {
      return { bytes: decoded, text: decompressedText };
    }
  }
  return null;
}

async function decodeCompressedBytes(value) {
  const compression = value[0] === 0x1f && value[1] === 0x8b
    ? "gzip"
    : value[0] === 0x78
      ? "deflate"
      : "";
  if (!compression || typeof DecompressionStream !== "function") return null;
  try {
    const stream = new Blob([value]).stream().pipeThrough(new DecompressionStream(compression));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Decode HTTP Content-Encoding when the runtime did not already do it. */
export async function decodeHttpContent(body, contentEncoding = "") {
  const raw = bytes(body);
  const encoding = String(contentEncoding || "").toLowerCase();
  const format = encoding.includes("gzip") ? "gzip"
    : encoding.includes("deflate") ? "deflate" : "";
  const hasMagic = format === "gzip"
    ? raw[0] === 0x1f && raw[1] === 0x8b
    : format === "deflate" && raw[0] === 0x78;
  if (!format || !hasMagic) return { bytes: raw, compressed: false, encoding: "" };
  const decoded = await decodeCompressedBytes(raw);
  if (!decoded) throw new Error(`HTTP ${format} body could not be decompressed`);
  return { bytes: decoded, compressed: true, encoding: format };
}

function parseJsonEnvelope(raw) {
  const text = dec.decode(raw).trim();
  if (!text.startsWith("{")) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  const data = parsed?.data || parsed?.payload || parsed?.ciphertext || parsed?.content;
  if (typeof data !== "string") return null;
  let blob;
  try { blob = base64ToBytes(data); } catch { blob = enc.encode(data); }
  const decodeOptional = (value) => {
    if (typeof value !== "string" || !value) return null;
    try { return base64ToBytes(value); } catch { return enc.encode(value); }
  };
  return {
    label: "json",
    blob,
    nonce: decodeOptional(parsed.nonce || parsed.iv),
    tag: decodeOptional(parsed.tag),
  };
}

function bodyVariants(input) {
  const raw = bytes(input);
  const variants = [{ label: "raw", blob: raw }];
  const text = ascii(raw);
  if (looksHex(text)) {
    try {
      const decoded = new Uint8Array(text.length / 2);
      for (let index = 0; index < decoded.length; index += 1) {
        decoded[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
      }
      variants.push({ label: "hex", blob: decoded });
    } catch { /* Keep raw. */ }
  }
  if (looksBase64(text)) {
    try { variants.push({ label: "base64", blob: base64ToBytes(text) }); } catch { /* Keep raw. */ }
  }
  const json = parseJsonEnvelope(raw);
  if (json) variants.push(json);
  const prefix = text.match(/^(?:apxs2?|apex-sub-v2|v2)\s*[:=]\s*(.+)$/is);
  if (prefix && looksBase64(prefix[1])) {
    try { variants.push({ label: "prefixed-base64", blob: base64ToBytes(prefix[1]) }); } catch { /* Keep raw. */ }
  }
  const seen = new Set();
  const fingerprint = (value) => {
    const head = [...value.slice(0, 12)].join(",");
    const tail = [...value.slice(-12)].join(",");
    return `${value.length}:${head}:${tail}`;
  };
  return variants.filter((variant) => {
    const key = `${variant.label}:${fingerprint(variant.blob)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function decryptCandidate(keyBytes, nonce, ciphertext, tag) {
  if (!nonce || !tag || tag.length !== 16) return null;
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      key,
      concat(ciphertext, tag),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

/**
 * Decrypt an APXS v2 response and return YAML plus the matched layout/key.
 * The body must be kept byte-for-byte intact until this function is called.
 */
export async function decryptApxsV2Detailed(body, credential = {}) {
  const keys = await keyVariants(credential);
  if (!keys.length) throw new Error("APXS v2 credential has no usable encryption key");

  for (const variant of bodyVariants(body)) {
    const candidates = [];
    if (variant.nonce && variant.tag) {
      candidates.push(["json-explicit", variant.nonce, variant.blob, variant.tag]);
    }
    // A JSON envelope may include nonce/tag metadata while data still holds
    // the complete wire envelope. Keep the explicit form first, then retry
    // the standard layouts against data itself.
    candidates.push(...layouts(variant.blob));
    for (const [layout, nonce, ciphertext, tag] of candidates) {
      for (const key of keys) {
        const plain = await decryptCandidate(key.value, nonce, ciphertext, tag);
        if (!plain) continue;
        const decoded = await maybeDecodePlaintext(plain);
        if (!decoded) continue;
        return {
          yaml: decoded.text,
          bytes: decoded.bytes,
          bodyEncoding: variant.label,
          layout,
          key: key.name,
        };
      }
    }
  }
  throw new Error("APXS v2 decryption failed: unknown envelope, layout, or key");
}

export async function decryptApxsV2(body, credential = {}) {
  return (await decryptApxsV2Detailed(body, credential)).yaml;
}

function signatureCandidates(value) {
  const text = String(value || "").trim();
  const result = [{ name: "raw", value: enc.encode(text) }];
  if (looksBase64(text)) {
    try { result.push({ name: "base64", value: base64ToBytes(text) }); } catch { /* raw only */ }
  }
  if (looksHex(text)) {
    try {
      const decoded = new Uint8Array(text.length / 2);
      for (let index = 0; index < decoded.length; index += 1) {
        decoded[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
      }
      result.push({ name: "hex", value: decoded });
    } catch { /* raw only */ }
  }
  return uniqueBytes(result);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function encodedSignatures(value) {
  const text = String(value || "").trim().replace(/^sha256=/i, "");
  const candidates = [];
  if (looksHex(text)) {
    try {
      const decoded = new Uint8Array(text.length / 2);
      for (let index = 0; index < decoded.length; index += 1) {
        decoded[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
      }
      candidates.push({ value: decoded, encoding: "hex" });
    } catch { /* Try Base64 below. */ }
  }
  if (looksBase64(text)) {
    try { candidates.push({ value: base64ToBytes(text), encoding: "base64" }); } catch { /* Ignore malformed signatures. */ }
  }
  return candidates;
}

/** Verify an apex-sub-sign-v2 HMAC over ciphertext or plaintext bytes. */
export async function verifyApxsV2Signature(body, signature, signKey, plaintext = null) {
  return (await verifyApxsV2SignatureDetailed(body, signature, signKey, plaintext)).ok;
}

export async function verifyApxsV2SignatureDetailed(body, signature, signKey, plaintext = null) {
  if (!signature || !signKey) return { ok: null, scope: null, encoding: null };
  const expected = encodedSignatures(signature);
  if (!expected.length) return { ok: false, scope: null, encoding: null };
  const dataVariants = [bytes(body)];
  if (plaintext !== null && plaintext !== undefined) dataVariants.push(bytes(plaintext));
  for (const key of signatureCandidates(signKey)) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw", key.value, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    for (const [index, data] of dataVariants.entries()) {
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
      const matched = expected.find((candidate) => constantTimeEqual(candidate.value, mac));
      if (matched) {
        return {
          ok: true,
          scope: index === 0 ? "ciphertext" : "plaintext",
          encoding: matched.encoding,
        };
      }
    }
  }
  return { ok: false, scope: null, encoding: null };
}
