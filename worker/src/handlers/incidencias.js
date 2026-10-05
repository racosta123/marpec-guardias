// Incidencias: reporte inmutable del guardia (hasta 3 fotos en R2), seguimiento del supervisor como registros
// nuevos (comentarios y cambios de estado) y catálogo de tipos configurable por el admin.
import { auditoria, authenticate, bad, id as vId, num, randomId, readJson, requireRol, str } from "../common.js";
import { distanciaM } from "../geo.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { validarFoto } from "./marcas.js";
import { enumerado, sitioParaGestion, soloCampos, turnoActivoDelGuardia } from "./turnoActivo.js";
import { camposOffline, escriturasRegistro, leerTiempo, siEsDuplicado } from "../offline.js";
import { cargarConfig } from "./asistenciaSvc.js";
import { notificar } from "../push.js";

export const TIPOS_DEFECTO = [
  { id: "acceso_no_autorizado", nombre: "Acceso no autorizado", activo: true },
  { id: "robo", nombre: "Robo", activo: true },
  { id: "danio", nombre: "Daño", activo: true },
  { id: "falla_electrica", nombre: "Falla eléctrica", activo: true },
  { id: "falla_equipo", nombre: "Falla de equipo", activo: true },
  { id: "persona_sospechosa", nombre: "Persona sospechosa", activo: true },
  { id: "otro", nombre: "Otro", activo: true },
];
export const GRAVEDADES = ["baja", "media", "alta"];
export const ESTADOS = ["abierta", "en_atencion", "cerrada"];
const TRANSICIONES = { abierta: ["en_atencion", "cerrada"], en_atencion: ["cerrada"], cerrada: [] };
const BODY_MAX = 700 * 1024; // 3 fotos de hasta 150 KB en base64
const MAX_SEGUIMIENTOS = 60;

export async function cargarCatalogo(env) {
  const d = await getDocument(env, "configuracion/catalogos");
  return Array.isArray(d?.tiposIncidencia) && d.tiposIncidencia.length ? d.tiposIncidencia : TIPOS_DEFECTO;
}

export async function catalogoIncidencias(env, request) {
  await authenticate(env, request);
  return { status: 200, body: { tipos: (await cargarCatalogo(env)).filter((t) => t.activo !== false), gravedades: GRAVEDADES } };
}

// Admin: agrega tipos, renombra o desactiva. Nunca se eliminan (los reportes históricos los referencian).
export async function guardarCatalogo(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const b = await readJson(request);
  soloCampos(b, ["tipos"]);
  if (!Array.isArray(b.tipos) || b.tipos.length < 1 || b.tipos.length > 30) throw bad("Tipos: de 1 a 30.");
  const actuales = await cargarCatalogo(env);
  const usados = new Set();
  const tipos = b.tipos.map((t) => {
    soloCampos(t || {}, ["id", "nombre", "activo"]);
    const id = t.id === undefined ? `t_${randomId(4)}` : vId(t.id, "id");
    if (usados.has(id)) throw bad(`Tipo repetido: ${id}.`);
    usados.add(id);
    if (t.id !== undefined && !actuales.some((a) => a.id === id)) throw bad(`Tipo desconocido: ${id}.`);
    if (typeof t.activo !== "boolean") throw bad("activo: booleano.");
    return { id, nombre: str(t.nombre, "Nombre del tipo", 2, 60), activo: t.activo };
  });
  const faltan = actuales.filter((a) => !usados.has(a.id));
  if (faltan.length) throw bad(`No se pueden eliminar tipos (desactívalos): ${faltan.map((f) => f.nombre).join(", ")}.`);
  if (!tipos.some((t) => t.activo)) throw bad("Debe quedar al menos un tipo activo.");
  await commit(env, [
    { path: "configuracion/catalogos", data: { tiposIncidencia: tipos }, merge: true, serverTimeField: "actualizadoEn" },
    auditoria(actor, "catalogo.incidencias", "configuracion/catalogos", { n: tipos.length }),
  ]);
  return { status: 200, body: { ok: true, tipos } };
}

