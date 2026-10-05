// QR firmados (HMAC-SHA256 con QR_SECRET, secret del Worker; nunca sale).
//  - Asistencia (sitio):  MPC1.<sitioId>.<versión>.<firma>
//  - Punto de rondín:     MPC2.<puntoId>.<versión>.<firma>
// El prefijo entra en el mensaje firmado (separación de dominios): un QR de asistencia no sirve como
// punto de rondín ni al revés, aunque alguien reescriba el prefijo. Regenerar sube la versión e invalida
// el QR impreso anteriormente.
import { b64u, safeEqual } from "./crypto.js";
import { RE_ID } from "./common.js";

const enc = new TextEncoder();
export const PREFIJO_SITIO = "MPC1";
export const PREFIJO_PUNTO = "MPC2";

async function firmar(env, prefijo, id, version) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.QR_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${prefijo}|${id}|${version}`));
  return b64u(new Uint8Array(mac).slice(0, 16)); // 128 bits
}

async function generar(env, prefijo, id, version) {
  if (!env.QR_SECRET) throw new Error("QR_SECRET no configurado");
  return `${prefijo}.${id}.${version}.${await firmar(env, prefijo, id, version)}`;
}

// Devuelve { id, version } si formato, prefijo y firma son válidos; null en cualquier otro caso.
async function verificar(env, prefijo, payload) {
  if (typeof payload !== "string" || payload.length > 200 || !env.QR_SECRET) return null;
  const p = payload.split(".");
  if (p.length !== 4 || p[0] !== prefijo || !RE_ID.test(p[1]) || !/^[1-9]\d{0,6}$/.test(p[2])) return null;
  return safeEqual(await firmar(env, prefijo, p[1], p[2]), p[3]) ? { id: p[1], version: Number(p[2]) } : null;
}

export const generarPayload = (env, sitioId, version) => generar(env, PREFIJO_SITIO, sitioId, version);
export const generarPayloadPunto = (env, puntoId, version) => generar(env, PREFIJO_PUNTO, puntoId, version);

export async function verificarFirma(env, payload) {
  const r = await verificar(env, PREFIJO_SITIO, payload);
  return r ? { sitioId: r.id, version: r.version } : null;
}
export async function verificarFirmaPunto(env, payload) {
  const r = await verificar(env, PREFIJO_PUNTO, payload);
  return r ? { puntoId: r.id, version: r.version } : null;
}
