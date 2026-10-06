// MARPEC Guardias — proxy seguro (Cloudflare Worker).
// Única vía de escritura y de asignación de roles. Sin dependencias.
import { hashPin, safeEqual, PBKDF2_ITERATIONS } from "./crypto.js";
import {
  authenticate, readJson, RE_EMAIL, RE_NUMERO, RE_PIN, str,
} from "./common.js";
import {
  HttpError, commit, createAuthUser, deleteAuthUser, deleteDocument, getDocument, mintCustomToken,
} from "./google.js";
import { limiter, RateLimiter } from "./ratelimit.js";
import {
  actualizarUsuario, bajaUsuario, crearUsuario, desbloquearPin, reactivarUsuario, restablecerPin,
} from "./handlers/personal.js";
import { actualizarSitio, crearSitio, obtenerQr, regenerarQr, verificarQr } from "./handlers/sitios.js";
import { asignarLote, asignarTurno, cancelarTurno } from "./handlers/turnos.js";
import { guardarConfig } from "./handlers/empresa.js";
import { marcarEntrada, marcarSalida, notasRelevo, verSelfie } from "./handlers/marcas.js";
import { autorizarCierre, crearAjuste, recalcular, reporte, resolverExtra } from "./handlers/asistenciaAdmin.js";
import { recalcularVentana } from "./handlers/asistenciaSvc.js";
import { actualizarPunto, crearPunto, guardarPrograma, obtenerQrPunto, obtenerQrSitioPuntos, regenerarQrPunto } from "./handlers/puntos.js";
import { ajusteRondin, escanearPunto, proximoRondin, recalcularRondines, reporteRondines, verFotoRondin } from "./handlers/rondines.js";
import { recalcularRondinesVentana } from "./handlers/rondinesSvc.js";
import { catalogoIncidencias, crearIncidencia, fotoIncidencia, guardarCatalogo, seguimientoIncidencia } from "./handlers/incidencias.js";
import { entradaVisitante, fotoVisitante, purgarVisitantes, salidaVisitante, visitantesDentro } from "./handlers/visitantes.js";
import { bitacoraAnterior, bitacoraTurno, crearNovedad } from "./handlers/bitacora.js";
import { atenderPanico, crearPanico } from "./handlers/panico.js";
import { bajaPush, claveVapid, estadoPush, guardarPrefsPush, suscribirPush } from "./handlers/notificaciones.js";
import { revisarOffline } from "./handlers/offlineRev.js";
import { Duplicado } from "./offline.js";
import { avisarVencimiento, estadoPublico, exigirLicencia, leerLicencia, vencida } from "./licencia.js";

export { RateLimiter };

const MIN15 = 15 * 60 * 1000;
const EMP_LIMIT = { max: 5, windowMs: MIN15, lockMs: MIN15 };
const IP_LIMIT = { max: 20, windowMs: MIN15, lockMs: MIN15 };
const SETUP_LIMIT = { max: 5, windowMs: MIN15, lockMs: 60 * MIN15 };

const GENERIC_LOGIN_ERROR = "Número de empleado o PIN incorrectos, o acceso bloqueado temporalmente.";

// Hash ficticio para igualar tiempos cuando el número de empleado no existe.
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA";

const SECURITY_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), camera=(), microphone=()",
};

// ALLOWED_ORIGIN admite varios orígenes EXACTOS separados por coma (p. ej. GitHub Pages y Netlify). Nada de comodines.
const origenPermitido = (env, origin) => !!origin && String(env.ALLOWED_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean).includes(origin);

function corsHeaders(env, origin) {
  if (origenPermitido(env, origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-setup-token",
      "access-control-max-age": "600",
      "access-control-expose-headers": "x-server-time",
      vary: "Origin",
    };
  }
  return { vary: "Origin" };
}

function respond(env, request, status, body, extra = {}) {
  const origin = request.headers.get("origin");
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...corsHeaders(env, origin), "x-server-time": String(Date.now()), ...extra },
  });
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

