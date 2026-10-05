import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorld, call, PROJECT } from "./harness.js";
import { fechaLocal, localAMs } from "../src/common.js";
import { generarPayload, generarPayloadPunto } from "../src/qr.js";

let w, env;
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const irA = (ms) => { offset = ms - realNow(); };
beforeEach(async () => { if (w) w.restore(); offset = 0; w = await createWorld(); env = w.env; });
after(() => { w.restore(); Date.now = realNow; });

const MIN = 60000, DIA = 86400000;
const BASE = `projects/${PROJECT}/databases/(default)/documents`;
const doc = (p) => w.docs.get(`${BASE}/${p}`);
const val = (f) => (f === undefined ? undefined : "stringValue" in f ? f.stringValue : "integerValue" in f ? Number(f.integerValue) : "booleanValue" in f ? f.booleanValue : "nullValue" in f ? null : "doubleValue" in f ? f.doubleValue : "arrayValue" in f ? (f.arrayValue.values || []).map(val) : "mapValue" in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : f);
const plano = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, val(v)]));
const docsDe = (col) => [...w.docs.entries()].filter(([k]) => k.startsWith(`${BASE}/${col}/`)).map(([k, v]) => ({ id: k.split("/").pop(), ...plano(v) }));
const get = (p) => (doc(p) ? plano(doc(p)) : null);
const encv = (v) => (v === null ? { nullValue: null } : typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : { integerValue: String(v) });
const inyectar = (path, obj) => w.docs.set(`${BASE}/${path}`, Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encv(v)])));

const PASS = "una-clave-muy-larga-1";
const SITE = { lat: 29.0729, lng: -110.9559 };
const D = fechaLocal(Date.now() + 5 * DIA);
const D1 = fechaLocal(localAMs(D, "12:00") + DIA);
const at = (f, h) => localAMs(f, h);
const jpeg = (n = 4000, r = 3) => { const b = new Uint8Array(n).fill(r); b.set([0xff, 0xd8, 0xff, 0xe0], 0); b.set([0xff, 0xd9], n - 2); return Buffer.from(b).toString("base64"); };
const JPG = jpeg();

