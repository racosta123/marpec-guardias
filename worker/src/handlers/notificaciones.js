// Suscripción a notificaciones push (opt-in de supervisor y admin) y sus preferencias.
// Las suscripciones solo las lee/escribe el Worker (reglas: deny-all). Cada una queda ligada al usuario que la dio de alta.
import { authenticate, readJson, requireRol } from "../common.js";
import { b64uToBytes } from "../crypto.js";
import { HttpError, commit, deleteDocument, getDocument, runQuery } from "../google.js";
import { EVENTOS_CONFIGURABLES, clavePublica, endpointPermitido, idSuscripcion, vapidConfigurado } from "../push.js";
import { bad } from "../common.js";
import { soloCampos } from "./turnoActivo.js";

const MAX_POR_USUARIO = 8;

function prefsValidas(p) {
  const out = {};
  for (const k of EVENTOS_CONFIGURABLES) out[k] = p === undefined || p === null || p[k] === undefined ? true : p[k] === true;
  if (p && typeof p === "object") for (const k of Object.keys(p)) if (!EVENTOS_CONFIGURABLES.includes(k)) throw bad(`Preferencia desconocida: ${String(k).slice(0, 30)} (el pánico siempre se envía).`);
  return out;
}

function bytesOk(b64u, n, exacto = true) {
  try { const b = b64uToBytes(String(b64u)); return exacto ? b.length === n : b.length >= n && b.length <= 32; } catch { return false; }
}

export async function claveVapid(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "supervisor", "admin");
  if (!vapidConfigurado(env)) throw new HttpError(503, "push_no_configurado", "Las notificaciones no están configuradas en el servidor.");
  return { status: 200, body: { publicKey: clavePublica(env) } };
}

export async function suscribirPush(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "supervisor", "admin");
  if (!vapidConfigurado(env)) throw new HttpError(503, "push_no_configurado", "Las notificaciones no están configuradas en el servidor.");
  const b = await readJson(request, 4096);
  soloCampos(b, ["endpoint", "keys", "prefs"]);
  if (typeof b.endpoint !== "string" || !endpointPermitido(b.endpoint)) throw bad("Servicio de notificaciones no permitido.");
  const k = b.keys;
  if (!k || typeof k !== "object" || !bytesOk(k.p256dh, 65) || b64uToBytes(k.p256dh)[0] !== 4 || !bytesOk(k.auth, 16, false)) throw bad("Llaves de suscripción inválidas.");
  const prefs = prefsValidas(b.prefs);
  const id = await idSuscripcion(b.endpoint);
  const propias = await runQuery(env, "pushSuscripciones", [{ campo: "uid", op: "EQUAL", valor: actor.uid }]);
  if (propias.length >= MAX_POR_USUARIO && !propias.some((p) => p.id === id)) throw bad(`Máximo ${MAX_POR_USUARIO} dispositivos por usuario.`);
  await commit(env, [{
    path: `pushSuscripciones/${id}`,
    data: { uid: actor.uid, rol: actor.rol, endpoint: b.endpoint, p256dh: k.p256dh, auth: k.auth, prefs, ...(actor.perfil.prueba === true ? { prueba: true } : {}) },
    serverTimeField: "creadoEn",
  }]);
  return { status: 201, body: { ok: true, prefs } };
}

export async function estadoPush(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "supervisor", "admin");
  const b = await readJson(request, 2048);
  soloCampos(b, ["endpoint"]);
  if (typeof b.endpoint !== "string") throw bad("Endpoint requerido.");
  const s = await getDocument(env, `pushSuscripciones/${await idSuscripcion(b.endpoint)}`);
  const mia = s && s.uid === actor.uid;
  return { status: 200, body: { configurado: vapidConfigurado(env), suscrito: Boolean(mia), prefs: mia ? s.prefs : null } };
}

export async function guardarPrefsPush(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "supervisor", "admin");
  const b = await readJson(request, 2048);
  soloCampos(b, ["prefs"]);
  if (!b.prefs || typeof b.prefs !== "object") throw bad("Preferencias requeridas.");
  const prefs = prefsValidas(b.prefs);
  const propias = await runQuery(env, "pushSuscripciones", [{ campo: "uid", op: "EQUAL", valor: actor.uid }]);
  for (const p of propias) await commit(env, [{ path: `pushSuscripciones/${p.id}`, data: { prefs }, merge: true, mustExist: true }]);
  return { status: 200, body: { ok: true, prefs, dispositivos: propias.length } };
}

export async function bajaPush(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "supervisor", "admin");
  const b = await readJson(request, 2048);
  soloCampos(b, ["endpoint"]);
  if (typeof b.endpoint !== "string") throw bad("Endpoint requerido.");
  const id = await idSuscripcion(b.endpoint);
  const s = await getDocument(env, `pushSuscripciones/${id}`);
  if (s && s.uid === actor.uid) await deleteDocument(env, `pushSuscripciones/${id}`);
  return { status: 200, body: { ok: true } };
}
