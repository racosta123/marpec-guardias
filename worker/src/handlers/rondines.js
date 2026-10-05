// Rondines: escaneo de puntos (guardia), consulta del rondín, fotos, ajustes y reportes.
// Hora SIEMPRE del servidor; los escaneos son inmutables; las correcciones son ajustes con motivo.
import { auditoria, authenticate, bad, id as vId, localAMs, num, randomId, readJson, requireRol, str, RE_FECHA } from "../common.js";
import { cumplimiento, elegirSlot } from "../rondines.js";
import { distanciaM } from "../geo.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { verificarFirmaPunto } from "../qr.js";
import { validarFoto } from "./marcas.js";
import { contextoTurno, recalcularRondin, recalcularRondinesVentana } from "./rondinesSvc.js";

const BODY_MAX = 230 * 1024;
const MIN = 60000;
const DIA = 86400000;

// ------------------------------------------------------------------ guardia
async function turnoDelGuardia(env, actor, turnoId) {
  const turno = await getDocument(env, `turnos/${turnoId}`);
  if (!turno || turno.guardiaUid !== actor.uid) throw new HttpError(403, "forbidden", "Este turno no es tuyo.");
  return turno;
}

// Turno activo para rondinear: propio, programado, con entrada marcada y sin salida.
async function exigirTurnoActivo(env, turno, turnoId) {
  if (turno.estado !== "programado") throw new HttpError(409, "sin_turno_activo", "Este turno ya no está activo.");
  if (!(await getDocument(env, `marcas/${turnoId}_entrada`))) throw new HttpError(409, "sin_entrada", "Primero debes marcar tu entrada.");
  if (await getDocument(env, `marcas/${turnoId}_salida`)) throw new HttpError(409, "sin_turno_activo", "Ya cerraste tu turno.");
}

// Calcula los rondines con ventana vigente (o próximos) y devuelve el mapa de estados + docs.
async function estadosActivos(env, turnoId, ctx, ahora) {
  const docs = {};
  for (const s of ctx.slots) {
    if (ahora >= s.abreMs - 10 * MIN && ahora <= s.venceMs + 10 * MIN) docs[s.indice] = await recalcularRondin(env, turnoId, s, ctx, { ahora });
  }
  const guardados = await runQuery(env, "rondines", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }]);
  const estados = {};
  for (const s of ctx.slots) {
    const d = docs[s.indice] || guardados.find((g) => g.indice === s.indice);
    estados[s.indice] = d ? d.estado : (ahora < s.abreMs ? "programado" : "pendiente");
  }
  return { docs, estados, guardados };
}

export async function proximoRondin(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const turnoId = vId(new URL(request.url).searchParams.get("turnoId"), "turnoId");
  const turno = await turnoDelGuardia(env, actor, turnoId);
  const ahora = Date.now();
  const ctx = await contextoTurno(env, turnoId, turno);
  if (!ctx || !ctx.programa || !ctx.slots.length) return { status: 200, body: { hay: false, motivo: "sin_programa" } };
  if (!(await getDocument(env, `marcas/${turnoId}_entrada`))) return { status: 200, body: { hay: false, motivo: "sin_entrada" } };
  if (await getDocument(env, `marcas/${turnoId}_salida`)) return { status: 200, body: { hay: false, motivo: "turno_cerrado" } };

  const { docs, estados, guardados } = await estadosActivos(env, turnoId, ctx, ahora);
  const rondines = ctx.slots.map((s) => {
    const d = docs[s.indice] || guardados.find((g) => g.indice === s.indice);
    return { indice: s.indice, programadoMs: s.programadoMs, abreMs: s.abreMs, cierraInicioMs: s.cierraInicioMs, venceMs: s.venceMs, estado: estados[s.indice], hechos: d?.hechos ?? 0, total: d?.total ?? ctx.puntos.length };
  });
  const actual = elegirSlot(ctx.slots, estados, ahora);
  let detalle = null;
  if (actual) {
    const d = docs[actual.indice] || (await recalcularRondin(env, turnoId, actual, ctx, { ahora }));
    const info = new Map(ctx.puntos.map((p) => [p.id, p]));
    detalle = {
      indice: actual.indice, programadoMs: actual.programadoMs, venceMs: actual.venceMs, estado: d.estado, hechos: d.hechos, total: d.total, porcentaje: d.porcentaje,
      modo: ctx.programa.modo, siguientePuntoId: d.siguientePuntoId,
      puntos: d.detalle.map((p) => ({ puntoId: p.puntoId, nombre: p.nombre, orden: p.orden, descripcion: info.get(p.puntoId)?.descripcion || "", hecho: p.hecho, tsMs: p.tsMs, requiereGps: info.get(p.puntoId)?.lat != null })),
    };
  }
  const proximo = ctx.slots.find((s) => s.programadoMs > ahora && s.indice !== actual?.indice) || null;
  return { status: 200, body: { hay: true, modo: ctx.programa.modo, rondines, actual: detalle, proximoMs: proximo?.programadoMs ?? null } };
}