async function api(method, path, tok, body) {
  const r = await call(worker, env, method, path, { body, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json().catch(() => ({})) : null, raw: r, ct };
}
let adminUid;
const tok = (uid, rol) => w.idToken(uid, rol);

async function mundo() {
  const r = await call(worker, env, "POST", "/setup/primer-admin", { headers: { "x-setup-token": env.SETUP_TOKEN }, body: { nombre: "Ana Admin", email: "ana@marpec.mx", password: PASS } });
  adminUid = (await r.json()).uid;
  const A = () => tok(adminUid, "admin");
  const mkG = async (n, nombre) => (await api("POST", "/admin/usuarios", await A(), { rol: "guardia", nombre, numeroEmpleado: n, pin: "4821" })).body.uid;
  const mkS = async (e, n) => (await api("POST", "/admin/usuarios", await A(), { rol: "supervisor", nombre: n, email: e, password: PASS })).body.uid;
  const [gA, gB, gC, s1, s2] = [await mkG("G001", "Gael"), await mkG("G002", "Gema"), await mkG("G003", "Gus"), await mkS("s1@marpec.mx", "Sara Sup"), await mkS("s2@marpec.mx", "Saúl Sup")];
  const mkSitio = async (nombre, sup, extra = {}) => (await api("POST", "/admin/sitios", await A(), { nombre, supervisorUid: sup, ...SITE, precisionM: 8, radioM: 100, ...extra })).body.id;
  const S1 = await mkSitio("Plaza Norte", s1), S2 = await mkSitio("Bodega Sur", s2);
  const lote = async (sitioId, plantilla, fecha, guardiaUid) => (await api("POST", "/turnos/asignar-lote", await A(), { sitioId, plantilla, desde: fecha, hasta: fecha, guardiaUid })).status;
  assert.equal(await lote(S1, "diurno", D, gA), 201);     // gA: 07:00-19:00 en S1
  assert.equal(await lote(S1, "nocturno", D, gC), 201);   // gC: 19:00-07:00 en S1 (relevo de gA)
  assert.equal(await lote(S2, "diurno", D, gB), 201);
  const turnos = docsDe("turnos");
  const T = (g) => turnos.find((t) => t.guardiaUid === g).id;
  const qrAsis = async (s) => generarPayload(env, s, get(`sitios/${s}`).qrVersion);
  const entrar = async (uid, turnoId, sitio) => api("POST", "/marcas/entrada", await tok(uid, "guardia"), { turnoId, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await qrAsis(sitio), foto: JPG });
  const G = async (uid, metodo, ruta, body) => api(metodo, ruta, await tok(uid, "guardia"), body);
  const inc = (uid, turnoId, o = {}) => G(uid, "POST", "/incidencias", { turnoId, tipoId: "robo", gravedad: "media", descripcion: "Se detectó un candado forzado en el portón.", ...o });
  const vis = (uid, turnoId, o = {}) => G(uid, "POST", "/visitantes/entrada", { turnoId, nombre: "Luis Pérez", visitaA: "Casa 12", motivo: "visita", ...o });
  const nov = (uid, turnoId, texto = "Ronda tranquila.") => G(uid, "POST", "/novedades", { turnoId, texto });
  return { A, gA, gB, gC, s1, s2, S1, S2, tA: T(gA), tB: T(gB), tC: T(gC), entrar, G, inc, vis, nov, qrAsis };
}
const INICIO = () => at(D, "07:00");

// ------------------------------------------------------------------ sin turno activo / aislamiento
test("sin turno activo (sin entrada, ajeno, cerrado, cancelado) no se puede reportar, registrar visitantes ni novedades", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN);
  for (const [n, r] of Object.entries({
    incidencia: await m.inc(m.gA, m.tA), visitante: await m.vis(m.gA, m.tA), novedad: await m.nov(m.gA, m.tA),
    salida: await m.G(m.gA, "POST", "/visitantes/salida", { turnoId: m.tA, visitanteId: "x" }), dentro: await m.G(m.gA, "GET", `/visitantes/dentro?turnoId=${m.tA}`),
  })) { assert.equal(r.status, 409, n); assert.equal(r.body.error, "sin_entrada", n); }
  assert.equal((await m.entrar(m.gA, m.tA, m.S1)).status, 201);
  for (const r of [await m.inc(m.gB, m.tA), await m.vis(m.gB, m.tA), await m.nov(m.gB, m.tA), await m.G(m.gB, "GET", `/visitantes/dentro?turnoId=${m.tA}`)]) assert.equal(r.status, 403, "turno de otro guardia");
  assert.equal((await m.inc(m.gA, "no-existe")).status, 403);
  // roles
  const S = await tok(m.s1, "supervisor"), AD = await m.A();
  for (const ruta of ["/incidencias", "/visitantes/entrada", "/novedades"]) {
    assert.equal((await api("POST", ruta, S, { turnoId: m.tA })).status, 403, `supervisor ${ruta}`);
    assert.equal((await api("POST", ruta, AD, { turnoId: m.tA })).status, 403, `admin ${ruta}`);
    assert.equal((await api("POST", ruta, null, { turnoId: m.tA })).status, 401, `anónimo ${ruta}`);
  }
  // cerrado
  irA(at(D, "19:05"));
  assert.equal((await m.G(m.gA, "POST", "/marcas/salida", { turnoId: m.tA, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrAsis(m.S1), foto: JPG })).status, 409, "relevo pendiente");
  await api("POST", "/relevo/autorizar-cierre", await tok(m.s1, "supervisor"), { turnoId: m.tA, motivo: "El relevo llegará tarde." });
  const cierre = await m.G(m.gA, "POST", "/marcas/salida", { turnoId: m.tA, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrAsis(m.S1), foto: JPG });
  assert.equal(cierre.status, 201, JSON.stringify(cierre.body));
  assert.equal((await m.inc(m.gA, m.tA)).body.error, "sin_turno_activo", "ya cerró");
  assert.equal(docsDe("incidencias").length + docsDe("visitantes").length + docsDe("novedades").length, 0, "no quedó ningún registro");
});

test("sin turno activo: turno cancelado", async () => {
  const m = await mundo();
  await api("POST", "/turnos/cancelar", await m.A(), { turnoId: m.tB });
  irA(INICIO() + 5 * MIN);
  assert.equal((await m.nov(m.gB, m.tB)).body.error, "sin_turno_activo");
});

// ------------------------------------------------------------------ catálogo
test("catálogo de tipos: inicial, configurable por el admin; no se eliminan, solo se desactivan", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const c = await m.G(m.gA, "GET", "/catalogo/incidencias");
  assert.deepEqual(c.body.tipos.map((t) => t.id), ["acceso_no_autorizado", "robo", "danio", "falla_electrica", "falla_equipo", "persona_sospechosa", "otro"]);
  assert.deepEqual(c.body.gravedades, ["baja", "media", "alta"]);
  const tipos = c.body.tipos;
  const guardar = async (uid, rol, lista) => api("POST", "/admin/catalogo-incidencias", await tok(uid, rol), { tipos: lista });
  assert.equal((await guardar(m.s1, "supervisor", tipos)).status, 403);
  assert.equal((await guardar(m.gA, "guardia", tipos)).status, 403);
  const nuevo = await guardar(adminUid, "admin", [...tipos.map((t) => (t.id === "robo" ? { ...t, activo: false } : t)), { nombre: "Fuga de agua", activo: true }]);
  assert.equal(nuevo.status, 200, JSON.stringify(nuevo.body));
  const c2 = await m.G(m.gA, "GET", "/catalogo/incidencias");
  assert.ok(c2.body.tipos.some((t) => t.nombre === "Fuga de agua"));
  assert.ok(!c2.body.tipos.some((t) => t.id === "robo"), "el desactivado no se ofrece");
  assert.equal((await m.inc(m.gA, m.tA, { tipoId: "robo" })).status, 400, "tipo inactivo");
  const idNuevo = c2.body.tipos.find((t) => t.nombre === "Fuga de agua").id;
  assert.equal((await m.inc(m.gA, m.tA, { tipoId: idNuevo })).status, 201, "el tipo nuevo ya sirve");
  const todos = get("configuracion/catalogos").tiposIncidencia;
  assert.equal(todos.length, 8, "el desactivado se conserva");
  assert.equal((await guardar(adminUid, "admin", todos.filter((t) => t.id !== "robo"))).status, 400, "no se pueden eliminar tipos");
  assert.equal((await guardar(adminUid, "admin", todos.map((t) => ({ ...t, activo: false })))).status, 400, "al menos uno activo");
  assert.equal((await guardar(adminUid, "admin", [{ id: "inventado", nombre: "X", activo: true }, ...todos])).status, 400);
  assert.equal((await guardar(adminUid, "admin", [{ ...todos[0], extra: 1 }, ...todos.slice(1)])).status, 400);
  assert.ok(docsDe("auditoria").some((a) => a.accion === "catalogo.incidencias"));
});

