// Visitantes y vehículos: entrada y salida (guardia con turno activo), lista «dentro del sitio ahora»,
// foto opcional del VEHÍCULO o la placa, y borrado automático por retención.
// PROHIBIDO pedir o guardar identificaciones (INE, licencia, pasaporte) o sus números: el esquema es
// estricto (cualquier campo no listado se rechaza) y no existe ningún campo para ello.
import { authenticate, bad, id as vId, randomId, readJson, requireRol, str } from "../common.js";
import { CONFIG_DEFECTO } from "../asistencia.js";
import { HttpError, commit, deleteDocument, getDocument, runQuery } from "../google.js";
import { validarFoto } from "./marcas.js";
import { enumerado, sitioParaGestion, soloCampos, turnoActivoDelGuardia } from "./turnoActivo.js";

export const MOTIVOS = ["visita", "proveedor", "paqueteria", "servicio", "otro"];
const BODY_MAX = 230 * 1024;
const DIA = 86400000;

export async function retencionDias(env) {
  const c = await getDocument(env, "configuracion/empresa");
  return Number.isInteger(c?.retencionVisitantesDias) ? c.retencionVisitantesDias : CONFIG_DEFECTO.retencionVisitantesDias;
}

const RE_PLACAS = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/;

export async function entradaVisitante(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const b = await readJson(request, BODY_MAX);
  soloCampos(b, ["turnoId", "nombre", "visitaA", "motivo", "empresa", "placas", "foto"]);
  const { turno, sitio } = await turnoActivoDelGuardia(env, actor, vId(b.turnoId, "turnoId"));
  const nombre = str(b.nombre, "Nombre del visitante", 2, 80);
  const visitaA = str(b.visitaA, "A quién visita", 2, 80);
  const motivo = enumerado(b.motivo, "Motivo", MOTIVOS);
  const empresa = str(b.empresa, "Empresa", 0, 80, { opcional: true });
  let placas = "";
  if (b.placas !== undefined && b.placas !== null && String(b.placas).trim() !== "") {
    placas = String(b.placas).trim().toUpperCase();
    if (!RE_PLACAS.test(placas)) throw bad("Placas: 2 a 12 letras, números, espacios o guiones.");
  }
  let foto = null, fotoKey = null;
  if (b.foto !== undefined && b.foto !== null && b.foto !== "") {
    foto = validarFoto(b.foto);
    if (!env.SELFIES) throw new HttpError(503, "almacenamiento_no_disponible", "El almacenamiento de fotos no está disponible. Intenta más tarde.");
  }
  const ahora = Date.now(); // hora del servidor
  const id = `${ahora.toString(36)}-${randomId(5)}`;
  if (foto) {
    fotoKey = `visitantes/${turno.sitioId}/${id}.jpg`;
    await env.SELFIES.put(fotoKey, foto, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { visitante: id, guardiaUid: actor.uid } });
  }
  const dias = await retencionDias(env);
  const guardia = await getDocument(env, `usuarios/${actor.uid}`);
  const base = {
    sitioId: turno.sitioId, turnoId: b.turnoId, guardiaUid: actor.uid, guardiaNombre: guardia?.nombre || "", nombre, visitaA, motivo, empresa, placas,
    fotoKey, entradaMs: ahora, expiraMs: ahora + dias * DIA, ...(turno.prueba === true || sitio.prueba === true ? { prueba: true } : {}),
  };
  try {
    await commit(env, [
      { path: `visitantes/${id}`, data: base, mustNotExist: true, serverTimeField: "ts" }, // entrada inmutable
      { path: `visitantesVista/${id}`, data: { ...base, visitanteId: id, sitioNombre: sitio.nombre, supervisorUid: sitio.supervisorUid ?? null, dentro: true, salidaMs: null, salidaTurnoId: null }, serverTimeField: "actualizadoEn" },
    ]);
  } catch (e) {
    if (fotoKey) await env.SELFIES.delete(fotoKey).catch(() => {});
    throw e;
  }
  return { status: 201, body: { ok: true, id, entradaMs: ahora } };
}

