// Botón de pánico (guardia con sesión) y atención de la alerta (supervisor del sitio o admin).
//   · La alerta es INMUTABLE (panicos/{id}); su estado visible (activa/atendida) vive en panicoVista/{id}, que es lo
//     que escuchan en tiempo real el supervisor del sitio y el admin (reglas: supervisorUid == uid, o admin).
//   · Quién la atendió y cuándo queda en atencionesPanico/{id} (inmutable) y en la auditoría.
//   · Límite de frecuencia por guardia (Durable Object) y una alerta activa reciente se reutiliza en vez de duplicarse.
//   · Sin conexión: el celular la encola y la envía al volver la señal (misma validación de tiempo que los demás registros).
import { auditoria, authenticate, bad, id as vId, int, num, randomId, readJson, requireRol, str } from "../common.js";
import { distanciaM } from "../geo.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { camposOffline, escriturasRegistro, leerTiempo, siEsDuplicado } from "../offline.js";
import { notificar } from "../push.js";
import { limiter } from "../ratelimit.js";
import { cargarConfig } from "./asistenciaSvc.js";
import { sitioParaGestion, soloCampos } from "./turnoActivo.js";

export const PANICO_MIN_MS = 3000; // el botón se mantiene presionado 3 segundos
const MIN = 60000;
const LIMITE = { max: 5, windowMs: 10 * MIN, lockMs: 10 * MIN };
const REUTILIZAR_MS = 15 * MIN;

// Sitio al que pertenece la alerta: el turno indicado (propio) o el turno vigente/más cercano del guardia.
async function turnoParaAlerta(env, actor, turnoId, ahora) {
  if (turnoId !== undefined) {
    const t = await getDocument(env, `turnos/${vId(turnoId, "turnoId")}`);
    if (!t || t.guardiaUid !== actor.uid) throw new HttpError(403, "forbidden", "Este turno no es tuyo.");
    return { id: turnoId, ...t };
  }
  const propios = (await runQuery(env, "turnos", [{ campo: "guardiaUid", op: "EQUAL", valor: actor.uid }, { campo: "inicioMs", op: "GREATER_THAN_OR_EQUAL", valor: ahora - 40 * 3600e3 }, { campo: "inicioMs", op: "LESS_THAN", valor: ahora + 3 * 3600e3 }]))
    .filter((t) => t.estado === "programado" && t.inicioMs - 60 * MIN <= ahora && t.finMs + 6 * 3600e3 >= ahora)
    .sort((a, b) => b.inicioMs - a.inicioMs);
  return propios[0] || null;
}