// ------------------------------------------------------------------ incidencias
test("incidencia: tipo, gravedad, descripción, hasta 3 fotos en R2, GPS y hora del servidor", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const base = env.SELFIES.objetos.size;
  for (const [n, mal] of Object.entries({ "tipo inexistente": { tipoId: "x" }, "gravedad": { gravedad: "crítica" }, "descripción corta": { descripcion: "no" }, "descripción larga": { descripcion: "x".repeat(1001) },
    "4 fotos": { fotos: [JPG, JPG, JPG, JPG] }, "foto inválida": { fotos: [Buffer.from("a".repeat(3000)).toString("base64")] }, "fotos no es lista": { fotos: "x" },
    "campo no permitido": { ine: "ABC123" }, "lat sin lng": { lat: 29, lng: "x", precisionM: 5 }, "lat fuera de rango": { lat: 99, lng: 0, precisionM: 5 } }))
    assert.equal((await m.inc(m.gA, m.tA, mal)).status, 400, n);
  assert.equal(docsDe("incidencias").length, 0);
  assert.equal(env.SELFIES.objetos.size, base, "ninguna foto de un intento rechazado se conservó");
  const r = await m.inc(m.gA, m.tA, { gravedad: "alta", tipoId: "acceso_no_autorizado", fotos: [jpeg(3000, 1), jpeg(3000, 2), jpeg(3000, 3)], lat: SITE.lat + 0.0002, lng: SITE.lng, precisionM: 12, horaDispositivoMs: 5 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inc = get(`incidencias/${r.body.id}`);
  assert.equal(inc.fotoKeys.length, 3);
  assert.equal(env.SELFIES.objetos.size, base + 3);
  assert.ok(inc.fotoKeys.every((k) => k.startsWith(`incidencias/${m.S1}/${r.body.id}/`)));
  assert.ok(inc.creadoMs >= INICIO() + 5 * MIN && inc.creadoMs < INICIO() + 5 * MIN + 5000, "hora del servidor");
  assert.equal(inc.horaDispositivoMs, 5);
  assert.ok(inc.distanciaM > 20 && inc.distanciaM < 25);
  assert.ok(inc.ts);
  assert.equal(inc.tipoNombre, "Acceso no autorizado");
  assert.ok(!JSON.stringify(r.body).includes("incidencias/"), "no filtra rutas de R2");
  const res = get(`incidenciasResumen/${r.body.id}`);
  assert.equal(res.estado, "abierta");
  assert.equal(res.alta, true, "gravedad alta destacada");
  assert.equal(res.supervisorUid, m.s1);
  assert.equal(res.nFotos, 3);
  assert.equal(res.guardiaNombre, "Gael");
  assert.equal((await m.inc(m.gA, m.tA, { descripcion: "Incidencia sin fotos ni GPS." })).status, 201);
});

test("seguimiento del supervisor: comentarios y estados como registros NUEVOS; el original no cambia", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const id = (await m.inc(m.gA, m.tA, { gravedad: "alta" })).body.id;
  const original = JSON.stringify(doc(`incidencias/${id}`));
  const S1 = await tok(m.s1, "supervisor"), S2 = await tok(m.s2, "supervisor"), AD = await m.A(), TG = await tok(m.gA, "guardia");
  const seg = (token, b) => api("POST", "/incidencias/seguimiento", token, { incidenciaId: id, ...b });
  assert.equal((await seg(S2, { tipo: "comentario", texto: "no es mi sitio" })).status, 403);
  assert.equal((await seg(TG, { tipo: "comentario", texto: "soy el autor" })).status, 403, "ni el guardia autor");
  assert.equal((await seg(null, { tipo: "comentario", texto: "x" })).status, 401);
  for (const mal of [{ tipo: "otra" }, { tipo: "comentario", texto: "" }, { tipo: "comentario", texto: "x".repeat(501) }, { tipo: "estado", estadoNuevo: "inventado" }, { tipo: "comentario", texto: "ok ok", extra: 1 }, { tipo: "estado" }])
    assert.equal((await seg(S1, mal)).status, 400, JSON.stringify(mal));
  assert.equal(docsDe("seguimientosIncidencia").length, 0);
  assert.equal((await seg(S1, { tipo: "comentario", texto: "Se revisó el portón; se llamó a la policía." })).status, 201);
  assert.equal((await seg(S1, { tipo: "estado", estadoNuevo: "en_atencion", texto: "Policía en camino." })).body.estado, "en_atencion");
  assert.equal((await seg(S1, { tipo: "estado", estadoNuevo: "abierta" })).status, 409, "no se reabre");
  assert.equal((await seg(AD, { tipo: "estado", estadoNuevo: "cerrada", texto: "Resuelto." })).body.estado, "cerrada", "el admin también");
  assert.equal((await seg(S1, { tipo: "estado", estadoNuevo: "en_atencion" })).body.error, "transicion_invalida");
  assert.equal((await seg(S1, { tipo: "comentario", texto: "Comentario posterior al cierre." })).status, 201, "se puede comentar tras cerrar");
  assert.equal(JSON.stringify(doc(`incidencias/${id}`)), original, "el registro original NO cambió");
  const segs = docsDe("seguimientosIncidencia").sort((a, b) => a.tsMs - b.tsMs);
  assert.equal(segs.length, 4);
  assert.deepEqual(segs.map((s) => s.autorNombre), ["Sara Sup", "Sara Sup", "Ana Admin", "Sara Sup"]);
  assert.ok(segs.every((s) => s.tsMs && s.ts && s.autorUid && s.autorRol));
  const res = get(`incidenciasResumen/${id}`);
  assert.equal(res.estado, "cerrada");
  assert.equal(res.seguimientos.length, 4);
  assert.equal(res.seguimientos[1].estadoNuevo, "en_atencion");
  assert.ok(!w.calls.some((c) => /^(DELETE|PATCH) .*\/(incidencias|seguimientosIncidencia)\//.test(c)), "nada edita ni borra incidencias ni seguimientos");
  assert.ok(docsDe("auditoria").some((a) => a.accion === "incidencia.estado" && a.actorUid === m.s1));
});

test("fotos de incidencias: solo admin y supervisor del sitio; ni el autor, ni otros", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const id = (await m.inc(m.gA, m.tA, { fotos: [jpeg(3000, 8), jpeg(3500, 9)] })).body.id;
  const ver = async (uid, rol, n = 0) => api("GET", `/incidencias/foto?incidencia=${id}&n=${n}`, uid ? await tok(uid, rol) : null);
  const ok = await ver(adminUid, "admin", 1);
  assert.equal(ok.status, 200);
  assert.equal(ok.ct, "image/jpeg");
  assert.equal(new Uint8Array(await ok.raw.arrayBuffer()).length, 3500);
  assert.equal((await ver(m.s1, "supervisor")).status, 200);
  assert.equal((await ver(m.s2, "supervisor")).status, 403);
  assert.equal((await ver(m.gA, "guardia")).status, 403, "ni el guardia autor");
  assert.equal((await ver(m.gB, "guardia")).status, 403);
  assert.equal((await ver(null)).status, 401);
  assert.equal((await ver(adminUid, "admin", 2)).status, 404, "no hay tercera foto");
  assert.equal((await ver(adminUid, "admin", 7)).status, 400);
  await api("POST", "/admin/sitios/actualizar", await m.A(), { id: m.S1, supervisorUid: m.s2 });
  assert.equal((await ver(m.s1, "supervisor")).status, 403, "el acceso sigue al supervisor ACTUAL");
  assert.equal((await ver(m.s2, "supervisor")).status, 200);
});

// ------------------------------------------------------------------ visitantes
test("visitantes: sin campos de identificación; esquema estricto y validado", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  for (const campo of ["ine", "identificacion", "numeroIdentificacion", "licencia", "pasaporte", "curp", "documento", "fotoIdentificacion", "fotoIne", "idOficial", "foto_ine"])
    assert.equal((await m.vis(m.gA, m.tA, { [campo]: "ABC1234567" })).status, 400, `campo ${campo} rechazado`);
  for (const [n, mal] of Object.entries({ "nombre corto": { nombre: "L" }, "nombre largo": { nombre: "x".repeat(81) }, "sin visita": { visitaA: "" }, "motivo": { motivo: "turismo" }, "empresa larga": { empresa: "e".repeat(81) },
    "placas": { placas: "!!!" }, "placas largas": { placas: "A".repeat(20) }, "foto inválida": { foto: Buffer.from("a".repeat(3000)).toString("base64") } }))
    assert.equal((await m.vis(m.gA, m.tA, mal)).status, 400, n);
  assert.equal(docsDe("visitantes").length, 0);
  const r = await m.vis(m.gA, m.tA, { motivo: "proveedor", empresa: "Agua Pura SA", placas: "abc-123", foto: jpeg(3000, 6) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = get(`visitantes/${r.body.id}`);
  assert.equal(v.placas, "ABC-123");
  assert.ok(v.fotoKey.startsWith(`visitantes/${m.S1}/`));
  assert.ok(v.entradaMs >= INICIO() + 5 * MIN && v.entradaMs < INICIO() + 5 * MIN + 5000, "hora del servidor");
  assert.equal(v.expiraMs, v.entradaMs + 90 * DIA, "retención por defecto: 90 días");
  const PERMITIDOS = ["sitioId", "turnoId", "guardiaUid", "guardiaNombre", "nombre", "visitaA", "motivo", "empresa", "placas", "fotoKey", "entradaMs", "expiraMs", "ts", "prueba"];
  for (const col of ["visitantes", "visitantesVista"]) for (const d of docsDe(col)) for (const k of Object.keys(d)) {
    assert.ok(!/ine\b|licen|pasap|identific|curp|documento|oficial/i.test(k), `${col}.${k}: no existe campo para identificaciones`);
    if (col === "visitantes") assert.ok(k === "id" || PERMITIDOS.includes(k), `${col}.${k} fuera del esquema`);
  }
  assert.equal((await m.vis(m.gA, m.tA, { nombre: "Sin foto" })).status, 201, "la foto es opcional");
});

test("visitantes: salida, lista «dentro ahora», entrante ve quién sigue dentro y puede registrar su salida", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const v1 = (await m.vis(m.gA, m.tA, { nombre: "Ana Visita" })).body.id;
  const v2 = (await m.vis(m.gA, m.tA, { nombre: "Beto Proveedor", motivo: "proveedor", placas: "XYZ-999" })).body.id;
  const dentro = async (uid, ruta) => (await m.G(uid, "GET", ruta)).body;
  assert.deepEqual((await dentro(m.gA, `/visitantes/dentro?turnoId=${m.tA}`)).dentro.map((x) => x.nombre), ["Ana Visita", "Beto Proveedor"]);
  assert.equal((await m.G(m.gA, "POST", "/visitantes/salida", { turnoId: m.tA, visitanteId: v1 })).status, 201);
  const sal = get(`salidasVisitante/${v1}`);
  assert.ok(sal.salidaMs && sal.guardiaUid === m.gA);
  assert.equal((await m.G(m.gA, "POST", "/visitantes/salida", { turnoId: m.tA, visitanteId: v1 })).body.error, "ya_salio");
  assert.equal(get(`visitantesVista/${v1}`).dentro, false);
  assert.deepEqual((await dentro(m.gA, `/visitantes/dentro?turnoId=${m.tA}`)).dentro.map((x) => x.nombre), ["Beto Proveedor"], "solo quien sigue dentro");
  assert.equal((await m.G(m.gA, "POST", "/visitantes/salida", { turnoId: m.tA, visitanteId: v2, extra: 1 })).status, 400);
  // otro sitio: no ve ni puede sacar visitantes ajenos
  irA(INICIO() + 10 * MIN); await m.entrar(m.gB, m.tB, m.S2);
  assert.deepEqual((await dentro(m.gB, `/visitantes/dentro?turnoId=${m.tB}`)).dentro, [], "no ve los de otro sitio");
  assert.equal((await m.G(m.gB, "POST", "/visitantes/salida", { turnoId: m.tB, visitanteId: v2 })).status, 404);
  // supervisores
  const sd = await api("GET", `/visitantes/dentro?sitioId=${m.S1}`, await tok(m.s1, "supervisor"));
  assert.deepEqual(sd.body.dentro.map((x) => x.nombre), ["Beto Proveedor"]);
  assert.equal((await api("GET", `/visitantes/dentro?sitioId=${m.S1}`, await tok(m.s2, "supervisor"))).status, 403);
  assert.equal((await api("GET", `/visitantes/dentro?sitioId=${m.S1}`, await m.A())).status, 200);
  // cambio de turno: el entrante (gC) ve a Beto y registra su salida
  irA(at(D, "19:00") + 5 * MIN);
  await api("POST", "/relevo/autorizar-cierre", await tok(m.s1, "supervisor"), { turnoId: m.tA, motivo: "Se retira antes del relevo." });
  assert.equal((await m.entrar(m.gC, m.tC, m.S1)).status, 201);
  assert.deepEqual((await dentro(m.gC, `/visitantes/dentro?turnoId=${m.tC}`)).dentro.map((x) => x.nombre), ["Beto Proveedor"], "el entrante ve quién sigue dentro");
  assert.equal((await m.G(m.gC, "POST", "/visitantes/salida", { turnoId: m.tC, visitanteId: v2 })).status, 201);
  assert.equal(get(`visitantesVista/${v2}`).salidaTurnoId, m.tC);
});

test("foto del vehículo/placa: solo admin y supervisor del sitio", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const id = (await m.vis(m.gA, m.tA, { foto: jpeg(3000, 4), placas: "AAA-111" })).body.id;
  const sinFoto = (await m.vis(m.gA, m.tA, { nombre: "Sin Foto" })).body.id;
  const ver = async (uid, rol, vid = id) => api("GET", `/visitantes/foto?id=${vid}`, uid ? await tok(uid, rol) : null);
  assert.equal((await ver(adminUid, "admin")).status, 200);
  assert.equal((await ver(m.s1, "supervisor")).status, 200);
  assert.equal((await ver(m.s2, "supervisor")).status, 403);
  assert.equal((await ver(m.gA, "guardia")).status, 403);
  assert.equal((await ver(null)).status, 401);
  assert.equal((await ver(adminUid, "admin", sinFoto)).status, 404);
});