// Resumen (recalculable) que leen supervisor, admin y el guardia autor: estado actual + seguimiento.
async function construirResumen(env, incId, inc, seguimientos) {
  const sitio = await getDocument(env, `sitios/${inc.sitioId}`);
  const orden = [...seguimientos].sort((a, b) => a.tsMs - b.tsMs);
  const ultimoEstado = [...orden].reverse().find((s) => s.tipo === "estado");
  const estado = ultimoEstado ? ultimoEstado.estadoNuevo : "abierta";
  return {
    incidenciaId: incId, sitioId: inc.sitioId, sitioNombre: sitio?.nombre || "", supervisorUid: sitio?.supervisorUid ?? null,
    guardiaUid: inc.guardiaUid, guardiaNombre: inc.guardiaNombre, turnoId: inc.turnoId, tipoId: inc.tipoId, tipoNombre: inc.tipoNombre,
    gravedad: inc.gravedad, descripcion: inc.descripcion, creadoMs: inc.creadoMs, lat: inc.lat, lng: inc.lng, precisionM: inc.precisionM, distanciaM: inc.distanciaM,
    nFotos: inc.fotoKeys.length, estado, ...(inc.sin_conexion === true ? { sin_conexion: true, recibidoMs: inc.recibidoMs } : {}), estadoMs: ultimoEstado ? ultimoEstado.tsMs : inc.creadoMs, alta: inc.gravedad === "alta",
    seguimientos: orden.slice(-MAX_SEGUIMIENTOS).map((s) => ({ tipo: s.tipo, estadoNuevo: s.estadoNuevo ?? null, texto: s.texto, autorNombre: s.autorNombre, autorRol: s.autorRol, tsMs: s.tsMs })),
    ...(inc.prueba === true ? { prueba: true } : {}),
  };
}

export async function refrescarResumen(env, incId) {
  const inc = await getDocument(env, `incidencias/${incId}`);
  if (!inc) return null;
  const seg = await runQuery(env, "seguimientosIncidencia", [{ campo: "incidenciaId", op: "EQUAL", valor: incId }]);
  const r = await construirResumen(env, incId, inc, seg);
  await commit(env, [{ path: `incidenciasResumen/${incId}`, data: r, serverTimeField: "actualizadoEn" }]);
  return r;
}

export async function crearIncidencia(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const b = await readJson(request, BODY_MAX);
  soloCampos(b, ["turnoId", "tipoId", "gravedad", "descripcion", "fotos", "lat", "lng", "precisionM", "horaDispositivoMs", "sync"]);
  const config = await cargarConfig(env);
  const t = await leerTiempo(env, actor, b, config);
  const { turno, sitio } = await turnoActivoDelGuardia(env, actor, vId(b.turnoId, "turnoId"), t, config);
  const tipo = (await cargarCatalogo(env)).find((t) => t.id === b.tipoId && t.activo !== false);
  if (!tipo) throw bad("Tipo de incidencia inválido o inactivo.");
  const gravedad = enumerado(b.gravedad, "Gravedad", GRAVEDADES);
  const descripcion = str(b.descripcion, "Descripción", 5, 1000);
  const fotos = b.fotos === undefined ? [] : b.fotos;
  if (!Array.isArray(fotos) || fotos.length > 3) throw bad("Hasta 3 fotos.");
  const bytes = fotos.map((f) => validarFoto(f));
  if (bytes.length && !env.SELFIES) throw new HttpError(503, "almacenamiento_no_disponible", "El almacenamiento de fotos no está disponible. Intenta más tarde.");

  let lat = null, lng = null, precisionM = null, dist = null;
  if (b.lat !== undefined && b.lat !== null) {
    lat = num(b.lat, "Latitud", -90, 90); lng = num(b.lng, "Longitud", -180, 180); precisionM = num(b.precisionM, "Precisión", 0, 100000);
    if (typeof sitio.lat === "number") dist = Math.round(distanciaM(lat, lng, sitio.lat, sitio.lng) * 10) / 10;
  }
  const ahora = t.ahora; // hora del servidor (o la estimada, acotada, si vino sin conexión)
  const incId = t.registroId ? `o${t.registroId.slice(0, 16)}` : `${ahora.toString(36)}-${randomId(5)}`;
  const guardia = await getDocument(env, `usuarios/${actor.uid}`);
  const fotoKeys = bytes.map((_, i) => `incidencias/${turno.sitioId}/${incId}/${i}-${randomId(5)}.jpg`);
  for (let i = 0; i < bytes.length; i++)
    await env.SELFIES.put(fotoKeys[i], bytes[i], { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { incidencia: incId, guardiaUid: actor.uid } });
  const inc = {
    sitioId: turno.sitioId, turnoId: b.turnoId, guardiaUid: actor.uid, guardiaNombre: guardia?.nombre || "", tipoId: tipo.id, tipoNombre: tipo.nombre,
    gravedad, descripcion, creadoMs: ahora, lat, lng, precisionM, distanciaM: dist, fotoKeys,
    horaDispositivoMs: Number.isFinite(b.horaDispositivoMs) ? Math.round(b.horaDispositivoMs) : null,
    ...(turno.prueba === true || sitio.prueba === true ? { prueba: true } : {}),
    ...camposOffline(t),
  };
  try {
    await commit(env, [
      { path: `incidencias/${incId}`, data: inc, mustNotExist: true, serverTimeField: "ts" }, // inmutable
      { path: `incidenciasResumen/${incId}`, data: await construirResumen(env, incId, inc, []), serverTimeField: "actualizadoEn" },
      ...escriturasRegistro(t, { tipo: "incidencia", titulo: `Incidencia (${gravedad}): ${tipo.nombre}`, refPath: `incidencias/${incId}`, sitioId: turno.sitioId, sitioNombre: sitio.nombre, supervisorUid: sitio.supervisorUid ?? null, guardiaUid: actor.uid, guardiaNombre: guardia?.nombre || "", prueba: inc.prueba === true }),
    ]);
  } catch (e) {
    for (const k of fotoKeys) await env.SELFIES.delete(k).catch(() => {});
    await siEsDuplicado(env, e, t);
    throw e;
  }
  if (gravedad === "alta") await notificar(env, { evento: "incidencia_alta", sitio, sitioId: turno.sitioId, prueba: inc.prueba === true });
  return { status: 201, body: { ok: true, id: incId, gravedad, nFotos: fotoKeys.length } };
}

