// Gestión de personal (solo admin): alta, edición, baja/reactivación, PIN.
import {
  auditoria, authenticate, bad, email as vEmail, id as vId, numeroEmpleado, pin as vPin,
  readJson, requireRol, str,
} from "../common.js";
import { hashPin, PBKDF2_ITERATIONS, randomSalt } from "../crypto.js";
import {
  HttpError, commit, createAuthUser, deleteAuthUser, getDocument, runQuery, setAuthUserState, updateAuthUser,
} from "../google.js";
import { limiter } from "../ratelimit.js";
import { reasignarSupervisor, recalcularSitiosAsignados } from "./compartido.js";

const MIN15 = 15 * 60 * 1000;
const EMP_LIMIT = { max: 5, windowMs: MIN15, lockMs: MIN15 };

function validatePassword(p) {
  if (typeof p !== "string" || p.length < 10 || p.length > 128) throw bad("Contraseña de 10 a 128 caracteres.");
  return p;
}

async function cargarObjetivo(env, uid, rolesPermitidos = ["guardia", "supervisor"]) {
  const t = await getDocument(env, `usuarios/${vId(uid, "uid")}`);
  if (!t || !rolesPermitidos.includes(t.rol)) throw new HttpError(404, "not_found");
  return t;
}

export async function crearUsuario(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const body = await readJson(request);
  const nombre = str(body.nombre, "Nombre", 2, 80);
  const extra = body.prueba === true ? { prueba: true } : {};

  if (body.rol === "guardia") {
    const numero = numeroEmpleado(body.numeroEmpleado);
    const pin = vPin(body.pin);
    const uid = `g-${numero}`;
    const salt = randomSalt();
    const hash = await hashPin(pin, salt, env.PIN_PEPPER);
    await commit(env, [
      {
        path: `credenciales/${numero}`,
        data: { uid, hash, salt, iterations: PBKDF2_ITERATIONS, activo: true, ...extra },
        mustNotExist: true,
        serverTimeField: "creadoEn",
      },
      {
        path: `usuarios/${uid}`,
        data: { nombre, rol: "guardia", numeroEmpleado: numero, activo: true, sitiosAsignados: [], ...extra },
        mustNotExist: true,
        serverTimeField: "creadoEn",
      },
      auditoria(actor, "personal.alta", uid, { rol: "guardia", nombre, numeroEmpleado: numero }),
    ]);
    return { status: 201, body: { ok: true, uid } };
  }

  if (body.rol === "supervisor") {
    const email = vEmail(body.email);
    const password = validatePassword(body.password);
    const uid = await createAuthUser(env, { email, password, displayName: nombre, claims: { rol: "supervisor" } });
    try {
      await commit(env, [
        { path: `usuarios/${uid}`, data: { nombre, rol: "supervisor", activo: true, email, ...extra }, mustNotExist: true, serverTimeField: "creadoEn" },
        auditoria(actor, "personal.alta", uid, { rol: "supervisor", nombre, email }),
      ]);
    } catch (e) {
      await deleteAuthUser(env, uid).catch(() => {});
      throw e;
    }
    return { status: 201, body: { ok: true, uid } };
  }
  throw bad("Rol permitido: guardia o supervisor.");
}

export async function actualizarUsuario(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const body = await readJson(request);
  const uid = vId(body.uid, "uid");
  const t = await cargarObjetivo(env, uid);
  const cambios = {};
  if (body.nombre !== undefined) cambios.nombre = str(body.nombre, "Nombre", 2, 80);
  if (body.email !== undefined) {
    if (t.rol !== "supervisor") throw bad("Solo los supervisores tienen correo.");
    cambios.email = vEmail(body.email);
  }
  if (!Object.keys(cambios).length) throw bad("Nada que actualizar.");
  if (cambios.email && cambios.email !== t.email) await updateAuthUser(env, uid, { email: cambios.email });
  if (cambios.nombre) await updateAuthUser(env, uid, { displayName: cambios.nombre }).catch((e) => {
    if (t.rol === "supervisor") throw e; // los guardias pueden no existir aún en Auth
  });
  await commit(env, [
    { path: `usuarios/${uid}`, data: cambios, merge: true, mustExist: true },
    auditoria(actor, "personal.editar", uid, cambios),
  ]);
  return { status: 200, body: { ok: true } };
}