// ------------------------------------------------------------------ novedades y bitácora
test("novedades: hora del servidor, inmutables, validadas", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  for (const mal of [{ texto: "" }, { texto: "x" }, { texto: "x".repeat(1001) }, { texto: "ok ok", otro: 1 }]) assert.equal((await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, ...mal })).status, 400, JSON.stringify(mal).slice(0, 40));
  const r = await m.nov(m.gA, m.tA, "Se cambió la bombilla del pasillo.");
  assert.equal(r.status, 201);
  const n = get(`novedades/${r.body.id}`);
  assert.ok(n.tsMs >= INICIO() + 5 * MIN && n.tsMs < INICIO() + 5 * MIN + 5000);
  assert.equal(n.texto, "Se cambió la bombilla del pasillo.");
  assert.ok(n.ts);
  await m.nov(m.gA, m.tA, "Segunda novedad.");
  assert.ok(!w.calls.some((c) => /^(DELETE|PATCH) .*\/novedades\//.test(c)));
  assert.equal(docsDe("novedades").length, 2);
});

test("bitácora consolidada del turno: entrada, novedades, rondín, incidencia, visitantes, salida y notas — en orden", async () => {
  const m = await mundo();
  const pto = (await api("POST", "/admin/puntos", await m.A(), { sitioId: m.S1, nombre: "Portón", orden: 1 })).body.id;
  await api("POST", "/rondines/programa", await m.A(), { sitioId: m.S1, modo: "libre", frecuencia: { tipo: "horarios", horarios: ["10:00"] }, toleranciaInicioMin: 15, toleranciaFinMin: 45 });
  await api("POST", "/turnos/cancelar", await m.A(), { turnoId: m.tA });
  assert.equal((await api("POST", "/turnos/asignar-lote", await m.A(), { sitioId: m.S1, plantilla: "personalizada", desde: D, hasta: D, horaInicio: "06:00", horaFin: "14:00", guardiaUid: m.gA })).status, 201);
  const tA = docsDe("turnos").find((t) => t.guardiaUid === m.gA && t.estado === "programado" && t.inicioMs === at(D, "06:00")).id;
  irA(at(D, "06:02")); assert.equal((await m.entrar(m.gA, tA, m.S1)).status, 201);
  irA(at(D, "08:00")); await m.nov(m.gA, tA, "Todo en orden en la apertura.");
  irA(at(D, "09:00")); const vid = (await m.vis(m.gA, tA, { nombre: "Carlos Servicio", motivo: "servicio" })).body.id;
  irA(at(D, "10:01")); assert.equal((await m.G(m.gA, "POST", "/rondines/escanear", { turnoId: tA, qr: await generarPayloadPunto(env, pto, 1) })).status, 201);
  irA(at(D, "11:30")); await m.inc(m.gA, tA, { gravedad: "alta", descripcion: "Cable pelado en la caseta." });
  irA(at(D, "12:00")); await m.G(m.gA, "POST", "/visitantes/salida", { turnoId: tA, visitanteId: vid });
  irA(at(D, "14:05"));
  assert.equal((await m.G(m.gA, "POST", "/marcas/salida", { turnoId: tA, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrAsis(m.S1), foto: JPG, notasEntrega: "Cable pelado reportado." })).status, 201);
  const b = (await m.G(m.gA, "GET", `/bitacora/turno?turnoId=${tA}`)).body;
  assert.deepEqual(b.items.map((x) => x.tipo), ["entrada", "novedad", "visitante_entrada", "rondin", "incidencia", "visitante_salida", "salida"], "orden cronológico");
  assert.ok(b.items.every((x, i, a) => i === 0 || a[i - 1].tsMs <= x.tsMs));
  assert.match(b.items.at(-1).detalle, /Cable pelado reportado/);
  assert.equal(b.items.find((x) => x.tipo === "incidencia").gravedad, "alta");
  assert.equal(b.cerrado, true);
  assert.equal(b.notasEntrega, "Cable pelado reportado.");
  assert.equal(b.guardiaNombre, "Gael");
  // permisos
  assert.equal((await m.G(m.gB, "GET", `/bitacora/turno?turnoId=${tA}`)).status, 403, "otro guardia");
  assert.equal((await api("GET", `/bitacora/turno?turnoId=${tA}`, await tok(m.s2, "supervisor"))).status, 403, "supervisor de otro sitio");
  assert.equal((await api("GET", `/bitacora/turno?turnoId=${tA}`, await tok(m.s1, "supervisor"))).status, 200);
  assert.equal((await api("GET", `/bitacora/turno?turnoId=${tA}`, await m.A())).status, 200);
  assert.equal((await api("GET", `/bitacora/turno?turnoId=${tA}`, null)).status, 401);
});