export async function salidaVisitante(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const b = await readJson(request);
  soloCampos(b, ["turnoId", "visitanteId"]);
  const { turno } = await turnoActivoDelGuardia(env, actor, vId(b.turnoId, "turnoId"));
  const id = vId(b.visitanteId, "visitanteId");
  const v = await getDocument(env, `visitantesVista/${id}`);
  // Solo visitantes de SU sitio (también los que entraron en el turno anterior)
  if (!v || v.sitioId !== turno.sitioId) throw new HttpError(404, "not_found", "Visitante no encontrado en este sitio.");
  const ahora = Date.now();
  try {
    await commit(env, [{ path: `salidasVisitante/${id}`, data: { visitanteId: id, sitioId: v.sitioId, guardiaUid: actor.uid, turnoId: b.turnoId, salidaMs: ahora, ...(v.prueba === true ? { prueba: true } : {}) }, mustNotExist: true, serverTimeField: "ts" }]);
  } catch (e) {
    if (e.status === 409) throw new HttpError(409, "ya_salio", "Este visitante ya tiene salida registrada.");
    throw e;
  }
  await commit(env, [{ path: `visitantesVista/${id}`, data: { dentro: false, salidaMs: ahora, salidaTurnoId: b.turnoId }, merge: true, mustExist: true, serverTimeField: "actualizadoEn" }]);
  return { status: 201, body: { ok: true, salidaMs: ahora } };
}

const pub = ({ visitanteId, nombre, visitaA, motivo, empresa, placas, entradaMs, guardiaNombre, fotoKey, sitioId, dentro, salidaMs }) =>
  ({ id: visitanteId, nombre, visitaA, motivo, empresa, placas, entradaMs, guardiaNombre, hayFoto: Boolean(fotoKey), sitioId, dentro, salidaMs });

// «Dentro del sitio ahora»: el guardia en turno activo de ese sitio, el supervisor del sitio o el admin.
export async function visitantesDentro(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia", "supervisor", "admin");
  const p = new URL(request.url).searchParams;
  let sitioId;
  if (actor.rol === "guardia") sitioId = (await turnoActivoDelGuardia(env, actor, vId(p.get("turnoId"), "turnoId"))).turno.sitioId;
  else { sitioId = vId(p.get("sitioId"), "sitioId"); await sitioParaGestion(env, actor, sitioId); }
  const lista = (await runQuery(env, "visitantesVista", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }, { campo: "dentro", op: "EQUAL", valor: true }]))
    .sort((a, b) => a.entradaMs - b.entradaMs).map(pub);
  return { status: 200, body: { sitioId, dentro: lista } };
}

// Foto del vehículo/placa: SOLO admin o supervisor actual del sitio.
export async function fotoVisitante(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const id = vId(new URL(request.url).searchParams.get("id"), "id");
  const v = await getDocument(env, `visitantes/${id}`);
  if (!v || !v.fotoKey) throw new HttpError(404, "not_found");
  await sitioParaGestion(env, actor, v.sitioId);
  if (!env.SELFIES) throw new HttpError(503, "almacenamiento_no_disponible");
  const obj = await env.SELFIES.get(v.fotoKey);
  if (!obj) throw new HttpError(404, "not_found");
  return { status: 200, binary: { body: obj.body, contentType: "image/jpeg" } };
}

// Retención: borra registros de visitantes (entrada, salida, vista) y sus fotos cuya entrada es anterior a
// ahora − retención. Toca ÚNICAMENTE esas tres colecciones y las fotos `visitantes/…` en R2.
export async function purgarVisitantes(env, ahora = Date.now(), { limite = 200 } = {}) {
  const dias = await retencionDias(env);
  const corte = ahora - dias * DIA;
  const vencidos = await runQuery(env, "visitantes", [{ campo: "entradaMs", op: "LESS_THAN", valor: corte }], { limite });
  let fotos = 0;
  for (const v of vencidos) {
    if (v.fotoKey && v.fotoKey.startsWith("visitantes/") && env.SELFIES) { await env.SELFIES.delete(v.fotoKey).catch(() => {}); fotos++; }
    await deleteDocument(env, `salidasVisitante/${v.id}`);
    await deleteDocument(env, `visitantesVista/${v.id}`);
    await deleteDocument(env, `visitantes/${v.id}`);
  }
  if (vencidos.length) {
    await commit(env, [{
      path: `auditoria/purga-${ahora.toString(36)}-${randomId(4)}`,
      data: { actorUid: "sistema", actorRol: "sistema", actorNombre: "Retención automática", accion: "visitantes.purga", objetivo: "visitantes", detalle: JSON.stringify({ registros: vencidos.length, fotos, retencionDias: dias }), ...(vencidos.every((x) => x.prueba === true) ? { prueba: true } : {}) },
      mustNotExist: true, serverTimeField: "ts",
    }]);
  }
  return { registros: vencidos.length, fotos, retencionDias: dias };
}
