// QR firmado por sitio: MPC1.<sitioId>.<versión>.<firma>. La firma es HMAC-SHA256 con QR_SECRET
// (secret del Worker, nunca sale). Regenerar el QR sube la versión y invalida los impresos antes.
import { b64u, safeEqual } from "./crypto.js";
import { RE_ID } from "./common.js";

const enc = new TextEncoder();
const PREFIJO = "MPC1";

async function firmar(env, sitioId, version) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.QR_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${PREFIJO}|${sitioId}|${version}`));
  return b64u(new Uint8Array(mac).slice(0, 16)); // 128 bits
}

export async function generarPayload(env, sitioId, version) {
  if (!env.QR_SECRET) throw new Error("QR_SECRET no configurado");
  return `${PREFIJO}.${sitioId}.${version}.${await firmar(env, sitioId, version)}`;
}

// Devuelve { sitioId, version } si el formato y la firma son válidos; null en cualquier otro caso.
export async function verificarFirma(env, payload) {
  if (typeof payload !== "string" || payload.length > 200 || !env.QR_SECRET) return null;
  const p = payload.split(".");
  if (p.length !== 4 || p[0] !== PREFIJO || !RE_ID.test(p[1]) || !/^[1-9]\d{0,6}$/.test(p[2])) return null;
  const esperado = await firmar(env, p[1], p[2]);
  return safeEqual(esperado, p[3]) ? { sitioId: p[1], version: Number(p[2]) } : null;
}