test("el entrante ve la bitácora del turno anterior de SU sitio (y nadie más)", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  await m.nov(m.gA, m.tA, "Portón 2 con falla; llaves en caseta.");
  const v = (await m.vis(m.gA, m.tA, { nombre: "Pedro Sigue Dentro" })).body.id;
  irA(at(D, "19:00") - 10 * MIN); await m.entrar(m.gC, m.tC, m.S1);
  const r = await m.G(m.gC, "GET", `/bitacora/anterior?turnoId=${m.tC}`);
  assert.equal(r.body.hay, true);
  assert.equal(r.body.bitacora.guardiaNombre, "Gael");
  assert.ok(r.body.bitacora.items.some((x) => x.tipo === "novedad" && /Portón 2/.test(x.detalle)));
  assert.deepEqual(r.body.bitacora.visitantesDentro.map((x) => x.nombre), ["Pedro Sigue Dentro"], "quién sigue dentro al cambiar de turno");
  assert.equal((await m.G(m.gB, "GET", `/bitacora/anterior?turnoId=${m.tC}`)).status, 403, "turno ajeno");
  assert.equal((await m.G(m.gA, "GET", `/bitacora/anterior?turnoId=${m.tA}`)).body.hay, false, "el primero del día no tiene anterior");
  assert.equal((await api("GET", `/bitacora/anterior?turnoId=${m.tC}`, await tok(m.s1, "supervisor"))).status, 403, "solo guardias");
  void v;
});

