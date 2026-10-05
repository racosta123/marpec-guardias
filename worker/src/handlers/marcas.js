// Marcas de entrada y salida (guardia). Tres verificaciones obligatorias: GPS, QR y selfie en vivo.
// La hora la pone SIEMPRE el servidor. Las marcas son inmutables (solo se crean).
import { authenticate, bad, id as vId, num, randomId, readJson, requireRol, str } from "../common.js";
import { b64uToBytes } from "../crypto.js";
import { distanciaM } from "../geo.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { verificarFirma } from "../qr.js";
import { buscarPredecesor, buscarSucesor, cargarConfig, recalcularTurno } from "./asistenciaSvc.js";
import { MIN } from "../asistencia.js";
import { camposOffline, dentroDelTurno, escriturasRegistro, leerTiempo, siEsDuplicado } from "../offline.js";

export const FOTO_MAX_BYTES = 150 * 1024; // el cliente comprime a ~100 KB
export const FOTO_MIN_BYTES = 1024;
const BODY_MAX = 230 * 1024; // base64 de 150 KB + campos

// Decodifica y valida la selfie: JPEG real (cabecera FFD8FF y cierre FFD9), tamaño acotado.
export function validarFoto(b64) {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw new HttpError(400, "foto_invalida", "La foto no es válida.");
  let bytes;
  try {
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new HttpError(400, "foto_invalida", "La foto no es válida.");
  }
  if (bytes.length < FOTO_MIN_BYTES || bytes.length > FOTO_MAX_BYTES) throw new HttpError(400, "foto_invalida", "La foto debe ser una selfie comprimida de hasta 150 KB.");
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (!jpeg) throw new HttpError(400, "foto_invalida", "La foto debe ser un JPEG tomado con la cámara.");
  return bytes;
}

async function marcar(env, request, tipo) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const b = await readJson(request, BODY_MAX);
  const turnoId = vId(b.turnoId, "turnoId");
  const config = await cargarConfig(env);
  // HORA DEL SERVIDOR. Solo un registro sin conexión usa la hora estimada del celular (acotada y dentro del turno).
  const t = await leerTiempo(env, actor, b, config);
  const ahora = t.ahora;
  const noPermitido = () => new HttpError(403, "forbidden", "Este turno no es tuyo.");

  const turno = await getDocument(env, `turnos/${turnoId}`);
  if (!turno || turno.guardiaUid !== actor.uid) throw noPermitido(); // ajeno o inexistente: misma respuesta
  if (turno.estado !== "programado") throw new HttpError(409, "sin_turno_activo", "Este turno ya no está activo.");
  const sitio = await getDocument(env, `sitios/${turno.sitioId}`);
  if (!sitio || sitio.activo === false) throw new HttpError(409, "sin_turno_activo", "El sitio no está activo.");

  dentroDelTurno(t, turno, config);
  const previaEntrada = await getDocument(env, `marcas/${turnoId}_entrada`);
  if (tipo === "entrada") {
    if (previaEntrada) throw new HttpError(409, "ya_marcada", "Ya registraste tu entrada en este turno.");
    if (ahora < turno.inicioMs - config.ventanaEntradaMin * MIN) throw new HttpError(409, "fuera_ventana", `Aún no puedes marcar entrada: se habilita ${config.ventanaEntradaMin} min antes del inicio.`);
    if (ahora >= turno.finMs) throw new HttpError(409, "sin_turno_activo", "El turno ya terminó.");
  } else {
    if (!previaEntrada) throw new HttpError(409, "sin_entrada", "Primero debes marcar tu entrada.");
    if (await getDocument(env, `marcas/${turnoId}_salida`)) throw new HttpError(409, "ya_marcada", "Ya registraste tu salida en este turno.");
    if (t.sin_conexion && ahora < previaEntrada.tsMs) throw new HttpError(409, "fuera_de_turno", "La hora de la salida es anterior a tu entrada.");
  }

  // ---- (a) GPS: dentro del perímetro y con precisión aceptable ----
  if (typeof sitio.lat !== "number" || typeof sitio.lng !== "number") throw new HttpError(409, "sitio_sin_ubicacion", "El sitio aún no tiene ubicación configurada. Avisa a tu supervisor.");
  const lat = num(b.lat, "Latitud", -90, 90);
  const lng = num(b.lng, "Longitud", -180, 180);
  const precisionM = num(b.precisionM, "Precisión", 0, 100000);
  if (precisionM > sitio.radioM) throw new HttpError(400, "gps_precision", `La precisión del GPS (±${Math.round(precisionM)} m) es peor que el radio del sitio (${sitio.radioM} m). Sal a cielo abierto e inténtalo de nuevo.`);
  const dist = distanciaM(lat, lng, sitio.lat, sitio.lng);
  if (dist > sitio.radioM) throw new HttpError(403, "fuera_perimetro", `Estás fuera del perímetro del sitio (a ${Math.round(dist)} m; el límite es ${sitio.radioM} m).`);

  // ---- (b) QR vigente y de este sitio ----
  const qrInvalido = () => new HttpError(400, "qr_invalido", "El código QR no es válido para este puesto.");
  const q = await verificarFirma(env, b.qr);
  if (!q || q.sitioId !== turno.sitioId || q.version !== (sitio.qrVersion || 1)) throw qrInvalido();

  // ---- (c) selfie: JPEG acotado (el cliente la toma con la cámara en vivo, sin galería) ----
  const foto = validarFoto(b.foto);
  if (!env.SELFIES) throw new HttpError(503, "almacenamiento_no_disponible", "El almacenamiento de fotos no está disponible. Intenta más tarde.");

  // ---- reglas de salida: relevo ----
  let notas = "";
  if (tipo === "salida") {
    notas = str(b.notasEntrega, "Notas de entrega", 0, 1000, { opcional: true });
    const sucesor = await buscarSucesor(env, turno, turnoId);
    if (sucesor.existe && sucesor.entradaMs == null) {
      const cierre = await getDocument(env, `autorizaciones/${turnoId}_cierre`);
      if (!cierre) throw new HttpError(409, "relevo_pendiente", "No puedes cerrar tu turno hasta que tu relevo marque entrada. Si no llegará, pide a tu supervisor que autorice el cierre.");
    }
  }

  const marcaId = `${turnoId}_${tipo}`;
  const fotoKey = `selfies/${turno.sitioId}/${turnoId}/${tipo}-${randomId(6)}.jpg`;
  await env.SELFIES.put(fotoKey, foto, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { turnoId, tipo, guardiaUid: actor.uid } });
  const horaDispositivoMs = Number.isFinite(b.horaDispositivoMs) ? Math.round(b.horaDispositivoMs) : null;
  try {
    await commit(env, [{
      path: `marcas/${marcaId}`,
      data: {
        turnoId, sitioId: turno.sitioId, guardiaUid: actor.uid, tipo, tsMs: ahora,
        lat, lng, precisionM, distanciaM: Math.round(dist * 10) / 10, radioM: sitio.radioM, qrVersion: q.version,
        fotoKey, fotoBytes: foto.length, horaDispositivoMs, desfaseDispositivoMs: horaDispositivoMs === null ? null : horaDispositivoMs - ahora,
        ...(tipo === "salida" ? { notasEntrega: notas } : {}),
        ...(turno.prueba === true ? { prueba: true } : {}),
        ...camposOffline(t),
      },
      mustNotExist: true, // una sola marca por tipo y turno; inmutable
      serverTimeField: "ts",
    }, ...escriturasRegistro(t, { tipo, titulo: tipo === "entrada" ? "Entrada al turno" : "Salida del turno", refPath: `marcas/${marcaId}`, sitioId: turno.sitioId, sitioNombre: sitio.nombre, supervisorUid: sitio.supervisorUid ?? null, guardiaUid: actor.uid, guardiaNombre: actor.perfil.nombre, prueba: turno.prueba === true })]);
  } catch (e) {
    await env.SELFIES.delete(fotoKey).catch(() => {}); // sin marca no se conserva la foto
    await siEsDuplicado(env, e, t);
    if (e.status === 409) throw new HttpError(409, "ya_marcada", `Ya registraste tu ${tipo} en este turno.`);
    throw e;
  }
  const r = await recalcularTurno(env, turnoId, { ahora: t.recibidoMs, config });
  if (tipo === "entrada") {
    // El relevo llegó: el saliente debe ver de inmediato que ya puede cerrar (y se apaga la alerta).
    const prev = await buscarPredecesor(env, turno, turnoId);
    if (prev) await recalcularTurno(env, prev.id, { ahora: t.recibidoMs, config });
  }
  return { status: 201, body: { ok: true, tsMs: ahora, sin_conexion: t.sin_conexion, estado: r?.estado, retardo: r?.retardo ?? false, retardoMin: r?.retardoMin ?? 0, minutosExtra: r?.minutosExtra ?? 0 } };
}

