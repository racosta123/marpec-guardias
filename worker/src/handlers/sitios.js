// Sitios (puestos): alta/edición (admin), QR firmado y su verificación.
import {
  auditoria, authenticate, bad, id as vId, int, num, randomId, readJson, requireRol, str,
} from "../common.js";
import { HttpError, commit, getDocument } from "../google.js";
import { generarPayload, verificarFirma } from "../qr.js";
import { reasignarSupervisor } from "./compartido.js";

async function validarSupervisor(env, uid) {
  if (uid === null || uid === undefined || uid === "") return null;
  const s = await getDocument(env, `usuarios/${vId(uid, "supervisorUid")}`);
  if (!s || s.rol !== "supervisor" || s.activo !== true) throw bad("El supervisor asignado no existe o está inactivo.");
  return uid;
}

// Valida solo los campos presentes (parcial=true) o todos (alta).
async function camposSitio(env, b, parcial) {
  const out = {};
  const hay = (k) => b[k] !== undefined;
  if (!parcial || hay("nombre")) out.nombre = str(b.nombre, "Nombre", 2, 80);
  if (!parcial || hay("direccion")) out.direccion = str(b.direccion, "Dirección", 0, 200, { opcional: true });
  if (!parcial || hay("cliente")) out.cliente = str(b.cliente, "Cliente", 0, 80, { opcional: true });
  if (!parcial || hay("consignas")) out.consignas = str(b.consignas, "Consignas", 0, 2000, { opcional: true });
  if (hay("supervisorUid")) out.supervisorUid = await validarSupervisor(env, b.supervisorUid);
  else if (!parcial) out.supervisorUid = null;

  if (hay("lat") || hay("lng")) {
    if ((b.lat === null && b.lng === null)) { out.lat = null; out.lng = null; out.precisionM = null; }
    else {
      out.lat = num(b.lat, "Latitud", -90, 90);
      out.lng = num(b.lng, "Longitud", -180, 180);
      out.precisionM = b.precisionM === undefined || b.precisionM === null ? null : num(b.precisionM, "Precisión", 0, 100000);
    }
  } else if (!parcial) { out.lat = null; out.lng = null; out.precisionM = null; }

  if (hay("radioM") || !parcial) out.radioM = b.radioM === undefined ? 100 : int(b.radioM, "Radio (m)", 20, 1000);
  if (hay("activo")) {
    if (typeof b.activo !== "boolean") throw bad("activo: booleano.");
    out.activo = b.activo;
  }
  return out;
}

export async function crearSitio(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const b = await readJson(request);
  const campos = await camposSitio(env, b, false);
  const sid = randomId(8);
  await commit(env, [
    { path: `sitios/${sid}`, data: { ...campos, qrVersion: 1, activo: true, ...(b.prueba === true ? { prueba: true } : {}) }, mustNotExist: true, serverTimeField: "creadoEn" },
    auditoria(actor, "sitio.alta", sid, { nombre: campos.nombre, supervisorUid: campos.supervisorUid }, { prueba: b.prueba === true }),
  ]);
  return { status: 201, body: { ok: true, id: sid } };
}

export async function actualizarSitio(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const b = await readJson(request);
  const sid = vId(b.id, "id");
  const actual = await getDocument(env, `sitios/${sid}`);
  if (!actual) throw new HttpError(404, "not_found");
  const campos = await camposSitio(env, b, true);
  if (!Object.keys(campos).length) throw bad("Nada que actualizar.");
  const cambiaSup = "supervisorUid" in campos && campos.supervisorUid !== (actual.supervisorUid ?? null);
  const { supervisorUid, ...resto } = campos;
  await commit(env, [
    { path: `sitios/${sid}`, data: cambiaSup ? { ...resto, supervisorUid } : resto, merge: true, mustExist: true },
    auditoria(actor, "sitio.editar", sid, campos, actual),
  ]);
  if (cambiaSup) await reasignarSupervisor(env, sid, campos.supervisorUid);
  return { status: 200, body: { ok: true } };
}

export async function regenerarQr(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const b = await readJson(request);
  const sid = vId(b.id, "id");
  const s = await getDocument(env, `sitios/${sid}`);
  if (!s) throw new HttpError(404, "not_found");
  const nueva = (s.qrVersion || 1) + 1;
  await commit(env, [
    { path: `sitios/${sid}`, data: { qrVersion: nueva }, merge: true, mustExist: true },
    auditoria(actor, "sitio.qr_regenerado", sid, { version: nueva }, s),
  ]);
  return { status: 200, body: { ok: true, version: nueva } };
}

// Admin, o el supervisor de ese sitio, obtiene el contenido del QR para imprimirlo.
export async function obtenerQr(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const sid = vId(new URL(request.url).searchParams.get("id"), "id");
  const s = await getDocument(env, `sitios/${sid}`);
  if (!s || s.activo === false) throw new HttpError(404, "not_found");
  if (actor.rol === "supervisor" && s.supervisorUid !== actor.uid) throw new HttpError(403, "forbidden");
  return {
    status: 200,
    body: { payload: await generarPayload(env, sid, s.qrVersion || 1), sitio: { id: sid, nombre: s.nombre, direccion: s.direccion || "" }, version: s.qrVersion || 1 },
  };
}

// Cualquier usuario activo puede validar un QR (en Fase 3 lo usará el guardia al marcar).
// Se rechaza: formato/firma alterados, versión vieja (regenerado), sitio distinto al esperado o inactivo.
export async function verificarQr(env, request) {
  await authenticate(env, request);
  const b = await readJson(request);
  const invalido = () => new HttpError(400, "qr_invalido", "Código QR no válido.");
  const v = await verificarFirma(env, b.payload);
  if (!v) throw invalido();
  if (b.sitioId !== undefined && b.sitioId !== v.sitioId) throw invalido();
  const s = await getDocument(env, `sitios/${v.sitioId}`);
  if (!s || s.activo === false || (s.qrVersion || 1) !== v.version) throw invalido();
  return { status: 200, body: { ok: true, sitioId: v.sitioId, nombre: s.nombre } };
}