// ------------------------------------------------------------------ retención
test("retención de visitantes: borra registros y fotos vencidos; NADA más", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const nuevo = (await m.vis(m.gA, m.tA, { nombre: "Visita reciente", foto: jpeg(3000, 5) })).body.id;
  const ahora = Date.now();
  // Registros vencidos (100 días), uno con salida y foto; otro vencido sin salida
  const viejos = [];
  for (const [i, conSalida] of [[1, true], [2, false]]) {
    const id = `viejo-${i}`;
    const fotoKey = `visitantes/${m.S1}/${id}.jpg`;
    await env.SELFIES.put(fotoKey, new Uint8Array([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]), {});
    inyectar(`visitantes/${id}`, { sitioId: m.S1, turnoId: "t-viejo", guardiaUid: m.gA, nombre: `Viejo ${i}`, visitaA: "X", motivo: "visita", empresa: "", placas: "", fotoKey, entradaMs: ahora - 100 * DIA, expiraMs: ahora - 10 * DIA, prueba: true });
    inyectar(`visitantesVista/${id}`, { visitanteId: id, sitioId: m.S1, nombre: `Viejo ${i}`, entradaMs: ahora - 100 * DIA, dentro: !conSalida, prueba: true });
    if (conSalida) inyectar(`salidasVisitante/${id}`, { visitanteId: id, sitioId: m.S1, salidaMs: ahora - 100 * DIA + 3600000, prueba: true });
    viejos.push(id);
  }
  // Otros registros antiguos que NO deben tocarse
  const inc = (await m.inc(m.gA, m.tA, { fotos: [jpeg(3000, 7)] })).body.id;
  await m.nov(m.gA, m.tA, "Novedad que debe sobrevivir.");
  inyectar("incidencias/vieja-inc", { sitioId: m.S1, guardiaUid: m.gA, descripcion: "Incidencia de hace 200 días", creadoMs: ahora - 200 * DIA, tipoId: "robo", gravedad: "baja", fotoKeys: [] });
  inyectar("novedades/vieja-nov", { turnoId: "t-viejo", sitioId: m.S1, guardiaUid: m.gA, texto: "Novedad de hace 200 días", tsMs: ahora - 200 * DIA });
  inyectar("marcas/t-viejo_entrada", { turnoId: "t-viejo", guardiaUid: m.gA, tipo: "entrada", tsMs: ahora - 200 * DIA });
  const antes = {
    marcas: docsDe("marcas").length, incidencias: docsDe("incidencias").length, novedades: docsDe("novedades").length,
    usuarios: docsDe("usuarios").length, sitios: docsDe("sitios").length, turnos: docsDe("turnos").length, resumen: docsDe("incidenciasResumen").length,
  };
  const fotosAntes = [...env.SELFIES.objetos.keys()];
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 600));
  for (const id of viejos) {
    assert.equal(get(`visitantes/${id}`), null, `${id}: entrada borrada`);
    assert.equal(get(`visitantesVista/${id}`), null, `${id}: vista borrada`);
    assert.equal(get(`salidasVisitante/${id}`), null, `${id}: salida borrada`);
    assert.ok(!env.SELFIES.objetos.has(`visitantes/${m.S1}/${id}.jpg`), `${id}: foto borrada de R2`);
  }
  assert.ok(get(`visitantes/${nuevo}`), "el visitante reciente se conserva");
  assert.ok(get(`visitantesVista/${nuevo}`));
  assert.ok(env.SELFIES.objetos.has(get(`visitantes/${nuevo}`).fotoKey), "y su foto");
  const despues = {
    marcas: docsDe("marcas").length, incidencias: docsDe("incidencias").length, novedades: docsDe("novedades").length,
    usuarios: docsDe("usuarios").length, sitios: docsDe("sitios").length, turnos: docsDe("turnos").length, resumen: docsDe("incidenciasResumen").length,
  };
  assert.deepEqual(despues, antes, "el borrado no tocó marcas, incidencias, novedades, asistencias, usuarios, sitios ni turnos");
  assert.ok(get("incidencias/vieja-inc") && get("novedades/vieja-nov") && get("marcas/t-viejo_entrada"), "los registros antiguos que no son de visitantes siguen ahí");
  assert.ok(env.SELFIES.objetos.size >= 2 && [...env.SELFIES.objetos.keys()].filter((k) => !k.startsWith("visitantes/")).every((k) => fotosAntes.includes(k)), "las fotos que no son de visitantes siguen en R2");
  assert.ok(env.SELFIES.objetos.has(get(`incidencias/${inc}`).fotoKeys[0]), "la foto de la incidencia sigue");
  const purga = docsDe("auditoria").find((a) => a.accion === "visitantes.purga");
  assert.ok(purga, "queda registro de la purga");
  assert.deepEqual(JSON.parse(purga.detalle), { registros: 2, fotos: 2, retencionDias: 90 });
  assert.equal(purga.prueba, true, "purga de registros de prueba");
});

