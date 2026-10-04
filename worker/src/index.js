// MARPEC Guardias — proxy seguro (Cloudflare Worker).
// Única vía de escritura y de asignación de roles. Sin dependencias.
import { hashPin, randomSalt, safeEqual, PBKDF2_ITERATIONS } from "./crypto.js";
import {
  HttpError, commit, createAuthUser, deleteAuthUser, deleteDocument, getDocument,
  mintCustomToken, verifyIdToken,
} from "./google.js";
import { limiter, RateLimiter } from "./ratelimit.js";

export { RateLimiter };

const MIN15 = 15 * 60 * 1000;
const EMP_LIMIT = { max: 5, windowMs: MIN15, lockMs: MIN15 };
const IP_LIMIT = { max: 20, windowMs: MIN15, lockMs: MIN15 };
const SETUP_LIMIT = { max: 5, windowMs: MIN15, lockMs: 60 * MIN15 };

const RE_NUMERO = /^[A-Z0-9]{3,12}$/;
const RE_PIN = /^\d{4,6}$/;
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
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

function corsHeaders(env, origin) {
  if (origin && origin === env.ALLOWED_ORIGIN) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-setup-token",
      "access-control-max-age": "600",
      vary: "Origin",
    };
  }
  return { vary: "Origin" };
}

function respond(env, request, status, body, extra = {}) {
  const origin = request.headers.get("origin");
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...corsHeaders(env, origin), ...extra },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 4096) throw new HttpError(413, "too_large");
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, "bad_request");
  }
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

async function authenticate(env, request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(h);
  if (!m) throw new HttpError(401, "unauthorized");
  const claims = await verifyIdToken(env, m[1]);
  if (!["guardia", "supervisor", "admin"].includes(claims.rol)) throw new HttpError(403, "forbidden");
  const perfil = await getDocument(env, `usuarios/${claims.sub}`);
  if (!perfil || perfil.activo !== true || perfil.rol !== claims.rol) throw new HttpError(403, "forbidden");
  return { uid: claims.sub, rol: claims.rol, perfil };
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

function validateNombre(nombre) {
  if (typeof nombre !== "string") return null;
  const n = nombre.trim().replace(/\s+/g, " ");
  return n.length >= 2 && n.length <= 80 ? n : null;
}

function validatePassword(p) {
  return typeof p === "string" && p.length >= 10 && p.length <= 128;
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
  const nombre = validateNombre(body.nombre);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!nombre || !RE_EMAIL.test(email) || !validatePassword(body.password))
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

async function crearUsuario(env, request) {
  const actor = await authenticate(env, request);
  if (actor.rol !== "admin") throw new HttpError(403, "forbidden");
  const body = await readJson(request);
  const nombre = validateNombre(body.nombre);
  if (!nombre) throw new HttpError(400, "bad_request");
  // Los usuarios de prueba se marcan para poder borrarlos antes de entregar.
  const extra = body.prueba === true ? { prueba: true } : {};

  if (body.rol === "guardia") {
    const numero = typeof body.numeroEmpleado === "string" ? body.numeroEmpleado.trim().toUpperCase() : "";
    if (!RE_NUMERO.test(numero) || !RE_PIN.test(body.pin || ""))
      throw new HttpError(400, "bad_request", "Número de empleado (3-12 alfanuméricos) y PIN de 4-6 dígitos.");
    const uid = `g-${numero}`;
    const salt = randomSalt();
    const hash = await hashPin(body.pin, salt, env.PIN_PEPPER);
    await commit(env, [
      {
        path: `credenciales/${numero}`,
        data: { uid, hash, salt, iterations: PBKDF2_ITERATIONS, activo: true, ...extra },
        mustNotExist: true,
        serverTimeField: "creadoEn",
      },
      {
        path: `usuarios/${uid}`,
        data: { nombre, rol: "guardia", numeroEmpleado: numero, activo: true, ...extra },
        mustNotExist: true,
        serverTimeField: "creadoEn",
      },
    ]);
    return { status: 201, body: { ok: true, uid } };
  }

  if (body.rol === "supervisor") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!RE_EMAIL.test(email) || !validatePassword(body.password))
      throw new HttpError(400, "bad_request", "Correo válido y contraseña de al menos 10 caracteres.");
    const uid = await createAuthUser(env, { email, password: body.password, displayName: nombre, claims: { rol: "supervisor" } });
    try {
      await commit(env, [
        { path: `usuarios/${uid}`, data: { nombre, rol: "supervisor", activo: true, email, ...extra }, mustNotExist: true, serverTimeField: "creadoEn" },
      ]);
    } catch (e) {
      await deleteAuthUser(env, uid).catch(() => {});
      throw e;
    }
    return { status: 201, body: { ok: true, uid } };
  }

  throw new HttpError(400, "bad_request", "Rol permitido: guardia o supervisor.");
}

const ROUTES = {
  "POST /auth/guardia": loginGuardia,
  "GET /me": me,
  "POST /setup/primer-admin": primerAdmin,
  "POST /admin/usuarios": crearUsuario,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      if (origin !== env.ALLOWED_ORIGIN) return respond(env, request, 403, null);
      return respond(env, request, 204, null);
    }
    // Navegadores: cualquier otro origen queda fuera aunque tenga credenciales válidas.
    if (origin && origin !== env.ALLOWED_ORIGIN)
      return respond(env, request, 403, { error: "forbidden" });

    const handler = ROUTES[`${request.method} ${url.pathname}`];
    if (!handler) return respond(env, request, 404, { error: "not_found" });

    try {
      const r = await handler(env, request);
      return respond(env, request, r.status, r.body);
    } catch (e) {
      if (e instanceof HttpError) {
        return respond(env, request, e.status, { error: e.code, ...(e.detail ? { mensaje: e.detail } : {}) });
      }
      console.error("error interno", e?.message);
      return respond(env, request, 500, { error: "internal" });
    }
  },
};