// ---- Handlers -------------------------------------------------------------
async function loginGuardia(env, request) {
  const ip = clientIp(request);
  const body = await readJson(request);
  const numero = typeof body.numero === "string" ? body.numero.trim().toUpperCase() : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  const fail = () => new HttpError(401, "invalid_credentials", GENERIC_LOGIN_ERROR);

  if (!RE_NUMERO.test(numero) || !RE_PIN.test(pin)) {
    await limiter(env, `ip:${ip}`, "fail", IP_LIMIT);
    throw fail();
  }

  const [ipState, empState] = await Promise.all([
    limiter(env, `ip:${ip}`, "check", IP_LIMIT),
    limiter(env, `emp:${numero}`, "check", EMP_LIMIT),
  ]);
  if (ipState.locked || empState.locked) throw fail();

  const cred = await getDocument(env, `credenciales/${numero}`);
  const salt = cred?.salt || DUMMY_SALT;
  const iterations = cred?.iterations || PBKDF2_ITERATIONS;
  const calculado = await hashPin(pin, salt, env.PIN_PEPPER, iterations);
  const ok = Boolean(cred) && cred.activo === true && safeEqual(calculado, cred.hash);

  if (!ok) {
    await Promise.all([
      limiter(env, `emp:${numero}`, "fail", EMP_LIMIT),
      limiter(env, `ip:${ip}`, "fail", IP_LIMIT),
    ]);
    throw fail();
  }

  const perfil = await getDocument(env, `usuarios/${cred.uid}`);
  if (!perfil || perfil.activo !== true || perfil.rol !== "guardia") throw fail();

  await limiter(env, `emp:${numero}`, "reset", EMP_LIMIT);
  const token = await mintCustomToken(env, cred.uid, { rol: "guardia" });
  return { status: 200, body: { token } };
}

async function me(env, request) {
  const u = await authenticate(env, request);
  return {
    status: 200,
    body: { uid: u.uid, rol: u.rol, nombre: u.perfil.nombre, numeroEmpleado: u.perfil.numeroEmpleado ?? null },
  };
}

// Primer admin: un solo uso. El flag ajustes/sistema se reclama de forma atómica
// (create con precondición "no existe"); después el endpoint responde 404 para siempre.
async function primerAdmin(env, request) {
  const ip = clientIp(request);
  const st = await limiter(env, `setup:${ip}`, "check", SETUP_LIMIT);
  const notFound = () => new HttpError(404, "not_found");
  if (st.locked) throw notFound();

  const supplied = request.headers.get("x-setup-token") || "";
  if (!env.SETUP_TOKEN || !safeEqual(supplied, env.SETUP_TOKEN.trim())) {
    await limiter(env, `setup:${ip}`, "fail", SETUP_LIMIT);
    throw notFound();
  }
  if (await getDocument(env, "ajustes/sistema")) throw notFound();

  const body = await readJson(request);
  const nombre = str(body.nombre, "Nombre", 2, 80);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!nombre || !RE_EMAIL.test(email) || typeof body.password !== "string" || body.password.length < 10 || body.password.length > 128)
    throw new HttpError(400, "bad_request", "Datos inválidos (contraseña mínima de 10 caracteres).");

  try {
    await commit(env, [
      { path: "ajustes/sistema", data: { adminCreado: true }, mustNotExist: true, serverTimeField: "creadoEn" },
    ]);
  } catch (e) {
    if (e.status === 409) throw notFound();
    throw e;
  }

  let uid;
  try {
    uid = await createAuthUser(env, { email, password: body.password, displayName: nombre, claims: { rol: "admin" } });
    await commit(env, [
      {
        path: `usuarios/${uid}`,
        data: { nombre, rol: "admin", activo: true, email },
        mustNotExist: true,
        serverTimeField: "creadoEn",
      },
    ]);
  } catch (e) {
    // Revertir para poder reintentar; el candado se reabre solo si falló la creación.
    if (uid) await deleteAuthUser(env, uid).catch(() => {});
    await deleteDocument(env, "ajustes/sistema").catch(() => {});
    throw e;
  }
  return { status: 201, body: { ok: true, uid } };
}

const RUTA_LICENCIA = "GET /licencia/estado"; // única ruta que responde con la licencia vencida

