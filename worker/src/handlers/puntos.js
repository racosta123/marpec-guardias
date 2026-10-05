// Puntos de control de rondines (admin o supervisor de ese sitio): CRUD, QR firmado propio por punto
// (MPC2, distinto del QR de asistencia) y programación del rondín del sitio.
import { auditoria, authenticate, bad, id as vId, int, num, randomId, readJson, requireRol, str } from "../common.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { generarPayloadPunto } from "../qr.js";
import { validarPrograma } from "../rondines.js";

const MAX_PUNTOS = 60;

async function sitioAutorizado(env, actor, sitioId) {
  const s = await getDocument(env, `sitios/${sitioId}`);
  if (!s) throw new HttpError(404, "not_found");
  if (actor.rol === "supervisor" && s.supervisorUid !== actor.uid) throw new HttpError(403, "forbidden");
  return s;
}

async function puntoAutorizado(env, actor, puntoId) {
  const p = await getDocument(env, `puntos/${puntoId}`);
  if (!p) throw new HttpError(404, "not_found");
  const sitio = await sitioAutorizado(env, actor, p.sitioId);
  return { punto: p, sitio };
}

function ubicacion(b, parcial) {
  const hay = b.lat !== undefined || b.lng !== undefined;
  if (!hay) return parcial ? {} : { lat: null, lng: null, precisionM: null };
  if (b.lat === null && b.lng === null) return { lat: null, lng: null, precisionM: null };
  return {
    lat: num(b.lat, "Latitud", -90, 90), lng: num(b.lng, "Longitud", -180, 180),
    precisionM: b.precisionM === undefined || b.precisionM === null ? null : num(b.precisionM, "Precisión", 0, 100000),
  };
}

export async function crearPunto(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const sitioId = vId(b.sitioId, "sitioId");
  const sitio = await sitioAutorizado(env, actor, sitioId);
  const existentes = await runQuery(env, "puntos", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }]);
  if (existentes.length >= MAX_PUNTOS) throw bad(`Máximo ${MAX_PUNTOS} puntos por sitio.`);
  const orden = b.orden === undefined ? Math.max(0, ...existentes.map((p) => p.orden)) + 1 : int(b.orden, "Orden", 1, 999);
  const id = randomId(8);
  const data = {
    sitioId, supervisorUid: sitio.supervisorUid ?? null, nombre: str(b.nombre, "Nombre", 2, 80), descripcion: str(b.descripcion, "Descripción", 0, 300, { opcional: true }),
    orden, qrVersion: 1, ...ubicacion(b, false), radioM: b.radioM === undefined ? 30 : int(b.radioM, "Radio (m)", 5, 200), activo: true,
    ...(sitio.prueba === true ? { prueba: true } : {}), // la marca de prueba la decide el servidor (hereda del sitio)
  };
  await commit(env, [
    { path: `puntos/${id}`, data, mustNotExist: true, serverTimeField: "creadoEn" },
    auditoria(actor, "punto.alta", id, { sitioId, nombre: data.nombre, orden }, sitio),
  ]);
  return { status: 201, body: { ok: true, id } };
}

export async function actualizarPunto(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const id = vId(b.id, "id");
  const { punto, sitio } = await puntoAutorizado(env, actor, id);
  const c = { ...ubicacion(b, true) };
  if (b.nombre !== undefined) c.nombre = str(b.nombre, "Nombre", 2, 80);
  if (b.descripcion !== undefined) c.descripcion = str(b.descripcion, "Descripción", 0, 300, { opcional: true });
  if (b.orden !== undefined) c.orden = int(b.orden, "Orden", 1, 999);
  if (b.radioM !== undefined) c.radioM = int(b.radioM, "Radio (m)", 5, 200);
  if (b.activo !== undefined) { if (typeof b.activo !== "boolean") throw bad("activo: booleano."); c.activo = b.activo; }
  if (!Object.keys(c).length) throw bad("Nada que actualizar.");
  await commit(env, [
    { path: `puntos/${id}`, data: c, merge: true, mustExist: true },
    auditoria(actor, "punto.editar", id, c, punto.prueba === true ? punto : sitio),
  ]);
  return { status: 200, body: { ok: true } };
}

export async function regenerarQrPunto(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const id = vId(b.id, "id");
  const { punto, sitio } = await puntoAutorizado(env, actor, id);
  const version = (punto.qrVersion || 1) + 1;
  await commit(env, [
    { path: `puntos/${id}`, data: { qrVersion: version }, merge: true, mustExist: true },
    auditoria(actor, "punto.qr_regenerado", id, { version }, punto.prueba === true ? punto : sitio),
  ]);
  return { status: 200, body: { ok: true, version } };
}

export async function obtenerQrPunto(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const id = vId(new URL(request.url).searchParams.get("id"), "id");
  const { punto, sitio } = await puntoAutorizado(env, actor, id);
  return { status: 200, body: { payload: await generarPayloadPunto(env, id, punto.qrVersion || 1), version: punto.qrVersion || 1, punto: { id, nombre: punto.nombre, descripcion: punto.descripcion || "" }, sitio: { id: punto.sitioId, nombre: sitio.nombre } } };
}

// Hoja imprimible: todos los QR de los puntos activos del sitio.
export async function obtenerQrSitioPuntos(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const sitioId = vId(new URL(request.url).searchParams.get("sitioId"), "sitioId");
  const sitio = await sitioAutorizado(env, actor, sitioId);
  const puntos = (await runQuery(env, "puntos", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }])).filter((p) => p.activo !== false).sort((a, b) => a.orden - b.orden);
  const lista = [];
  for (const p of puntos) lista.push({ id: p.id, nombre: p.nombre, descripcion: p.descripcion || "", orden: p.orden, version: p.qrVersion || 1, payload: await generarPayloadPunto(env, p.id, p.qrVersion || 1) });
  return { status: 200, body: { sitio: { id: sitioId, nombre: sitio.nombre }, puntos: lista } };
}

export async function guardarPrograma(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const sitioId = vId(b.sitioId, "sitioId");
  const sitio = await sitioAutorizado(env, actor, sitioId);
  const programa = validarPrograma(b);
  const activo = b.activo === undefined ? true : b.activo;
  if (typeof activo !== "boolean") throw bad("activo: booleano.");
  const data = { sitioId, supervisorUid: sitio.supervisorUid ?? null, ...programa, activo, ...(sitio.prueba === true ? { prueba: true } : {}) };
  await commit(env, [
    { path: `programasRondin/${sitioId}`, data, serverTimeField: "actualizadoEn" },
    auditoria(actor, "rondin.programa", sitioId, programa, sitio),
  ]);
  return { status: 200, body: { ok: true } };
}
