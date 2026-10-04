// Utilidades criptográficas (solo WebCrypto, sin dependencias).
const enc = new TextEncoder();

export function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomSalt(n = 16) {
  return b64u(crypto.getRandomValues(new Uint8Array(n)));
}

// Comparación en tiempo constante (longitudes públicas).
export function safeEqual(a, b) {
  const x = typeof a === "string" ? enc.encode(a) : a;
  const y = typeof b === "string" ? enc.encode(b) : b;
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// Hash de PIN: HMAC-SHA256 con pepper (secret del Worker, jamás en Firestore)
// seguido de PBKDF2-SHA256 con sal por usuario. 100 000 iteraciones es el máximo
// que permite Cloudflare Workers; el pepper compensa el espacio pequeño de un PIN.
export const PBKDF2_ITERATIONS = 100000;

export async function hashPin(pin, saltB64u, pepper, iterations = PBKDF2_ITERATIONS) {
  const hk = await crypto.subtle.importKey(
    "raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const pre = await crypto.subtle.sign("HMAC", hk, enc.encode(pin));
  const key = await crypto.subtle.importKey("raw", pre, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64uToBytes(saltB64u), iterations }, key, 256);
  return b64u(bits);
}

function pemToDer(pem) {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importPrivateKey(pem) {
  return crypto.subtle.importKey(
    "pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function signJwt(payload, privateKey, header = {}) {
  const h = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", ...header })));
  const p = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

export function decodeJwtPart(part) {
  return JSON.parse(new TextDecoder().decode(b64uToBytes(part)));
}