export async function crearPanico(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const b = await readJson(request, 4096);
  soloCampos(b, ["turnoId", "lat", "lng", "precisionM", "mantenidoMs", "horaDispositivoMs", "sync"]);
  const mantenidoMs = int(Number.isFinite(b.mantenidoMs) ? Math.round(b.mantenidoMs) : b.mantenidoMs, "Tiempo presionado", 0, 600000);
  if (mantenidoMs < PANICO_MIN_MS) throw new HttpError(400, "pulsacion_corta", "Mantén presionado el botón de pánico durante 3 segundos.");
  const config = await cargarConfig(env);
  const t = await leerTiempo(env, actor, b, config);
  if ((await limiter(env, `panico:${actor.uid}`, "check", LIMITE)).locked) throw new HttpError(429, "demasiadas_alertas", "Ya enviaste varias alertas seguidas. Tu supervisor ya fue avisado; si es una emergencia, llama al 911.");

  let lat = null, lng = null, precisionM = null;
  if (b.lat !== undefined && b.lat !== null) { lat = num(b.lat, "Latitud", -90, 90); lng = num(b.lng, "Longitud", -180, 180); precisionM = num(b.precisionM, "Precisión", 0, 100000); }
  const turno = await turnoParaAlerta(env, actor, b.turnoId, t.ahora);
  const sitio = turno ? await getDocument(env, `sitios/${turno.sitioId}`) : null;
  const dist = lat !== null && typeof sitio?.lat === "number" ? Math.round(distanciaM(lat, lng, sitio.lat, sitio.lng) * 10) / 10 : null;

  // Una alerta ACTIVA reciente del mismo guardia se reutiliza (no se inunda al supervisor con pulsaciones repetidas).
  const activas = (await runQuery(env, "panicoVista", [{ campo: "guardiaUid", op: "EQUAL", valor: actor.uid }, { campo: "estado", op: "EQUAL", valor: "activa" }]))
    .filter((p) => t.recibidoMs - (p.recibidoMs ?? p.tsMs) < REUTILIZAR_MS);
  if (activas.length) return { status: 200, body: { ok: true, id: activas[0].id, repetida: true } };

  const id = t.registroId ? `o${t.registroId.slice(0, 16)}` : `${t.ahora.toString(36)}-${randomId(5)}`;
  const prueba = actor.perfil.prueba === true || turno?.prueba === true || sitio?.prueba === true;
  const base = {
    guardiaUid: actor.uid, guardiaNombre: actor.perfil.nombre, sitioId: turno?.sitioId ?? null, turnoId: turno?.id ?? null,
    tsMs: t.ahora, recibidoMs: t.recibidoMs, mantenidoMs, lat, lng, precisionM, distanciaM: dist, ...(prueba ? { prueba: true } : {}), ...camposOffline(t),
  };
  try {
    await commit(env, [
      { path: `panicos/${id}`, data: base, mustNotExist: true, serverTimeField: "ts" }, // inmutable
      {
        path: `panicoVista/${id}`,
        data: {
          ...base, panicoId: id, sitioNombre: sitio?.nombre || "", supervisorUid: sitio?.supervisorUid ?? null, telefonoEmergencia: sitio?.telefonoEmergencia || "", sinSitio: !sitio,
          estado: "activa", atendidaPorUid: null, atendidaPorNombre: null, atendidaPorRol: null, atendidaMs: null, notaAtencion: null,
        },
        serverTimeField: "actualizadoEn",
      },
      ...escriturasRegistro(t, { tipo: "panico", titulo: "Alerta de pánico", refPath: `panicos/${id}`, sitioId: turno?.sitioId ?? "", sitioNombre: sitio?.nombre || "", supervisorUid: sitio?.supervisorUid ?? null, guardiaUid: actor.uid, guardiaNombre: actor.perfil.nombre, prueba }),
      auditoria(actor, "panico.alerta", id, { sitioId: turno?.sitioId ?? null, sin_conexion: t.sin_conexion }, { prueba }),
    ]);
  } catch (e) {
    await siEsDuplicado(env, e, t);
    throw e;
  }
  await limiter(env, `panico:${actor.uid}`, "fail", LIMITE); // cuenta la alerta para el límite de frecuencia
  const push = await notificar(env, { evento: "panico", sitio, prueba });
  return { status: 201, body: { ok: true, id, tsMs: t.ahora, sin_conexion: t.sin_conexion, avisados: push.enviados, sinSupervisor: !sitio?.supervisorUid } };
}

// Atiende la alerta: queda registrado quién y cuándo (la primera atención gana; no se sobrescribe).
export async function atenderPanico(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request, 2048);
  soloCampos(b, ["id", "nota"]);
  const id = vId(b.id, "id");
  const v = await getDocument(env, `panicoVista/${id}`);
  if (!v) throw new HttpError(404, "not_found");
  if (v.sitioId) await sitioParaGestion(env, actor, v.sitioId); // supervisor ACTUAL del sitio o admin
  else if (actor.rol !== "admin") throw new HttpError(403, "forbidden");
  if (v.estado === "atendida") throw new HttpError(409, "ya_atendida", `Ya la atendió ${v.atendidaPorNombre}.`);
  const nota = str(b.nota, "Nota", 0, 300, { opcional: true });
  const ahora = Date.now();
  try {
    await commit(env, [
      { path: `atencionesPanico/${id}`, data: { panicoId: id, sitioId: v.sitioId ?? null, atendidaPorUid: actor.uid, atendidaPorNombre: actor.perfil.nombre, atendidaPorRol: actor.rol, atendidaMs: ahora, nota, ...(v.prueba === true ? { prueba: true } : {}) }, mustNotExist: true, serverTimeField: "ts" },
      auditoria(actor, "panico.atendida", id, { nota }, v),
    ]);
  } catch (e) {
    if (e.status === 409) throw new HttpError(409, "ya_atendida", "Otra persona la atendió hace un momento.");
    throw e;
  }
  await commit(env, [{ path: `panicoVista/${id}`, data: { estado: "atendida", atendidaPorUid: actor.uid, atendidaPorNombre: actor.perfil.nombre, atendidaPorRol: actor.rol, atendidaMs: ahora, notaAtencion: nota }, merge: true, mustExist: true, serverTimeField: "actualizadoEn" }]);
  return { status: 200, body: { ok: true, atendidaMs: ahora } };
}

void bad;