// Seguimiento (admin o supervisor del sitio): comentario o cambio de estado. SIEMPRE un registro nuevo.
export async function seguimientoIncidencia(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  soloCampos(b, ["incidenciaId", "tipo", "estadoNuevo", "texto"]);
  const incId = vId(b.incidenciaId, "incidenciaId");
  const inc = await getDocument(env, `incidencias/${incId}`);
  if (!inc) throw new HttpError(404, "not_found");
  await sitioParaGestion(env, actor, inc.sitioId);
  const resumen = await getDocument(env, `incidenciasResumen/${incId}`);
  const estadoActual = resumen?.estado || "abierta";
  const tipo = enumerado(b.tipo, "Tipo", ["comentario", "estado"]);
  let estadoNuevo = null;
  let texto;
  if (tipo === "comentario") texto = str(b.texto, "Comentario", 2, 500);
  else {
    estadoNuevo = enumerado(b.estadoNuevo, "Estado", ESTADOS);
    if (!TRANSICIONES[estadoActual].includes(estadoNuevo)) throw new HttpError(409, "transicion_invalida", `No se puede pasar de «${estadoActual}» a «${estadoNuevo}».`);
    texto = str(b.texto, "Nota del cambio", 0, 300, { opcional: true });
  }
  const ahora = Date.now();
  const segId = `${ahora.toString(36)}-${randomId(5)}`;
  const seg = { incidenciaId: incId, tipo, estadoNuevo, texto, autorUid: actor.uid, autorNombre: actor.perfil.nombre, autorRol: actor.rol, tsMs: ahora, ...(inc.prueba === true ? { prueba: true } : {}) };
  await commit(env, [
    { path: `seguimientosIncidencia/${segId}`, data: seg, mustNotExist: true, serverTimeField: "ts" },
    auditoria(actor, tipo === "estado" ? "incidencia.estado" : "incidencia.comentario", incId, { estadoNuevo, texto }, inc),
  ]);
  const r = await refrescarResumen(env, incId);
  return { status: 201, body: { ok: true, estado: r.estado } };
}

export async function fotoIncidencia(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const p = new URL(request.url).searchParams;
  const incId = vId(p.get("incidencia"), "incidencia");
  const n = Number(p.get("n"));
  if (!Number.isInteger(n) || n < 0 || n > 2) throw bad("Foto inválida.");
  const inc = await getDocument(env, `incidencias/${incId}`);
  if (!inc || !inc.fotoKeys?.[n]) throw new HttpError(404, "not_found");
  await sitioParaGestion(env, actor, inc.sitioId); // supervisor actual del sitio o admin
  if (!env.SELFIES) throw new HttpError(503, "almacenamiento_no_disponible");
  const obj = await env.SELFIES.get(inc.fotoKeys[n]);
  if (!obj) throw new HttpError(404, "not_found");
  return { status: 200, binary: { body: obj.body, contentType: "image/jpeg" } };
}