export async function escanearPunto(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const b = await readJson(request, BODY_MAX);
  const turnoId = vId(b.turnoId, "turnoId");
  const ahora = Date.now(); // hora del servidor
  const turno = await turnoDelGuardia(env, actor, turnoId);
  await exigirTurnoActivo(env, turno, turnoId);

  // QR del punto: formato MPC2 firmado, versión vigente y de ESTE sitio. Un QR de asistencia (MPC1) no sirve.
  const qrInvalido = () => new HttpError(400, "qr_invalido", "Ese código QR no es un punto de control válido de tu puesto.");
  const q = await verificarFirmaPunto(env, b.qr);
  if (!q) throw qrInvalido();
  const punto = await getDocument(env, `puntos/${q.puntoId}`);
  if (!punto || punto.activo === false || punto.sitioId !== turno.sitioId || (punto.qrVersion || 1) !== q.version) throw qrInvalido();

  const puntoId = q.puntoId; // getDocument no devuelve el id: se toma del QR ya verificado
  const ctx = await contextoTurno(env, turnoId, turno);
  if (!ctx || !ctx.programa || !ctx.slots.length) throw new HttpError(409, "sin_rondin_activo", "Este sitio no tiene rondines programados para tu turno.");
  const { docs, estados } = await estadosActivos(env, turnoId, ctx, ahora);
  const slot = elegirSlot(ctx.slots, estados, ahora);
  if (!slot) throw new HttpError(409, "sin_rondin_activo", "No hay un rondín programado en este momento.");
  const rondin = docs[slot.indice] || (await recalcularRondin(env, turnoId, slot, ctx, { ahora }));
  const rondinId = rondin.rondinId;

  const enRondin = rondin.requeridos.find((r) => r.puntoId === puntoId);
  if (!enRondin) throw new HttpError(409, "punto_fuera_de_rondin", "Este punto no forma parte del rondín en curso.");
  if (rondin.detalle.find((d) => d.puntoId === puntoId)?.hecho) throw new HttpError(409, "ya_escaneado", `Ya registraste «${punto.nombre}» en este rondín.`);
  if (rondin.modo === "ordenada" && rondin.siguientePuntoId !== puntoId) {
    const esperado = rondin.requeridos.find((r) => r.puntoId === rondin.siguientePuntoId);
    throw new HttpError(409, "fuera_de_orden", `La ruta es ordenada: el siguiente punto es «${esperado?.nombre || "—"}».`);
  }

  // GPS del punto (solo si está configurado)
  let lat = null, lng = null, precisionM = null, dist = null;
  if (b.lat !== undefined && b.lat !== null) { lat = num(b.lat, "Latitud", -90, 90); lng = num(b.lng, "Longitud", -180, 180); precisionM = num(b.precisionM, "Precisión", 0, 100000); }
  if (typeof punto.lat === "number" && typeof punto.lng === "number") {
    if (lat === null) throw new HttpError(400, "gps_requerido", "Este punto requiere tu ubicación. Activa el GPS e inténtalo de nuevo.");
    if (precisionM > punto.radioM) throw new HttpError(400, "gps_precision", `La precisión del GPS (±${Math.round(precisionM)} m) es peor que el radio del punto (${punto.radioM} m). Acércate a cielo abierto e inténtalo de nuevo.`);
    dist = distanciaM(lat, lng, punto.lat, punto.lng);
    if (dist > punto.radioM) throw new HttpError(403, "fuera_perimetro_punto", `Estás fuera del radio del punto (a ${Math.round(dist)} m; el límite es ${punto.radioM} m).`);
  }
  const nota = str(b.nota, "Nota", 0, 300, { opcional: true });
  let foto = null, fotoKey = null;
  if (b.foto !== undefined && b.foto !== null && b.foto !== "") {
    foto = validarFoto(b.foto);
    if (!env.SELFIES) throw new HttpError(503, "almacenamiento_no_disponible", "El almacenamiento de fotos no está disponible. Intenta más tarde.");
    fotoKey = `rondines/${turno.sitioId}/${turnoId}/${slot.indice}/${puntoId}-${randomId(6)}.jpg`;
    await env.SELFIES.put(fotoKey, foto, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { turnoId, rondinId, puntoId: puntoId, guardiaUid: actor.uid } });
  }
  const horaDispositivoMs = Number.isFinite(b.horaDispositivoMs) ? Math.round(b.horaDispositivoMs) : null;
  try {
    await commit(env, [{
      path: `escaneos/${rondinId}_${puntoId}`,
      data: {
        rondinId, turnoId, indice: slot.indice, sitioId: turno.sitioId, guardiaUid: actor.uid, puntoId: puntoId, puntoNombre: punto.nombre, orden: punto.orden,
        tsMs: ahora, lat, lng, precisionM, distanciaM: dist === null ? null : Math.round(dist * 10) / 10, nota, fotoKey, fotoBytes: foto ? foto.length : null,
        horaDispositivoMs, desfaseDispositivoMs: horaDispositivoMs === null ? null : horaDispositivoMs - ahora,
        ...(turno.prueba === true || punto.prueba === true ? { prueba: true } : {}),
      },
      mustNotExist: true, serverTimeField: "ts", // un solo registro por punto y rondín; inmutable
    }]);
  } catch (e) {
    if (fotoKey) await env.SELFIES.delete(fotoKey).catch(() => {});
    if (e.status === 409) throw new HttpError(409, "ya_escaneado", `Ya registraste «${punto.nombre}» en este rondín.`);
    throw e;
  }
  const r = await recalcularRondin(env, turnoId, slot, ctx, { ahora });
  const sig = r.requeridos.find((x) => x.puntoId === r.siguientePuntoId);
  return { status: 201, body: { ok: true, tsMs: ahora, punto: punto.nombre, hechos: r.hechos, total: r.total, estado: r.estado, completo: r.estado === "completo", siguiente: sig ? sig.nombre : null } };
}

