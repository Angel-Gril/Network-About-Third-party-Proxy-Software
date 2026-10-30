// apxs-v2.reference.mjs — 参考实现（Node WebCrypto / node:crypto），仅用于校验夹具与对照你的 apxs-v2.js
//
// 导出 decryptFixture({ body, credential, headers }) -> {
//   plaintext: Buffer, layout: string, keyDerivation: string,
//   signatureOk: boolean|null, signatureScope: 'ciphertext'|'plaintext'|null
// }
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const YAML_RE = /(^|\n)\s*(proxies|proxy-providers)\s*:/;

function b64d(s) {
  const norm = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm + '='.repeat((4 - (norm.length % 4)) % 4), 'base64');
}

function isB64(buf) {
  const s = buf.toString('latin1').trim();
  return s.length >= 24 && /^[A-Za-z0-9+/=\s_-]+$/.test(s);
}

function isHex(buf) {
  const s = buf.toString('latin1').trim();
  return s.length >= 32 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

function decodeBody(body) {
  const out = [['raw', body]];
  if (isHex(body)) {
    try { out.push(['hex', Buffer.from(body.toString('latin1').trim(), 'hex')]); } catch {}
  }
  if (isB64(body)) {
    try { out.push(['base64', b64d(body)]); } catch {}
  }
  return out;
}

function parseJsonEnvelope(body) {
  const text = body.toString('utf8').trim();
  if (!text.startsWith('{')) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  const data = obj.data || obj.payload || obj.ciphertext || obj.content;
  if (typeof data !== 'string') return null;
  const blob = b64d(data);
  const opt = (v) => (typeof v === 'string' && v ? b64d(v) : null);
  return { blob, nonce: opt(obj.nonce || obj.iv), tag: opt(obj.tag) };
}

function keyCandidates(credential) {
  const ek = credential.encrypt_key || credential.encryptKey || credential.access_key || credential.accessKey;
  if (!ek) return [];
  const s = String(ek);
  const out = [['sha256(utf8)', createHash('sha256').update(s, 'utf8').digest()], ['raw-utf8', Buffer.from(s, 'utf8')]];
  try {
    const b = b64d(s);
    out.push(['base64decode', b]);
    out.push(['sha256(b64decode)', createHash('sha256').update(b).digest()]);
  } catch {}
  if (/^[0-9a-fA-F]{32,64}$/.test(s)) {
    try {
      const b = Buffer.from(s, 'hex');
      out.push(['hexdecode', b]);
      out.push(['sha256(hexdecode)', createHash('sha256').update(b).digest()]);
    } catch {}
  }
  return out.filter(([, k]) => [16, 24, 32].includes(k.length));
}

function layoutCandidates(raw) {
  const out = [];
  if (raw.length >= 28) {
    out.push(['nonce-ct-tag', raw.subarray(0, 12), raw.subarray(12, raw.length - 16), raw.subarray(raw.length - 16)]);
    out.push(['tag-nonce-ct', raw.subarray(16, 28), raw.subarray(28), raw.subarray(0, 16)]);
    out.push(['nonce-tag-ct', raw.subarray(0, 12), raw.subarray(28), raw.subarray(12, 28)]);
  }
  return out;
}

function maybeGunzip(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf);
    } catch {}
  }
  return buf;
}

function verifySig(headers, credential, body, plaintext) {
  const rawSig = headers['apex-sub-sign-v2'] || headers['apex-signature'] || headers['x-apex-signature'];
  const sk = credential.sign_key || credential.signKey;
  if (!rawSig || !sk) return { signatureOk: null, signatureScope: null };
  const sig = String(rawSig).trim().replace(/^sha256=/i, '');
  const mac = (data) => createHmac('sha256', String(sk)).update(data).digest();
  const eq = (a, b) => a.length === b.length && timingSafeEqual(a, b);
  const sigBuf = Buffer.from(String(sig), 'latin1');
  const sigHex = /^[0-9a-fA-F]+$/.test(sigBuf.toString('latin1')) ? Buffer.from(sigBuf.toString('latin1'), 'hex') : null;
  const sigB64 = (() => { try { return b64d(sigBuf.toString('latin1')); } catch { return null; } })();
  for (const [scope, data] of [['ciphertext', body], ['plaintext', plaintext]]) {
    const m = mac(data);
    if ((sigHex && eq(sigHex, m)) || (sigB64 && eq(sigB64, m))) return { signatureOk: true, signatureScope: scope };
  }
  return { signatureOk: false, signatureScope: null };
}

export function decryptFixture({ body, credential, headers = {} }) {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const attempts = [];

  const json = parseJsonEnvelope(bodyBuf);
  if (json && json.nonce && json.tag) {
    for (const [kd, key] of keyCandidates(credential)) {
      try {
        const d = createDecipheriv('aes-256-gcm', key, json.nonce);
        d.setAuthTag(json.tag);
        const pt = maybeGunzip(Buffer.concat([d.update(json.blob), d.final()]));
        if (YAML_RE.test(pt.toString('utf8'))) {
          const sig = verifySig(headers, credential, bodyBuf, pt);
          return { plaintext: pt, layout: 'json-explicit', keyDerivation: kd, encoding: 'json', ...sig };
        }
      } catch {}
    }
  }

  for (const [enc, raw] of decodeBody(bodyBuf)) {
    for (const [kd, key] of keyCandidates(credential)) {
      for (const [layout, nonce, ct, tag] of layoutCandidates(raw)) {
        try {
          const d = createDecipheriv('aes-256-gcm', key, nonce);
          d.setAuthTag(tag);
          const pt = maybeGunzip(Buffer.concat([d.update(ct), d.final()]));
          attempts.push({ enc, kd, layout, pt });
          if (YAML_RE.test(pt.toString('utf8'))) {
            const sig = verifySig(headers, credential, bodyBuf, pt);
            return { plaintext: pt, layout, keyDerivation: kd, encoding: enc, ...sig };
          }
        } catch {}
      }
    }
  }
  const err = new Error(`APXS decrypt failed (${attempts.length} attempts)`);
  err.attempts = attempts.length;
  throw err;
}

export default { decryptFixture };