export const marcarEntrada = (env, request) => marcar(env, request, "entrada");
export const marcarSalida = (env, request) => marcar(env, request, "salida");

// Notas de entrega del turno anterior (solo para el guardia entrante de ese relevo).
export async function notasRelevo(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "guardia");
  const turnoId = vId(new URL(request.url).searchParams.get("turnoId"), "turnoId");
  const mio = await getDocument(env, `turnos/${turnoId}`);
  if (!mio || mio.guardiaUid !== actor.uid) throw new HttpError(403, "forbidden");
  const prev = await buscarPredecesor(env, mio, turnoId);
  if (!prev) return { status: 200, body: { hay: false } };
  const salida = await getDocument(env, `marcas/${prev.id}_salida`);
  const guardia = await getDocument(env, `usuarios/${prev.guardiaUid}`);
  return { status: 200, body: { hay: true, de: guardia?.nombre || "Guardia saliente", cerrado: Boolean(salida), notas: salida?.notasEntrega || "", turnoId: prev.id } };
}

// Selfie: SOLO admin o el supervisor actual de ese sitio, con token válido. El bucket es privado.
export async function verSelfie(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const marcaId = new URL(request.url).searchParams.get("marca") || "";
  if (!/^[A-Za-z0-9_-]{1,100}_(entrada|salida)$/.test(marcaId)) throw bad("Marca inválida.");
  const marca = await getDocument(env, `marcas/${marcaId}`);
  if (!marca || !marca.fotoKey) throw new HttpError(404, "not_found");
  if (actor.rol === "supervisor") {
    const sitio = await getDocument(env, `sitios/${marca.sitioId}`);
    if (!sitio || sitio.supervisorUid !== actor.uid) throw new HttpError(403, "forbidden");
  }
  if (!env.SELFIES) throw new HttpError(503, "almacenamiento_no_disponible");
  const obj = await env.SELFIES.get(marca.fotoKey);
  if (!obj) throw new HttpError(404, "not_found");
  return { status: 200, binary: { body: obj.body, contentType: "image/jpeg" } };
}