// ------------------------------------------------------------------ admin / supervisor
async function rondinAutorizado(env, actor, rondinId) {
  if (!/^[A-Za-z0-9_-]{1,120}_\d{1,3}$/.test(rondinId)) throw bad("Rondín inválido.");
  const r = await getDocument(env, `rondines/${rondinId}`);
  if (!r) throw new HttpError(404, "not_found");
  if (actor.rol === "supervisor") {
    const sitio = await getDocument(env, `sitios/${r.sitioId}`);
    if (!sitio || sitio.supervisorUid !== actor.uid) throw new HttpError(403, "forbidden");
  }
  return r;
}

// Foto de un punto: SOLO admin o el supervisor actual del sitio (mismas reglas que las selfies).
export async function verFotoRondin(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const id = new URL(request.url).searchParams.get("escaneo") || "";
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw bad("Escaneo inválido.");
  const e = await getDocument(env, `escaneos/${id}`);
  if (!e || !e.fotoKey) throw new HttpError(404, "not_found");
  if (actor.rol === "supervisor") {
    const sitio = await getDocument(env, `sitios/${e.sitioId}`);
    if (!sitio || sitio.supervisorUid !== actor.uid) throw new HttpError(403, "forbidden");
  }
  if (!env.SELFIES) throw new HttpError(503, "almacenamiento_no_disponible");
  const obj = await env.SELFIES.get(e.fotoKey);
  if (!obj) throw new HttpError(404, "not_found");
  return { status: 200, binary: { body: obj.body, contentType: "image/jpeg" } };
}