// Baja inmediata: (1) perfil inactivo → las reglas y el Worker cortan el acceso al instante,
// (2) cuenta inhabilitada y (3) refresh tokens revocados.
export async function bajaUsuario(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const body = await readJson(request);
  const uid = vId(body.uid, "uid");
  const t = await cargarObjetivo(env, uid);

  const writes = [
    { path: `usuarios/${uid}`, data: { activo: false }, merge: true, mustExist: true, serverTimeField: "bajaEn" },
    auditoria(actor, "personal.baja", uid, { rol: t.rol, nombre: t.nombre }),
  ];
  if (t.rol === "guardia") {
    writes.push({ path: `credenciales/${t.numeroEmpleado}`, data: { activo: false }, merge: true });
  }
  await commit(env, writes);
  const auth = await setAuthUserState(env, uid, { disabled: true });

  if (t.rol === "guardia") {
    const ahora = Date.now();
    const turnos = await runQuery(env, "turnos", [{ campo: "guardiaUid", op: "EQUAL", valor: uid }]);
    const futuros = turnos.filter((x) => x.estado === "programado" && x.inicioMs > ahora);
    for (let i = 0; i < futuros.length; i += 400)
      await commit(env, futuros.slice(i, i + 400).map((x) => ({ path: `turnos/${x.id}`, data: { guardiaUid: null }, merge: true })));
    await commit(env, [{ path: `usuarios/${uid}`, data: { sitiosAsignados: [] }, merge: true }]);
    return { status: 200, body: { ok: true, tokensRevocados: auth.existia, turnosLiberados: futuros.length } };
  }
  // Supervisor: sus sitios quedan sin supervisor.
  const sitios = await runQuery(env, "sitios", [{ campo: "supervisorUid", op: "EQUAL", valor: uid }]);
  for (const s of sitios) await reasignarSupervisor(env, s.id, null);
  return { status: 200, body: { ok: true, tokensRevocados: auth.existia, sitiosSinSupervisor: sitios.length } };
}

export async function reactivarUsuario(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const body = await readJson(request);
  const uid = vId(body.uid, "uid");
  const t = await cargarObjetivo(env, uid);
  await setAuthUserState(env, uid, { disabled: false });
  const writes = [
    { path: `usuarios/${uid}`, data: { activo: true }, merge: true, mustExist: true },
    auditoria(actor, "personal.reactivar", uid, { rol: t.rol }),
  ];
  if (t.rol === "guardia") writes.push({ path: `credenciales/${t.numeroEmpleado}`, data: { activo: true }, merge: true });
  await commit(env, writes);
  return { status: 200, body: { ok: true } };
}

export async function restablecerPin(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const body = await readJson(request);
  const numero = numeroEmpleado(body.numero);
  const pin = vPin(body.pin);
  const cred = await getDocument(env, `credenciales/${numero}`);
  if (!cred) throw new HttpError(404, "not_found");
  const salt = randomSalt();
  const hash = await hashPin(pin, salt, env.PIN_PEPPER);
  await commit(env, [
    { path: `credenciales/${numero}`, data: { hash, salt, iterations: PBKDF2_ITERATIONS }, merge: true, mustExist: true },
    auditoria(actor, "personal.pin_restablecido", cred.uid, { numero }),
  ]);
  await limiter(env, `emp:${numero}`, "reset", EMP_LIMIT);
  return { status: 200, body: { ok: true } };
}

export async function desbloquearPin(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const body = await readJson(request);
  const numero = numeroEmpleado(body.numero);
  const cred = await getDocument(env, `credenciales/${numero}`);
  if (!cred) throw new HttpError(404, "not_found");
  await limiter(env, `emp:${numero}`, "reset", EMP_LIMIT);
  await commit(env, [auditoria(actor, "personal.pin_desbloqueado", cred.uid, { numero })]);
  return { status: 200, body: { ok: true } };
}