test("la retención es configurable (7–1825 días, 90 por defecto) y se aplica", async () => {
  const m = await mundo();
  const base = { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3 };
  const guardar = async (extra, uid = adminUid, rol = "admin") => api("POST", "/admin/config", await tok(uid, rol), { ...base, ...extra });
  assert.equal((await guardar({})).status, 200);
  assert.equal(get("configuracion/empresa").retencionVisitantesDias, 90, "por defecto 90 días");
  for (const mal of [{ retencionVisitantesDias: 6 }, { retencionVisitantesDias: 1826 }, { retencionVisitantesDias: 30.5 }, { retencionVisitantesDias: "90" }]) assert.equal((await guardar(mal)).status, 400, JSON.stringify(mal));
  assert.equal((await guardar({ retencionVisitantesDias: 30 }, m.s1, "supervisor")).status, 403);
  assert.equal((await guardar({ retencionVisitantesDias: 30 })).status, 200);
  assert.equal(get("configuracion/empresa").retencionVisitantesDias, 30);
  const ahora = Date.now();
  inyectar("visitantes/de-45-dias", { sitioId: m.S1, nombre: "Hace 45 días", entradaMs: ahora - 45 * DIA });
  inyectar("visitantesVista/de-45-dias", { visitanteId: "de-45-dias", sitioId: m.S1, nombre: "Hace 45 días", entradaMs: ahora - 45 * DIA, dentro: false });
  inyectar("visitantes/de-10-dias", { sitioId: m.S1, nombre: "Hace 10 días", entradaMs: ahora - 10 * DIA });
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(get("visitantes/de-45-dias"), null, "45 días > 30: se borra");
  assert.ok(get("visitantes/de-10-dias"), "10 días < 30: se conserva");
});