// Ajuste con motivo: marcar un punto como realizado, o justificar el rondín completo.
export async function ajusteRondin(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  const rondinId = String(b.rondinId || "");
  const r = await rondinAutorizado(env, actor, rondinId);
  if (b.tipo !== "marcar_punto" && b.tipo !== "justificar_rondin") throw bad("Tipo: marcar_punto o justificar_rondin.");
  const motivo = str(b.motivo, "Motivo", 5, 300);
  let puntoId = null;
  if (b.tipo === "marcar_punto") {
    puntoId = vId(b.puntoId, "puntoId");
    const f = r.detalle.find((d) => d.puntoId === puntoId);
    if (!f) throw bad("Ese punto no pertenece al rondín.");
    if (f.hecho) throw new HttpError(409, "ya_escaneado", "Ese punto ya está registrado.");
  }
  const ahora = Date.now();
  const id = `${Date.now().toString(36)}-${randomId(5)}`;
  await commit(env, [
    {
      path: `ajustesRondin/${id}`,
      data: { rondinId, turnoId: r.turnoId, sitioId: r.sitioId, supervisorUid: r.supervisorUid ?? null, guardiaUid: r.guardiaUid, tipo: b.tipo, puntoId, horaMs: ahora, motivo, autorUid: actor.uid, autorNombre: actor.perfil.nombre, tsMs: ahora, ...(r.prueba === true ? { prueba: true } : {}) },
      mustNotExist: true, serverTimeField: "ts",
    },
    auditoria(actor, `rondin.ajuste_${b.tipo}`, rondinId, { puntoId, motivo }, r),
  ]);
  const ctx = await contextoTurno(env, r.turnoId);
  const slot = ctx?.slots.find((s) => s.indice === r.indice);
  const nuevo = slot ? await recalcularRondin(env, r.turnoId, slot, ctx, { ahora }) : null;
  return { status: 201, body: { ok: true, estado: nuevo?.estado } };
}

export async function recalcularRondines(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request);
  if (!RE_FECHA.test(b.desde || "") || !RE_FECHA.test(b.hasta || "")) throw bad("Fechas AAAA-MM-DD.");
  const d0 = localAMs(b.desde, "00:00"), d1 = localAMs(b.hasta, "00:00") + DIA;
  if (d1 <= d0 || d1 - d0 > 8 * DIA) throw bad("Rango máximo: 8 días.");
  const n = await recalcularRondinesVentana(env, d0, d1, { sitioId: b.sitioId ? vId(b.sitioId, "sitioId") : undefined, supervisorUid: actor.rol === "supervisor" ? actor.uid : undefined, soloActivos: true });
  return { status: 200, body: { ok: true, rondines: n } };
}

export async function reporteRondines(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const p = new URL(request.url).searchParams;
  const desde = p.get("desde") || "", hasta = p.get("hasta") || "";
  if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) throw bad("Fechas AAAA-MM-DD.");
  const d0 = localAMs(desde, "00:00"), d1 = localAMs(hasta, "00:00") + DIA;
  if (d1 <= d0 || d1 - d0 > 31 * DIA) throw bad("Rango máximo: 31 días.");
  const sitioId = p.get("sitioId") ? vId(p.get("sitioId"), "sitioId") : null;
  const ahora = Date.now();
  const sup = actor.rol === "supervisor" ? actor.uid : undefined;
  // Refresca lo vigente; los rondines ya cerrados los dejó calculados el cron.
  await recalcularRondinesVentana(env, d0 - DIA, Math.min(d1, ahora + 3600e3), { ahora, sitioId: sitioId || undefined, supervisorUid: sup, soloActivos: d1 - d0 > 2 * DIA });
  const filas = (await runQuery(env, "rondines", [
    { campo: "programadoMs", op: "GREATER_THAN_OR_EQUAL", valor: d0 }, { campo: "programadoMs", op: "LESS_THAN", valor: d1 },
  ], { limite: 3000 })).filter((r) => (!sitioId || r.sitioId === sitioId) && (actor.rol === "admin" || r.supervisorUid === actor.uid))
    .sort((a, b) => a.programadoMs - b.programadoMs);

  const grupos = new Map();
  for (const r of filas) { const k = `${r.sitioId}|${r.fecha}`; grupos.set(k, [...(grupos.get(k) || []), r]); }
  const porSitioDia = [...grupos.entries()].map(([k, rs]) => ({ sitioId: rs[0].sitioId, sitioNombre: rs[0].sitioNombre, fecha: rs[0].fecha, ...cumplimiento(rs) }));
  return { status: 200, body: { desde, hasta, filas, porSitioDia, total: cumplimiento(filas), generadoMs: ahora } };
}
