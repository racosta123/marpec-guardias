// Asistencia (admin y supervisor del sitio): ajustes con motivo, autorización de extras y de cierre
// sin relevo, recálculo y reporte. Las marcas originales NUNCA se editan; los ajustes y las
// autorizaciones son documentos nuevos e inmutables con nombre del autor y motivo.
import { auditoria, authenticate, bad, id as vId, localAMs, randomId, readJson, requireRol, str, RE_FECHA, RE_HORA } from "../common.js";
import { acumuladoSemanal, configEfectiva, fechaLocal, horaEfectiva, lunesDe, DIA_MS } from "../asistencia.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { cargarConfig, recalcularTurno, recalcularVentana } from "./asistenciaSvc.js";

async function turnoAutorizado(env, actor, turnoId) {
  const turno = await getDocument(env, `turnos/${turnoId}`);
  if (!turno || !turno.guardiaUid) throw new HttpError(404, "not_found");
  if (actor.rol === "supervisor") {
    const sitio = await getDocument(env, `sitios/${turno.sitioId}`);
    if (!sitio || sitio.supervisorUid !== actor.uid) throw new HttpError(403, "forbidden");
  }
  return turno;
}

const idDoc = () => `${Date.now().toString(36)}-${randomId(5)}`;
const motivoValido = (v) => str(v, "Motivo", 5, 300);

// Ajuste: corrige la hora efectiva de una entrada o salida (o la registra si faltó). Siempre con motivo.
export async function crearAjuste(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const turnoId = vId(b.turnoId, "turnoId");
  const turno = await turnoAutorizado(env, actor, turnoId);
  if (b.tipo !== "entrada" && b.tipo !== "salida") throw bad("Tipo: entrada o salida.");
  if (!RE_FECHA.test(b.fecha || "") || !RE_HORA.test(b.hora || "")) throw bad("Fecha (AAAA-MM-DD) y hora (HH:MM) de Hermosillo.");
  const horaMs = localAMs(b.fecha, b.hora);
  const motivo = motivoValido(b.motivo);
  if (horaMs < turno.inicioMs - 12 * 3600e3 || horaMs > turno.finMs + 24 * 3600e3) throw bad("La hora ajustada está demasiado lejos del turno.");

  const [entrada, salida, ajustes] = await Promise.all([
    getDocument(env, `marcas/${turnoId}_entrada`), getDocument(env, `marcas/${turnoId}_salida`),
    runQuery(env, "ajustesAsistencia", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }]),
  ]);
  const e = horaEfectiva(entrada?.tsMs ?? null, ajustes, "entrada");
  const s = horaEfectiva(salida?.tsMs ?? null, ajustes, "salida");
  if (b.tipo === "salida" && e != null && horaMs <= e) throw bad("La salida debe ser posterior a la entrada.");
  if (b.tipo === "entrada" && s != null && horaMs >= s) throw bad("La entrada debe ser anterior a la salida.");

  const ahora = Date.now();
  await commit(env, [
    {
      path: `ajustesAsistencia/${idDoc()}`,
      data: {
        turnoId, sitioId: turno.sitioId, guardiaUid: turno.guardiaUid, supervisorUid: turno.supervisorUid ?? null, tipo: b.tipo, horaMs, motivo,
        horaOriginalMs: (b.tipo === "entrada" ? entrada?.tsMs : salida?.tsMs) ?? null,
        autorUid: actor.uid, autorNombre: actor.perfil.nombre, tsMs: ahora, ...(turno.prueba === true ? { prueba: true } : {}),
      },
      mustNotExist: true, serverTimeField: "ts",
    },
    auditoria(actor, "asistencia.ajuste", turnoId, { tipo: b.tipo, horaMs, motivo }, turno),
  ]);
  const r = await recalcularTurno(env, turnoId, { ahora });
  return { status: 201, body: { ok: true, estado: r?.estado } };
}

// El supervisor autoriza que el saliente cierre sin que llegue su relevo.
export async function autorizarCierre(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const turnoId = vId(b.turnoId, "turnoId");
  const turno = await turnoAutorizado(env, actor, turnoId);
  const motivo = motivoValido(b.motivo);
  if (!(await getDocument(env, `marcas/${turnoId}_entrada`))) throw new HttpError(409, "sin_entrada", "El guardia aún no ha marcado entrada.");
  if (await getDocument(env, `marcas/${turnoId}_salida`)) throw new HttpError(409, "ya_marcada", "El guardia ya cerró su turno.");
  const ahora = Date.now();
  try {
    await commit(env, [
      {
        path: `autorizaciones/${turnoId}_cierre`,
        data: { tipo: "cierre", turnoId, sitioId: turno.sitioId, guardiaUid: turno.guardiaUid, supervisorUid: turno.supervisorUid ?? null, motivo, autorUid: actor.uid, autorNombre: actor.perfil.nombre, tsMs: ahora, ...(turno.prueba === true ? { prueba: true } : {}) },
        mustNotExist: true, serverTimeField: "ts",
      },
      auditoria(actor, "relevo.cierre_autorizado", turnoId, { motivo }, turno),
    ]);
  } catch (e) {
    if (e.status === 409) throw new HttpError(409, "exists", "Ya se autorizó el cierre de este turno.");
    throw e;
  }
  await recalcularTurno(env, turnoId, { ahora });
  return { status: 201, body: { ok: true } };
}

