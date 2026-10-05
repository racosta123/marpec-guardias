// Utilidades compartidas: autenticación, validación de entradas, auditoría y zona horaria.
import { HttpError, getDocument, verifyIdToken } from "./google.js";

export const ROLES = ["guardia", "supervisor", "admin"];
export const RE_NUMERO = /^[A-Z0-9]{3,12}$/;
export const RE_PIN = /^\d{4,6}$/;
export const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
export const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

// America/Hermosillo: UTC-7 todo el año (Sonora no usa horario de verano).
export const TZ = "America/Hermosillo";
export const TZ_OFFSET_MS = -7 * 3600 * 1000;

export const bad = (detalle) => new HttpError(400, "bad_request", detalle);

export async function readJson(request, max = 8192) {
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "too_large");
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, "bad_request");
  }
}

export async function authenticate(env, request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(h);
  if (!m) throw new HttpError(401, "unauthorized");
  const claims = await verifyIdToken(env, m[1]);
  if (!ROLES.includes(claims.rol)) throw new HttpError(403, "forbidden");
  const perfil = await getDocument(env, `usuarios/${claims.sub}`);
  if (!perfil || perfil.activo !== true || perfil.rol !== claims.rol) throw new HttpError(403, "forbidden");
  return { uid: claims.sub, rol: claims.rol, perfil };
}

export const requireRol = (actor, ...roles) => {
  if (!roles.includes(actor.rol)) throw new HttpError(403, "forbidden");
};

// ---- validadores (lanzan 400 con mensaje claro) ---------------------------
export function str(v, campo, min, max, { opcional = false } = {}) {
  if ((v === undefined || v === null || v === "") && opcional) return "";
  if (typeof v !== "string") throw bad(`${campo}: texto requerido.`);
  const t = v.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (t.length < min || t.length > max) throw bad(`${campo}: entre ${min} y ${max} caracteres.`);
  return t;
}

export function int(v, campo, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${campo}: entero entre ${min} y ${max}.`);
  return v;
}

export function num(v, campo, min, max) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw bad(`${campo}: número entre ${min} y ${max}.`);
  return v;
}

export function id(v, campo) {
  if (typeof v !== "string" || !RE_ID.test(v)) throw bad(`${campo}: identificador inválido.`);
  return v;
}

export function numeroEmpleado(v) {
  const n = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!RE_NUMERO.test(n)) throw bad("Número de empleado: 3-12 letras o dígitos.");
  return n;
}

export function pin(v) {
  if (typeof v !== "string" || !RE_PIN.test(v)) throw bad("PIN: de 4 a 6 dígitos.");
  return v;
}

export function email(v) {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!RE_EMAIL.test(e)) throw bad("Correo inválido.");
  return e;
}

export function randomId(bytes = 10) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- auditoría inmutable ----------------------------------------------------
// Devuelve una escritura para incluir en el MISMO commit que el cambio (atómico).
// Solo se crea: ni el Worker ni las reglas permiten actualizar o borrar auditoría.
// `prueba` lo decide el SERVIDOR: la entrada se marca solo si el actor o el registro afectado YA tiene
// prueba=true en Firestore. Nunca depende de cabeceras ni de datos que envíe el cliente.
export function auditoria(actor, accion, objetivo, detalle = {}, registroAfectado = null) {
  const marcar = actor.perfil.prueba === true || registroAfectado?.prueba === true;
  const limpio = JSON.stringify(detalle, (k, v) => (/pin|password|hash|salt|secret|token/i.test(k) ? undefined : v)).slice(0, 900);
  return {
    path: `auditoria/${Date.now().toString(36)}-${randomId(6)}`,
    data: { actorUid: actor.uid, actorRol: actor.rol, actorNombre: actor.perfil.nombre, accion, objetivo, detalle: limpio, ...(marcar ? { prueba: true } : {}) },
    mustNotExist: true,
    serverTimeField: "ts",
  };
}

// ---- tiempo (America/Hermosillo) ------------------------------------------
// "2026-10-05" + "07:00" (hora local de Hermosillo) → milisegundos UTC.
export function localAMs(fecha, hora) {
  const [y, mo, d] = fecha.split("-").map(Number);
  const [h, mi] = hora.split(":").map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi) - TZ_OFFSET_MS;
  const chk = new Date(ms + TZ_OFFSET_MS);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) throw bad("Fecha inválida.");
  return ms;
}

export function fechaLocal(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}