const ROUTES = {
  [RUTA_LICENCIA]: estadoPublico,
  "POST /auth/guardia": loginGuardia,
  "GET /me": me,
  "POST /setup/primer-admin": primerAdmin,
  // Personal (admin)
  "POST /admin/usuarios": crearUsuario,
  "POST /admin/usuarios/actualizar": actualizarUsuario,
  "POST /admin/usuarios/baja": bajaUsuario,
  "POST /admin/usuarios/reactivar": reactivarUsuario,
  "POST /admin/usuarios/restablecer-pin": restablecerPin,
  "POST /admin/usuarios/desbloquear-pin": desbloquearPin,
  // Sitios y QR
  "POST /admin/sitios": crearSitio,
  "POST /admin/sitios/actualizar": actualizarSitio,
  "POST /admin/sitios/regenerar-qr": regenerarQr,
  "GET /sitios/qr": obtenerQr,
  "POST /qr/verificar": verificarQr,
  // Turnos (admin o supervisor del sitio)
  "POST /turnos/asignar-lote": asignarLote,
  "POST /turnos/asignar": asignarTurno,
  "POST /turnos/cancelar": cancelarTurno,
  // Empresa (admin)
  "POST /admin/config": guardarConfig,
  // Fase 3: marcas, relevo y asistencia
  "POST /marcas/entrada": marcarEntrada,
  "POST /marcas/salida": marcarSalida,
  "GET /relevo/notas": notasRelevo,
  "GET /selfies": verSelfie,
  "POST /relevo/autorizar-cierre": autorizarCierre,
  "POST /ajustes": crearAjuste,
  "POST /extras/resolver": resolverExtra,
  "POST /asistencia/recalcular": recalcular,
  "GET /reportes/asistencia": reporte,
  // Fase 4: rondines
  "POST /admin/puntos": crearPunto,
  "POST /admin/puntos/actualizar": actualizarPunto,
  "POST /admin/puntos/regenerar-qr": regenerarQrPunto,
  "GET /puntos/qr": obtenerQrPunto,
  "GET /puntos/qr-sitio": obtenerQrSitioPuntos,
  "POST /rondines/programa": guardarPrograma,
  "GET /rondines/proximo": proximoRondin,
  "POST /rondines/escanear": escanearPunto,
  "GET /rondines/foto": verFotoRondin,
  "POST /rondines/ajuste": ajusteRondin,
  "POST /rondines/recalcular": recalcularRondines,
  "GET /reportes/rondines": reporteRondines,
  // Fase 5: incidencias, visitantes y bitácora
  "GET /catalogo/incidencias": catalogoIncidencias,
  "POST /admin/catalogo-incidencias": guardarCatalogo,
  "POST /incidencias": crearIncidencia,
  "POST /incidencias/seguimiento": seguimientoIncidencia,
  "GET /incidencias/foto": fotoIncidencia,
  "POST /visitantes/entrada": entradaVisitante,
  "POST /visitantes/salida": salidaVisitante,
  "GET /visitantes/dentro": visitantesDentro,
  "GET /visitantes/foto": fotoVisitante,
  "POST /novedades": crearNovedad,
  "GET /bitacora/turno": bitacoraTurno,
  "GET /bitacora/anterior": bitacoraAnterior,
  // Fase 6: pánico, sin conexión y notificaciones push
  "POST /panico": crearPanico,
  "POST /panico/atender": atenderPanico,
  "POST /offline/revisar": revisarOffline,
  "GET /push/clave": claveVapid,
  "POST /push/suscribir": suscribirPush,
  "POST /push/estado": estadoPush,
  "POST /push/prefs": guardarPrefsPush,
  "POST /push/baja": bajaPush,
};

export default {
  // Cron: refresca asistencia de turnos recientes (alertas de relevo y extras en curso).
  async scheduled(_event, env, ctx) {
    const ahora = Date.now();
    // Licencia de demostración: vencida (o ausente) el cron no genera alertas ni notificaciones sobre datos del cliente.
    const lic = await leerLicencia(env, ahora).catch((e) => { console.error("cron licencia", e?.message); return undefined; });
    // La retención de visitantes (privacidad) sigue corriendo siempre: no genera alertas.
    ctx.waitUntil(purgarVisitantes(env, ahora).catch((e) => console.error("cron retención", e?.message)));
    if (lic === undefined || vencida(lic, ahora)) return;
    ctx.waitUntil(avisarVencimiento(env, lic, ahora).catch((e) => console.error("cron aviso licencia", e?.message)));
    ctx.waitUntil(recalcularVentana(env, ahora - 40 * 3600e3, ahora + 3600e3, { omitirCerrados: true, ahora }).catch((e) => console.error("cron", e?.message)));
    ctx.waitUntil(recalcularRondinesVentana(env, ahora - 40 * 3600e3, ahora + 3600e3, { ahora, soloActivos: true }).catch((e) => console.error("cron rondines", e?.message)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      if (!origenPermitido(env, origin)) return respond(env, request, 403, null);
      return respond(env, request, 204, null);
    }
    // Navegadores: cualquier otro origen queda fuera aunque tenga credenciales válidas.
    if (origin && !origenPermitido(env, origin))
      return respond(env, request, 403, { error: "forbidden" });

    const handler = ROUTES[`${request.method} ${url.pathname}`];
    if (!handler) return respond(env, request, 404, { error: "not_found" });

    try {
      if (`${request.method} ${url.pathname}` !== RUTA_LICENCIA) await exigirLicencia(env); // demo vencido: 403 "demo_vencido"
      const r = await handler(env, request);
      if (r.binary) {
        return new Response(r.binary.body, { status: r.status, headers: { ...SECURITY_HEADERS, ...corsHeaders(env, request.headers.get("origin")), "content-type": r.binary.contentType, "cache-control": "private, no-store" } });
      }
      return respond(env, request, r.status, r.body);
    } catch (e) {
      // Registro ya recibido antes (reintento del celular): no se escribe de nuevo y se responde que está guardado.
      if (e instanceof Duplicado) return respond(env, request, 200, { ok: true, duplicado: true });
      if (e instanceof HttpError) {
        return respond(env, request, e.status, { error: e.code, ...(e.detail ? { mensaje: e.detail } : {}) });
      }
      console.error("error interno", e?.message);
      return respond(env, request, 500, { error: "internal" });
    }
  },
};