// Autoriza o rechaza las horas extra de un turno (con nombre y motivo).
export async function resolverExtra(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const turnoId = vId(b.turnoId, "turnoId");
  const turno = await turnoAutorizado(env, actor, turnoId);
  if (b.decision !== "autorizado" && b.decision !== "rechazado") throw bad("Decisión: autorizado o rechazado.");
  const motivo = motivoValido(b.motivo);
  const ahora = Date.now();
  const a = await recalcularTurno(env, turnoId, { ahora });
  if (!a || a.minutosExtra <= 0) throw new HttpError(409, "sin_extra", "Este turno no tiene horas extra.");
  if (a.extraEnCurso) throw new HttpError(409, "extra_en_curso", "El guardia aún no cierra su turno; las horas extra se pueden resolver cuando cierre.");
  await commit(env, [
    {
      path: `autorizaciones/${turnoId}_extra_${idDoc()}`,
      data: { tipo: "extra", turnoId, sitioId: turno.sitioId, guardiaUid: turno.guardiaUid, supervisorUid: turno.supervisorUid ?? null, decision: b.decision, minutos: a.minutosExtra, motivo, autorUid: actor.uid, autorNombre: actor.perfil.nombre, tsMs: ahora, ...(turno.prueba === true ? { prueba: true } : {}) },
      mustNotExist: true, serverTimeField: "ts",
    },
    auditoria(actor, `extra.${b.decision}`, turnoId, { minutos: a.minutosExtra, motivo }, turno),
  ]);
  const r = await recalcularTurno(env, turnoId, { ahora });
  return { status: 201, body: { ok: true, extraEstado: r.extraEstado } };
}

// Recalcula un rango (≤ 8 días) para refrescar alertas y resultados.
export async function recalcular(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  if (!RE_FECHA.test(b.desde || "") || !RE_FECHA.test(b.hasta || "")) throw bad("Fechas AAAA-MM-DD.");
  const d0 = localAMs(b.desde, "00:00");
  const d1 = localAMs(b.hasta, "00:00") + DIA_MS;
  if (d1 <= d0 || d1 - d0 > 8 * DIA_MS) throw bad("Rango máximo: 8 días.");
  const opts = { sitioId: b.sitioId ? vId(b.sitioId, "sitioId") : undefined };
  if (actor.rol === "supervisor") opts.supervisorUid = actor.uid;
  const n = await recalcularVentana(env, d0, d1, opts);
  return { status: 200, body: { ok: true, turnos: n } };
}

// Reporte de asistencia por periodo (JSON; el cliente lo exporta a CSV).
export async function reporte(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const p = new URL(request.url).searchParams;
  const desde = p.get("desde") || "", hasta = p.get("hasta") || "";
  if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) throw bad("Fechas AAAA-MM-DD.");
  const d0 = localAMs(desde, "00:00");
  const d1 = localAMs(hasta, "00:00") + DIA_MS;
  if (d1 <= d0 || d1 - d0 > 93 * DIA_MS) throw bad("Rango máximo: 93 días.");
  const sitioId = p.get("sitioId") ? vId(p.get("sitioId"), "sitioId") : null;
  const ahora = Date.now();
  const config = await cargarConfig(env);
  const filtro = (a) => (!sitioId || a.sitioId === sitioId) && (actor.rol === "admin" || a.supervisorUid === actor.uid);

  // Se refrescan los turnos del periodo que ya empezaron (el reporte nunca muestra datos viejos).
  await recalcularVentana(env, d0, Math.min(d1, ahora + 3600e3), { sitioId: sitioId || undefined, supervisorUid: actor.rol === "supervisor" ? actor.uid : undefined, omitirCerrados: true, ahora });

  const filas = (await runQuery(env, "asistencias", [
    { campo: "inicioMs", op: "GREATER_THAN_OR_EQUAL", valor: d0 }, { campo: "inicioMs", op: "LESS_THAN", valor: d1 },
  ], { limite: 2000 })).filter(filtro).sort((a, b) => a.inicioMs - b.inicioMs);

  // Acumulado semanal de extras: semanas completas que tocan el periodo.
  const s0 = localAMs(lunesDe(d0), "00:00");
  const s1 = localAMs(lunesDe(d1 - 1), "00:00") + 7 * DIA_MS;
  const semanas = (await runQuery(env, "asistencias", [
    { campo: "inicioMs", op: "GREATER_THAN_OR_EQUAL", valor: s0 }, { campo: "inicioMs", op: "LESS_THAN", valor: s1 },
  ], { limite: 3000 })).filter(filtro);
  const c = configEfectiva(config);

  const porGuardia = new Map();
  for (const a of filas) {
    const g = porGuardia.get(a.guardiaUid) || { guardiaUid: a.guardiaUid, guardiaNombre: a.guardiaNombre, turnos: 0, cumplidos: 0, retardos: 0, faltas: 0, minutosExtra: 0 };
    g.turnos++;
    if (a.estado === "cumplido") g.cumplidos++;
    if (a.retardo) g.retardos++;
    if (a.falta) g.faltas++;
    if (a.extraEstado === "pendiente" || a.extraEstado === "autorizado") g.minutosExtra += a.minutosExtra;
    porGuardia.set(a.guardiaUid, g);
  }
  const resumen = [...porGuardia.values()].map((g) => ({ ...g, faltasPorRetardos: Math.floor(g.retardos / c.retardosPorFalta), faltasTotales: g.faltas + Math.floor(g.retardos / c.retardosPorFalta) }));
  return { status: 200, body: { desde, hasta, filas, resumen, semanal: acumuladoSemanal(semanas, c), retardosPorFalta: c.retardosPorFalta, generadoMs: ahora, fechaLocal: fechaLocal(ahora) } };
}
