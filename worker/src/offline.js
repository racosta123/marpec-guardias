// Registros capturados SIN INTERNET (Fase 6). El celular los guarda en una cola local y los envía al volver la
// señal con `sync: { clientId, offline: true, horaDispositivoMs, horaEstimadaMs }`.
//   · El servidor valida TODO igual que en línea (QR firmado, turno, GPS, fotos, esquema estricto).
//   · La hora del evento = hora estimada por el celular (última sincronización + tiempo transcurrido), acotada:
//     nunca en el futuro, no más vieja que `offlineMaxHoras` y dentro del turno. Se guardan SIEMPRE las tres:
//     hora del dispositivo, hora estimada y hora de recepción del servidor.
//   · Idempotencia: registrosOffline/{sha256(uid:clientId)} se crea en el MISMO commit que el registro; reenviar
//     el mismo clientId responde «duplicado» sin volver a escribir.
//   · Cada registro lleva sin_conexion=true y aparece al supervisor para aceptarlo o ajustarlo con motivo.
import { bad } from "./common.js";
import { HttpError, commit, getDocument } from "./google.js";

const MIN = 60000;
const H = 3600000;
export const RE_CLIENTE = /^[A-Za-z0-9_-]{16,64}$/;

// Se lanza cuando el registro ya fue recibido antes: el handler de rutas lo traduce a 200 {duplicado:true}.
export class Duplicado extends Error {
  constructor(registro) { super("duplicado"); this.registro = registro; }
}

async function hashRegistro(uid, clientId) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${uid}:${clientId}`));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const registroIdDe = hashRegistro;

const entero = (v, campo) => {
  if (!Number.isSafeInteger(v) || v < 1.5e12 || v > 4.5e12) throw bad(`${campo}: marca de tiempo inválida.`);
  return v;
};

// Interpreta `b.sync`. Sin `sync` el registro es normal (hora del servidor, sin idempotencia).
// `config.offlineMaxHoras` limita la antigüedad. Devuelve el «tiempo» del registro:
//   ahora       hora del EVENTO (la que se guarda como tsMs / creadoMs / entradaMs…)
//   recibidoMs  hora real de recepción en el servidor
export async function leerTiempo(env, actor, b, config) {
  const recibidoMs = Date.now();
  const s = b.sync;
  if (s === undefined) return { ahora: recibidoMs, recibidoMs, sin_conexion: false, registroId: null };
  if (s === null || typeof s !== "object" || Array.isArray(s)) throw bad("sync: objeto inválido.");
  for (const k of Object.keys(s)) if (!["clientId", "offline", "horaDispositivoMs", "horaEstimadaMs"].includes(k)) throw bad(`sync: campo no permitido (${String(k).slice(0, 20)}).`);
  if (typeof s.clientId !== "string" || !RE_CLIENTE.test(s.clientId)) throw bad("sync.clientId: identificador inválido.");
  const registroId = await hashRegistro(actor.uid, s.clientId);
  const previo = await getDocument(env, `registrosOffline/${registroId}`);
  if (previo) throw new Duplicado(previo);

  if (s.offline !== true) {
    // Envío en línea con clave de idempotencia (por si la respuesta se pierde y el celular reintenta).
    return { ahora: recibidoMs, recibidoMs, sin_conexion: false, registroId, clientId: s.clientId, horaDispositivoMs: Number.isFinite(b.horaDispositivoMs) ? Math.round(b.horaDispositivoMs) : null };
  }
  const horaDispositivoMs = entero(s.horaDispositivoMs, "Hora del dispositivo");
  const horaEstimadaMs = entero(s.horaEstimadaMs, "Hora estimada");
  const maxMs = (config?.offlineMaxHoras ?? 12) * H;
  if (horaEstimadaMs > recibidoMs + 2 * MIN) throw new HttpError(400, "hora_futura", "La hora del registro está en el futuro. Revisa la fecha y hora de tu celular.");
  if (recibidoMs - horaEstimadaMs > maxMs) throw new HttpError(409, "registro_muy_antiguo", `El registro tiene más de ${config?.offlineMaxHoras ?? 12} horas sin enviarse y ya no se acepta. Avisa a tu supervisor.`);
  return { ahora: Math.min(horaEstimadaMs, recibidoMs), recibidoMs, sin_conexion: true, registroId, clientId: s.clientId, horaDispositivoMs, horaEstimadaMs };
}

// La hora estimada debe caer dentro del turno (con la ventana de entrada antes y el tope de antigüedad después).
export function dentroDelTurno(t, turno, config) {
  if (!t.sin_conexion) return;
  const desde = turno.inicioMs - (config?.ventanaEntradaMin ?? 30) * MIN;
  const hasta = turno.finMs + (config?.offlineMaxHoras ?? 12) * H;
  if (t.ahora < desde || t.ahora > hasta) throw new HttpError(409, "fuera_de_turno", "La hora del registro queda fuera de tu turno.");
}

// Campos que se agregan al registro original cuando vino sin conexión.
export const camposOffline = (t) => (t.sin_conexion ? { sin_conexion: true, recibidoMs: t.recibidoMs, horaEstimadaMs: t.horaEstimadaMs, horaDispositivoMs: t.horaDispositivoMs } : {});

// Escrituras de idempotencia + vista para el supervisor, para el MISMO commit que el registro.
//   info: { tipo, titulo, refPath, sitioId, sitioNombre, supervisorUid, guardiaUid, guardiaNombre, prueba }
export function escriturasRegistro(t, info) {
  if (!t.registroId) return [];
  const base = {
    clientId: t.clientId, guardiaUid: info.guardiaUid, tipo: info.tipo, refPath: info.refPath, sitioId: info.sitioId,
    tsMs: t.ahora, recibidoMs: t.recibidoMs, sin_conexion: t.sin_conexion, horaDispositivoMs: t.horaDispositivoMs ?? null, horaEstimadaMs: t.horaEstimadaMs ?? null,
    ...(info.prueba === true ? { prueba: true } : {}),
  };
  const w = [{ path: `registrosOffline/${t.registroId}`, data: base, mustNotExist: true, serverTimeField: "ts" }];
  if (t.sin_conexion) {
    w.push({
      path: `offlineVista/${t.registroId}`,
      data: {
        registroId: t.registroId, tipo: info.tipo, titulo: info.titulo, refPath: info.refPath, sitioId: info.sitioId, sitioNombre: info.sitioNombre || "", supervisorUid: info.supervisorUid ?? null,
        guardiaUid: info.guardiaUid, guardiaNombre: info.guardiaNombre || "", tsMs: t.ahora, recibidoMs: t.recibidoMs, horaDispositivoMs: t.horaDispositivoMs, horaEstimadaMs: t.horaEstimadaMs,
        estadoRevision: "pendiente", revisionAccion: null, revisionMotivo: null, revisionPorNombre: null, revisionMs: null, horaAjustadaMs: null,
        ...(info.prueba === true ? { prueba: true } : {}),
      },
      serverTimeField: "actualizadoEn",
    });
  }
  return w;
}

// Si un commit falló con 409 porque OTRA petición idéntica ganó la carrera, es un duplicado (no un conflicto).
export async function siEsDuplicado(env, e, t) {
  if (e?.status === 409 && t?.registroId) {
    const previo = await getDocument(env, `registrosOffline/${t.registroId}`);
    if (previo) throw new Duplicado(previo);
  }
}
