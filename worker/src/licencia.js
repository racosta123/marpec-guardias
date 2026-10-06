// Licencia de demostración: config/licencia { modo: "demo" | "produccion", inicio, vence } (timestamps).
// La escribe SOLO el operador técnico con tools/licencia.mjs: las reglas de Firestore niegan toda escritura de clientes
// y ningún endpoint del Worker la modifica, así que ningún rol de la app (ni el admin) puede alargarla.
// Sin documento de licencia el servicio se cierra igual que vencido (no hay forma de "borrar" la licencia desde la app).
import { HttpError, getDocument } from "./google.js";
import { notificarUnaVez } from "./push.js";

export const MENSAJE_VENCIDO = "Periodo de demostración concluido. Para continuar usando MARPEC Guardias, contacta a Diagonal Catorce.";
const CACHE_MS = 30000;
const HERMOSILLO_MS = -7 * 3600e3; // UTC-7 todo el año (Sonora no usa horario de verano)
export const DIAS_AVISO = 10;

let cache = { clave: null, t: 0, v: undefined };
export function resetLicencia() { cache = { clave: null, t: 0, v: undefined }; }

function normalizar(d) {
  if (!d) return null;
  return { modo: d.modo === "produccion" ? "produccion" : "demo", inicioMs: Date.parse(d.inicio), venceMs: Date.parse(d.vence) };
}

// null = no hay documento. Un error de lectura transitorio reutiliza el último valor conocido (no tumba el servicio).
export async function leerLicencia(env, ahora = Date.now()) {
  const clave = env.FIREBASE_PROJECT_ID;
  if (cache.clave === clave && cache.t && ahora - cache.t < CACHE_MS) return cache.v;
  try {
    cache = { clave, t: ahora, v: normalizar(await getDocument(env, "config/licencia")) };
  } catch (e) {
    if (cache.clave === clave && cache.v !== undefined) return cache.v;
    throw e;
  }
  return cache.v;
}

export function vencida(lic, ahora = Date.now()) {
  if (!lic) return true;
  if (lic.modo === "produccion") return false;
  return !Number.isFinite(lic.venceMs) || ahora >= lic.venceMs;
}

// Fecha (AAAA-MM-DD) en hora de Hermosillo.
export const diaHermosillo = (ms) => new Date(ms + HERMOSILLO_MS).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export function estadoLicencia(lic, ahora = Date.now()) {
  if (!lic) return { modo: "sin_licencia", vencido: true, ahoraMs: ahora };
  if (lic.modo === "produccion") return { modo: "produccion", vencido: false, ahoraMs: ahora };
  const vencido = vencida(lic, ahora);
  const dias = Number.isFinite(lic.venceMs) ? diasEntre(diaHermosillo(ahora), diaHermosillo(lic.venceMs - 1)) : null; // días de calendario que faltan hasta el último día válido
  return { modo: "demo", vencido, venceMs: lic.venceMs, venceDia: Number.isFinite(lic.venceMs) ? diaHermosillo(lic.venceMs - 1) : null, diasRestantes: vencido ? 0 : dias, ahoraMs: ahora };
}

export async function exigirLicencia(env) {
  if (vencida(await leerLicencia(env))) throw new HttpError(403, "demo_vencido", MENSAJE_VENCIDO);
}

// GET público y mínimo: solo el estado (sin datos del cliente).
export async function estadoPublico(env) {
  return { status: 200, body: estadoLicencia(await leerLicencia(env)) };
}

// Cron diario: el día en que faltan DIAS_AVISO días avisa por push a los administradores (una sola vez).
export async function avisarVencimiento(env, lic, ahora = Date.now()) {
  if (!lic || lic.modo !== "demo" || vencida(lic, ahora)) return { enviados: 0 };
  const e = estadoLicencia(lic, ahora);
  if (e.diasRestantes !== DIAS_AVISO) return { enviados: 0 };
  return notificarUnaVez(env, `licencia-${e.venceDia}`, { evento: "licencia", extra: { vence: e.venceDia } });
}
