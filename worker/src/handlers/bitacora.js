// Bitácora del turno (libro de novedades): novedades de texto del guardia (inmutables, hora del servidor) y
// vista consolidada cronológica: entrada, novedades, rondines, incidencias, visitantes, salida y notas de relevo.
import { authenticate, bad, id as vId, randomId, readJson, requireRol, str } from "../common.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { buscarPredecesor } from "./asistenciaSvc.js";
import { sitioParaGestion, soloCampos, turnoActivoDelGuardia } from "./turnoActivo.js";
import { camposOffline, escriturasRegistro, leerTiempo, siEsDuplicado } from "../offline.js";
import { cargarConfig } from "./asistenciaSvc.js";

export async function crearNovedad(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const b = await readJson(request);
  soloCampos(b, ["turnoId", "texto", "sync"]);
  const config = await cargarConfig(env);
  const t = await leerTiempo(env, actor, b, config);
  const { turno, sitio } = await turnoActivoDelGuardia(env, actor, vId(b.turnoId, "turnoId"), t, config);
  const texto = str(b.texto, "Novedad", 2, 1000);
  const ahora = t.ahora; // hora del servidor (o la estimada, acotada, si vino sin conexión)
  const id = t.registroId ? `o${t.registroId.slice(0, 16)}` : `${ahora.toString(36)}-${randomId(5)}`;
  try {
    await commit(env, [{
      path: `novedades/${id}`,
      data: { turnoId: b.turnoId, sitioId: turno.sitioId, guardiaUid: actor.uid, texto, tsMs: ahora, ...(turno.prueba === true || sitio.prueba === true ? { prueba: true } : {}), ...camposOffline(t) },
      mustNotExist: true, serverTimeField: "ts", // inmutable
    }, ...escriturasRegistro(t, { tipo: "novedad", titulo: "Novedad", refPath: `novedades/${id}`, sitioId: turno.sitioId, sitioNombre: sitio.nombre, supervisorUid: sitio.supervisorUid ?? null, guardiaUid: actor.uid, guardiaNombre: actor.perfil.nombre, prueba: turno.prueba === true || sitio.prueba === true })]);
  } catch (e) { await siEsDuplicado(env, e, t); throw e; }
  return { status: 201, body: { ok: true, id, tsMs: ahora } };
}

// Arma la bitácora consolidada de un turno.
export async function armarBitacora(env, turnoId, turno) {
  const [asis, novedades, rondines, incidencias, entradas, salidas, guardia] = await Promise.all([
    getDocument(env, `asistencias/${turnoId}`),
    runQuery(env, "novedades", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }]),
    runQuery(env, "rondines", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }]),
    runQuery(env, "incidenciasResumen", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }]),
    runQuery(env, "visitantesVista", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }]),
    runQuery(env, "visitantesVista", [{ campo: "salidaTurnoId", op: "EQUAL", valor: turnoId }]),
    getDocument(env, `usuarios/${turno.guardiaUid}`),
  ]);
  const items = [];
  const add = (tsMs, tipo, titulo, detalle = "", extra = {}) => { if (tsMs != null) items.push({ tsMs, tipo, titulo, detalle, ...extra }); };
  if (asis?.entradaMs) add(asis.entradaMs, "entrada", "Entrada al turno", asis.retardo ? `Retardo de ${asis.retardoMin} min` : "", { sin_conexion: asis.entradaSinConexion === true });
  for (const n of novedades) add(n.tsMs, "novedad", "Novedad", n.texto, { sin_conexion: n.sin_conexion === true });
  for (const r of rondines) {
    if (r.iniciadoMs) add(r.iniciadoMs, "rondin", `Rondín de las ${new Date(r.programadoMs - 7 * 3600e3).toISOString().slice(11, 16)}`, `${r.hechos}/${r.total} puntos · ${r.estado}`, { estado: r.estado });
    else if (["no_iniciado", "justificado"].includes(r.estado)) add(r.cierraInicioMs, "rondin", `Rondín de las ${new Date(r.programadoMs - 7 * 3600e3).toISOString().slice(11, 16)}`, r.estado === "no_iniciado" ? "No iniciado" : `Justificado: ${r.justificadoMotivo || ""}`, { estado: r.estado });
  }
  for (const i of incidencias) add(i.creadoMs, "incidencia", `Incidencia (${i.gravedad}): ${i.tipoNombre}`, i.descripcion, { gravedad: i.gravedad, estado: i.estado, incidenciaId: i.incidenciaId, sin_conexion: i.sin_conexion === true });
  for (const v of entradas) add(v.entradaMs, "visitante_entrada", `Entra visitante: ${v.nombre}`, `Visita a ${v.visitaA} · ${v.motivo}${v.empresa ? " · " + v.empresa : ""}${v.placas ? " · placas " + v.placas : ""}`, { sin_conexion: v.sin_conexion === true });
  for (const v of salidas) add(v.salidaMs, "visitante_salida", `Sale visitante: ${v.nombre}`, "");
  if (asis?.salidaMs) add(asis.salidaMs, "salida", "Salida del turno", asis.notasEntrega ? `Notas de entrega: ${asis.notasEntrega}` : "Sin notas de entrega", { sin_conexion: asis.salidaSinConexion === true });
  items.sort((a, b) => a.tsMs - b.tsMs);
  const dentro = (await runQuery(env, "visitantesVista", [{ campo: "sitioId", op: "EQUAL", valor: turno.sitioId }, { campo: "dentro", op: "EQUAL", valor: true }]));
  return {
    turnoId, sitioId: turno.sitioId, sitioNombre: turno.sitioNombre || "", guardiaNombre: guardia?.nombre || "", inicioMs: turno.inicioMs, finMs: turno.finMs,
    notasEntrega: asis?.salidaMs ? asis.notasEntrega || "" : null, cerrado: Boolean(asis?.salidaMs), items,
    visitantesDentro: dentro.sort((a, b) => a.entradaMs - b.entradaMs).map((v) => ({ id: v.visitanteId, nombre: v.nombre, visitaA: v.visitaA, motivo: v.motivo, entradaMs: v.entradaMs })),
  };
}

// Bitácora de un turno: el guardia de ese turno, el supervisor del sitio o el admin.
export async function bitacoraTurno(env, request) {
  const actor = await authenticate(env, request);
  const turnoId = vId(new URL(request.url).searchParams.get("turnoId"), "turnoId");
  const turno = await getDocument(env, `turnos/${turnoId}`);
  if (!turno || !turno.guardiaUid) throw new HttpError(404, "not_found");
  if (actor.rol === "guardia") { if (turno.guardiaUid !== actor.uid) throw new HttpError(403, "forbidden"); }
  else await sitioParaGestion(env, actor, turno.sitioId);
  return { status: 200, body: await armarBitacora(env, turnoId, turno) };
}

// Bitácora del turno ANTERIOR de mi sitio (para el guardia entrante). Solo con un turno propio.
export async function bitacoraAnterior(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const miId = vId(new URL(request.url).searchParams.get("turnoId"), "turnoId");
  const mio = await getDocument(env, `turnos/${miId}`);
  if (!mio || mio.guardiaUid !== actor.uid) throw new HttpError(403, "forbidden");
  const prev = await buscarPredecesor(env, mio, miId);
  if (!prev) return { status: 200, body: { hay: false } };
  const { id, ...turno } = prev;
  return { status: 200, body: { hay: true, bitacora: await armarBitacora(env, id, turno) } };
}

void bad;
