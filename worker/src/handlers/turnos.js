// Turnos: plantillas, asignación y validación de empalmes. Admin o supervisor del sitio.
import { auditoria, authenticate, bad, id as vId, randomId, readJson, requireRol } from "../common.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { generarTurnos, primerEmpalme } from "../turnos.js";
import { recalcularSitiosAsignados } from "./compartido.js";

const fmt = (ms) => new Date(ms - 7 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);

async function sitioAutorizado(env, actor, sitioId) {
  const s = await getDocument(env, `sitios/${sitioId}`);
  if (!s || s.activo === false) throw new HttpError(404, "not_found");
  if (actor.rol === "supervisor" && s.supervisorUid !== actor.uid) throw new HttpError(403, "forbidden");
  return s;
}

async function validarGuardia(env, uid) {
  const g = await getDocument(env, `usuarios/${vId(uid, "guardiaUid")}`);
  if (!g || g.rol !== "guardia" || g.activo !== true) throw bad("El guardia no existe o está inactivo.");
  return g;
}

// Turnos vigentes (no cancelados) de un guardia en CUALQUIER sitio.
const turnosDeGuardia = async (env, uid) =>
  (await runQuery(env, "turnos", [{ campo: "guardiaUid", op: "EQUAL", valor: uid }])).filter((t) => t.estado !== "cancelado");

function lanzarEmpalme(e) {
  throw new HttpError(409, "empalme", `Empalme de turnos: ${fmt(e.nuevo.inicioMs)} con ${fmt(e.con.inicioMs)} (hora de Hermosillo).`);
}

export async function asignarLote(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const sitioId = vId(b.sitioId, "sitioId");
  const sitio = await sitioAutorizado(env, actor, sitioId);
  const nuevos = generarTurnos(b);
  const ahora = Date.now();
  if (nuevos.some((t) => t.finMs <= ahora)) throw bad("No se pueden crear turnos en el pasado.");

  const guardiaUid = b.guardiaUid ? vId(b.guardiaUid, "guardiaUid") : null;
  let existentes = [];
  if (guardiaUid) {
    await validarGuardia(env, guardiaUid);
    existentes = await turnosDeGuardia(env, guardiaUid);
    const e = primerEmpalme(nuevos, existentes);
    if (e) lanzarEmpalme(e);
  } else if (primerEmpalme(nuevos, [])) {
    throw bad("La plantilla genera turnos empalmados.");
  }

  const docs = nuevos.map((t) => ({
    id: `t-${t.inicioMs.toString(36)}-${randomId(4)}`,
    sitioId, sitioNombre: sitio.nombre, supervisorUid: sitio.supervisorUid ?? null, guardiaUid,
    inicioMs: t.inicioMs, finMs: t.finMs, plantilla: b.plantilla, estado: "programado",
    ...(b.prueba === true ? { prueba: true } : {}),
  }));
  const writes = docs.map(({ id, ...data }) => ({ path: `turnos/${id}`, data, mustNotExist: true, serverTimeField: "creadoEn" }));
  writes.push(auditoria(actor, "turnos.crear", sitioId, { plantilla: b.plantilla, desde: b.desde, hasta: b.hasta, n: docs.length, guardiaUid }));
  await commit(env, writes);
  if (guardiaUid) await recalcularSitiosAsignados(env, guardiaUid, { ahora, turnos: [...existentes, ...docs] });
  return { status: 201, body: { ok: true, creados: docs.length } };
}

export async function asignarTurno(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const turnoId = vId(b.turnoId, "turnoId");
  const t = await getDocument(env, `turnos/${turnoId}`);
  if (!t) throw new HttpError(404, "not_found");
  await sitioAutorizado(env, actor, t.sitioId);
  if (t.estado !== "programado") throw new HttpError(409, "turno_no_modificable", "El turno ya no se puede modificar.");
  if (t.inicioMs <= Date.now()) throw new HttpError(409, "turno_iniciado", "El turno ya inició o terminó.");

  const nuevoGuardia = b.guardiaUid ? vId(b.guardiaUid, "guardiaUid") : null;
  let existentes = [];
  if (nuevoGuardia) {
    await validarGuardia(env, nuevoGuardia);
    existentes = (await turnosDeGuardia(env, nuevoGuardia)).filter((x) => x.id !== turnoId);
    const e = primerEmpalme([t], existentes);
    if (e) lanzarEmpalme(e);
  }
  await commit(env, [
    { path: `turnos/${turnoId}`, data: { guardiaUid: nuevoGuardia }, merge: true, mustExist: true },
    auditoria(actor, "turno.asignar", turnoId, { de: t.guardiaUid ?? null, a: nuevoGuardia }),
  ]);
  if (t.guardiaUid && t.guardiaUid !== nuevoGuardia) await recalcularSitiosAsignados(env, t.guardiaUid);
  if (nuevoGuardia) await recalcularSitiosAsignados(env, nuevoGuardia);
  return { status: 200, body: { ok: true } };
}

export async function cancelarTurno(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const turnoId = vId(b.turnoId, "turnoId");
  const t = await getDocument(env, `turnos/${turnoId}`);
  if (!t) throw new HttpError(404, "not_found");
  await sitioAutorizado(env, actor, t.sitioId);
  if (t.estado !== "programado") throw new HttpError(409, "turno_no_modificable", "El turno ya no se puede modificar.");
  if (t.inicioMs <= Date.now()) throw new HttpError(409, "turno_iniciado", "El turno ya inició o terminó.");
  await commit(env, [
    { path: `turnos/${turnoId}`, data: { estado: "cancelado" }, merge: true, mustExist: true },
    auditoria(actor, "turno.cancelar", turnoId, { sitioId: t.sitioId, guardiaUid: t.guardiaUid ?? null }),
  ]);
  if (t.guardiaUid) await recalcularSitiosAsignados(env, t.guardiaUid);
  return { status: 200, body: { ok: true } };
}