// ------------------------------------------------------------------ prueba
test("datos de prueba: incidencias, visitantes y novedades heredan prueba=true del sitio", async () => {
  const m = await mundo();
  const SP = (await api("POST", "/admin/sitios", await m.A(), { nombre: "Sitio prueba", supervisorUid: m.s1, ...SITE, precisionM: 5, radioM: 100, prueba: true })).body.id;
  const gP = (await api("POST", "/admin/usuarios", await m.A(), { rol: "guardia", nombre: "Guardia Prueba", numeroEmpleado: "P001", pin: "4821", prueba: true })).body.uid;
  await api("POST", "/turnos/asignar-lote", await m.A(), { sitioId: SP, plantilla: "diurno", desde: D, hasta: D, guardiaUid: gP });
  const tP = docsDe("turnos").find((t) => t.guardiaUid === gP).id;
  irA(INICIO() + 5 * MIN);
  await api("POST", "/marcas/entrada", await tok(gP, "guardia"), { turnoId: tP, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await generarPayload(env, SP, 1), foto: JPG });
  const G = (b, ruta) => api("POST", ruta, null, null).then(async () => api("POST", ruta, await tok(gP, "guardia"), { turnoId: tP, ...b }));
  const i = (await G({ tipoId: "robo", gravedad: "baja", descripcion: "Incidencia de prueba." }, "/incidencias")).body.id;
  const v = (await G({ nombre: "Visitante Prueba", visitaA: "Nadie", motivo: "otro" }, "/visitantes/entrada")).body.id;
  const n = (await G({ texto: "Novedad de prueba." }, "/novedades")).body.id;
  assert.equal(get(`incidencias/${i}`).prueba, true);
  assert.equal(get(`incidenciasResumen/${i}`).prueba, true);
  assert.equal(get(`visitantes/${v}`).prueba, true);
  assert.equal(get(`visitantesVista/${v}`).prueba, true);
  assert.equal(get(`novedades/${n}`).prueba, true);
  await api("POST", "/incidencias/seguimiento", await tok(m.s1, "supervisor"), { incidenciaId: i, tipo: "comentario", texto: "Seguimiento de prueba." });
  assert.ok(docsDe("seguimientosIncidencia").every((s) => s.prueba === true));
  assert.ok(docsDe("auditoria").filter((a) => a.accion === "incidencia.comentario").every((a) => a.prueba === true));
  // y los reales no se marcan
  await m.entrar(m.gA, m.tA, m.S1);
  const real = (await m.inc(m.gA, m.tA)).body.id;
  assert.equal(get(`incidencias/${real}`).prueba, undefined);
});
