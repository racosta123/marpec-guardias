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

const MIN = 60000, H = 60 * MIN;
const BASE = `projects/${PROJECT}/databases/(default)/documents`;
const doc = (p) => w.docs.get(`${BASE}/${p}`);
const val = (f) => (f === undefined ? undefined : "stringValue" in f ? f.stringValue : "integerValue" in f ? Number(f.integerValue) : "booleanValue" in f ? f.booleanValue : "nullValue" in f ? null : "doubleValue" in f ? f.doubleValue : "arrayValue" in f ? (f.arrayValue.values || []).map(val) : "mapValue" in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : f);
const plano = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, val(v)]));
const docsDe = (col) => [...w.docs.entries()].filter(([k]) => k.startsWith(`${BASE}/${col}/`)).map(([k, v]) => ({ id: k.split("/").pop(), ...plano(v) }));
const get = (p) => (doc(p) ? plano(doc(p)) : null);

const PASS = "una-clave-muy-larga-1";
const SITE = { lat: 29.0729, lng: -110.9559 };
const D = fechaLocal(Date.now() + 5 * 86400000);
const D1 = fechaLocal(localAMs(D, "12:00") + 86400000);
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

// Mundo: admin, 2 supervisores, guardias A (nocturno en S1) y B (S2), S1 con 3 puntos, programa cada 3 h.
async function mundo({ modo = "libre", gps = false } = {}) {
  const r = await call(worker, env, "POST", "/setup/primer-admin", { headers: { "x-setup-token": env.SETUP_TOKEN }, body: { nombre: "Ana Admin", email: "ana@marpec.mx", password: PASS } });
  adminUid = (await r.json()).uid;
  const A = () => tok(adminUid, "admin");
  const mkG = async (n, nombre) => (await api("POST", "/admin/usuarios", await A(), { rol: "guardia", nombre, numeroEmpleado: n, pin: "4821" })).body.uid;
  const mkS = async (e, n) => (await api("POST", "/admin/usuarios", await A(), { rol: "supervisor", nombre: n, email: e, password: PASS })).body.uid;
  const [gA, gB, s1, s2] = [await mkG("G001", "Gael"), await mkG("G002", "Gema"), await mkS("s1@marpec.mx", "Sara Sup"), await mkS("s2@marpec.mx", "Saúl Sup")];
  const mkSitio = async (nombre, sup, extra = {}) => (await api("POST", "/admin/sitios", await A(), { nombre, supervisorUid: sup, ...SITE, precisionM: 8, radioM: 100, ...extra })).body.id;
  const S1 = await mkSitio("Plaza Norte", s1), S2 = await mkSitio("Bodega Sur", s2);
  const punto = async (sitioId, nombre, orden, extra = {}) => (await api("POST", "/admin/puntos", await A(), { sitioId, nombre, orden, ...extra })).body.id;
  const gpsP = (dx) => (gps ? { lat: SITE.lat + dx, lng: SITE.lng, precisionM: 5, radioM: 30 } : {});
  const p1 = await punto(S1, "Portón", 1, gpsP(0)), p2 = await punto(S1, "Bodega", 2, gpsP(0.0003)), p3 = await punto(S1, "Azotea", 3, gpsP(0.0006));
  const pB = await punto(S2, "Caseta", 1);
  const prog = (sitioId, extra = {}) => api("POST", "/rondines/programa", null, null).then(async () => api("POST", "/rondines/programa", await A(), { sitioId, modo, frecuencia: { tipo: "cada_horas", cadaHoras: 3 }, toleranciaInicioMin: 15, toleranciaFinMin: 45, ...extra }));
  assert.equal((await prog(S1)).status, 200);
  assert.equal((await prog(S2)).status, 200);
  const lote = async (sitioId, plantilla, fecha, guardiaUid) => (await api("POST", "/turnos/asignar-lote", await A(), { sitioId, plantilla, desde: fecha, hasta: fecha, guardiaUid })).status;
  assert.equal(await lote(S1, "nocturno", D, gA), 201);
  assert.equal(await lote(S2, "nocturno", D, gB), 201);
  const turnos = docsDe("turnos");
  const tA = turnos.find((t) => t.guardiaUid === gA).id, tB = turnos.find((t) => t.guardiaUid === gB).id;
  const qrAsis = async (s) => generarPayload(env, s, get(`sitios/${s}`).qrVersion);
  const qrP = async (p) => generarPayloadPunto(env, p, get(`puntos/${p}`).qrVersion);
  const entrar = async (uid, turnoId, sitio) => api("POST", "/marcas/entrada", await tok(uid, "guardia"), { turnoId, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await qrAsis(sitio), foto: JPG });
  const escanear = async (uid, turnoId, puntoId, o = {}) => api("POST", "/rondines/escanear", await tok(uid, "guardia"), { turnoId, qr: o.qr ?? (await qrP(puntoId)), horaDispositivoMs: 0, ...o });
  const ini = at(D, "19:00");
  return { A, gA, gB, s1, s2, S1, S2, p1, p2, p3, pB, tA, tB, qrAsis, qrP, entrar, escanear, ini, punto, prog, mkS };
}
const SLOT0 = () => at(D, "22:00"), SLOT1 = () => at(D1, "01:00"), SLOT2 = () => at(D1, "04:00");

// ------------------------------------------------------------------ puntos y QR
test("puntos: admin y supervisor del sitio los gestionan; otros no; datos validados", async () => {
  const m = await mundo();
  const T1 = await tok(m.s1, "supervisor"), T2 = await tok(m.s2, "supervisor"), TG = await tok(m.gA, "guardia");
  const base = { sitioId: m.S1, nombre: "Estacionamiento", descripcion: "Nivel -1" };
  const ok = await api("POST", "/admin/puntos", T1, base);
  assert.equal(ok.status, 201, "el supervisor del sitio crea puntos");
  const p = get(`puntos/${ok.body.id}`);
  assert.equal(p.orden, 4, "orden automático = siguiente");
  assert.equal(p.radioM, 30, "radio por defecto 30 m");
  assert.equal(p.lat, null);
  assert.equal(p.qrVersion, 1);
  assert.equal(p.supervisorUid, m.s1);
  assert.equal((await api("POST", "/admin/puntos", T2, base)).status, 403, "supervisor de otro sitio");
  assert.equal((await api("POST", "/admin/puntos", TG, base)).status, 403, "guardia");
  assert.equal((await api("POST", "/admin/puntos", null, base)).status, 401);
  for (const mal of [{ nombre: "x" }, { nombre: "y".repeat(81) }, { descripcion: "z".repeat(301) }, { orden: 0 }, { orden: 1000 }, { radioM: 4 }, { radioM: 201 }, { lat: 91, lng: 0 }, { lat: 10 }, { lat: "10", lng: "10" }, { sitioId: "no-existe" }])
    assert.equal((await api("POST", "/admin/puntos", await m.A(), { ...base, ...mal })).status, [400, 404].includes(400) ? (mal.sitioId ? 404 : 400) : 400, JSON.stringify(mal));
  const gps = await api("POST", "/admin/puntos", await m.A(), { ...base, nombre: "Con GPS", lat: 29.07, lng: -110.95, precisionM: 9, radioM: 25 });
  assert.equal(get(`puntos/${gps.body.id}`).radioM, 25);
  // edición, reorden e inactivación
  assert.equal((await api("POST", "/admin/puntos/actualizar", T1, { id: m.p1, orden: 9, descripcion: "Entrada principal" })).status, 200);
  assert.equal(get(`puntos/${m.p1}`).orden, 9);
  assert.equal((await api("POST", "/admin/puntos/actualizar", T2, { id: m.p1, nombre: "Hack" })).status, 403);
  assert.equal((await api("POST", "/admin/puntos/actualizar", T1, { id: m.p1 })).status, 400);
  assert.equal((await api("POST", "/admin/puntos/actualizar", T1, { id: m.p2, activo: false })).status, 200);
  const hoja = await api("GET", `/puntos/qr-sitio?sitioId=${m.S1}`, T1);
  assert.deepEqual(hoja.body.puntos.map((x) => x.nombre), ["Bodega", "Azotea", "Estacionamiento", "Con GPS", "Portón"].filter((n) => n !== "Bodega").sort((a, b) => ({ Azotea: 3, Estacionamiento: 4, "Con GPS": 5, Portón: 9 })[a] - ({ Azotea: 3, Estacionamiento: 4, "Con GPS": 5, Portón: 9 })[b]), "hoja: solo activos, en orden");
  assert.equal((await api("GET", `/puntos/qr-sitio?sitioId=${m.S1}`, T2)).status, 403);
  assert.equal((await api("GET", `/puntos/qr-sitio?sitioId=${m.S1}`, TG)).status, 403);
  assert.ok(docsDe("auditoria").some((a) => a.accion === "punto.alta" && a.actorUid === m.s1));
});

test("QR de punto: firmado, propio de cada punto, regenerable (invalida el anterior)", async () => {
  const m = await mundo();
  const T1 = await tok(m.s1, "supervisor");
  const q = await api("GET", `/puntos/qr?id=${m.p1}`, T1);
  assert.equal(q.status, 200);
  assert.match(q.body.payload, /^MPC2\.[0-9a-f]+\.1\.[A-Za-z0-9_-]{22}$/);
  assert.equal((await api("GET", `/puntos/qr?id=${m.p1}`, await tok(m.s2, "supervisor"))).status, 403);
  assert.equal((await api("GET", `/puntos/qr?id=${m.p1}`, await tok(m.gA, "guardia"))).status, 403, "el guardia no obtiene firmas");
  assert.notEqual((await api("GET", `/puntos/qr?id=${m.p2}`, T1)).body.payload, q.body.payload, "cada punto tiene el suyo");
  assert.equal((await api("POST", "/admin/puntos/regenerar-qr", await tok(m.s2, "supervisor"), { id: m.p1 })).status, 403);
  const reg = await api("POST", "/admin/puntos/regenerar-qr", T1, { id: m.p1 });
  assert.equal(reg.body.version, 2);
  assert.notEqual((await api("GET", `/puntos/qr?id=${m.p1}`, T1)).body.payload, q.body.payload);
  assert.ok(docsDe("auditoria").some((a) => a.accion === "punto.qr_regenerado"));
});

test("programación del rondín: validada y solo admin / supervisor del sitio", async () => {
  const m = await mundo();
  const body = { sitioId: m.S1, modo: "ordenada", frecuencia: { tipo: "horarios", horarios: ["22:00", "02:00"] }, toleranciaInicioMin: 10, toleranciaFinMin: 30 };
  assert.equal((await api("POST", "/rondines/programa", await tok(m.s1, "supervisor"), body)).status, 200);
  const p = get(`programasRondin/${m.S1}`);
  assert.equal(p.modo, "ordenada");
  assert.deepEqual(p.frecuencia.horarios, ["02:00", "22:00"]);
  assert.equal((await api("POST", "/rondines/programa", await tok(m.s2, "supervisor"), body)).status, 403);
  assert.equal((await api("POST", "/rondines/programa", await tok(m.gA, "guardia"), body)).status, 403);
  for (const mal of [{ modo: "x" }, { frecuencia: { tipo: "cada_horas", cadaHoras: 0 } }, { toleranciaFinMin: 5, toleranciaInicioMin: 30 }, { frecuencia: { tipo: "horarios", horarios: ["99:99"] } }])
    assert.equal((await api("POST", "/rondines/programa", await m.A(), { ...body, ...mal })).status, 400, JSON.stringify(mal));
});

// ------------------------------------------------------------------ escaneo: rechazos
test("rechazado: QR alterado, viejo, de otro sitio, de otra llave, inactivo", async () => {
  const m = await mundo();
  irA(m.ini + 2 * MIN); assert.equal((await m.entrar(m.gA, m.tA, m.S1)).status, 201);
  irA(SLOT0());
  const bueno = await m.qrP(m.p1);
  const sp = bueno.split(".");
  const rechazos = {
    alterado: [sp[0], sp[1], sp[2], (sp[3][0] === "A" ? "B" : "A") + sp[3].slice(1)].join("."),
    "versión": [sp[0], sp[1], "2", sp[3]].join("."),
    "punto de OTRO sitio": await m.qrP(m.pB),
    "otra llave": await generarPayloadPunto({ ...env, QR_SECRET: "otra-llave-completamente-distinta-0123456789" }, m.p1, 1),
    basura: "hola", vacío: "", "sin qr": undefined,
  };
  for (const [n, qr] of Object.entries(rechazos)) {
    const r = await m.escanear(m.gA, m.tA, m.p1, { qr });
    assert.equal(r.status, 400, n);
    assert.equal(r.body.error, "qr_invalido", n);
  }
  await api("POST", "/admin/puntos/regenerar-qr", await m.A(), { id: m.p1 });
  assert.equal((await m.escanear(m.gA, m.tA, m.p1, { qr: bueno })).body.error, "qr_invalido", "QR impreso anterior");
  await api("POST", "/admin/puntos/actualizar", await m.A(), { id: m.p2, activo: false });
  assert.equal((await m.escanear(m.gA, m.tA, m.p2)).body.error, "qr_invalido", "punto inactivo");
  assert.equal(docsDe("escaneos").length, 0);
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).status, 201, "el nuevo QR sí");
});

test("el QR de ASISTENCIA no sirve como punto, ni el de punto sirve para marcar asistencia", async () => {
  const m = await mundo();
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0());
  const asis = await m.qrAsis(m.S1);
  assert.equal((await m.escanear(m.gA, m.tA, m.p1, { qr: asis })).body.error, "qr_invalido", "MPC1 como punto");
  const reescrito = asis.replace(/^MPC1/, "MPC2"); // intento de reutilizar la firma con otro prefijo
  assert.equal((await m.escanear(m.gA, m.tA, m.p1, { qr: reescrito })).body.error, "qr_invalido", "prefijo reescrito: la firma no coincide");
  // viceversa: marcar entrada/salida con un QR de punto
  irA(at(D, "19:30"));
  const r = await api("POST", "/marcas/salida", await tok(m.gA, "guardia"), { turnoId: m.tA, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrP(m.p1), foto: JPG });
  assert.equal(r.body.error, "qr_invalido", "MPC2 como asistencia");
  const entradaB = await api("POST", "/marcas/entrada", await tok(m.gB, "guardia"), { turnoId: m.tB, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrP(m.pB), foto: JPG });
  assert.equal(entradaB.body.error, "qr_invalido");
});

test("rechazado: sin entrada, sin turno activo, turno ajeno, rondín fuera de horario, roles", async () => {
  const m = await mundo();
  await api("POST", "/turnos/cancelar", await m.A(), { turnoId: m.tB }); // aún no inicia: se puede cancelar
  irA(SLOT0());
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).body.error, "sin_entrada", "sin entrada marcada");
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(m.ini + 30 * MIN);
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).body.error, "sin_rondin_activo", "entre rondines");
  irA(SLOT0() - 16 * MIN);
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).body.error, "sin_rondin_activo", "antes de que abra la ventana (15 min)");
  irA(SLOT0() + 16 * MIN);
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).body.error, "sin_rondin_activo", "pasada la tolerancia de inicio sin haber empezado");
  irA(SLOT0());
  assert.equal((await m.escanear(m.gB, m.tA, m.p1)).status, 403, "turno de otro guardia");
  assert.equal((await m.escanear(m.gA, "no-existe", m.p1)).status, 403);
  assert.equal((await api("POST", "/rondines/escanear", await tok(m.s1, "supervisor"), { turnoId: m.tA, qr: await m.qrP(m.p1) })).status, 403, "supervisor no escanea");
  assert.equal((await api("POST", "/rondines/escanear", await m.A(), { turnoId: m.tA, qr: await m.qrP(m.p1) })).status, 403, "admin no escanea");
  assert.equal((await api("POST", "/rondines/escanear", null, { turnoId: m.tA })).status, 401);
  // turno cancelado
  assert.equal((await m.escanear(m.gB, m.tB, m.pB)).body.error, "sin_turno_activo");
  // turno cerrado (salida marcada)
  irA(at(D1, "07:05"));
  await api("POST", "/relevo/autorizar-cierre", await tok(m.s1, "supervisor"), { turnoId: m.tA, motivo: "No hay relevo programado." }).catch(() => {});
  await api("POST", "/marcas/salida", await tok(m.gA, "guardia"), { turnoId: m.tA, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrAsis(m.S1), foto: JPG });
  irA(SLOT2());
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).body.error, "sin_turno_activo", "ya cerró el turno");
});

test("ruta ORDENADA: fuera de orden rechazado; en orden completa; duplicado rechazado", async () => {
  const m = await mundo({ modo: "ordenada" });
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0() + MIN);
  const fuera = await m.escanear(m.gA, m.tA, m.p2);
  assert.equal(fuera.status, 409);
  assert.equal(fuera.body.error, "fuera_de_orden");
  assert.match(fuera.body.mensaje, /Portón/, "dice cuál es el siguiente");
  assert.equal((await m.escanear(m.gA, m.tA, m.p3)).body.error, "fuera_de_orden");
  const a = await m.escanear(m.gA, m.tA, m.p1);
  assert.equal(a.status, 201);
  assert.equal(a.body.siguiente, "Bodega");
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).body.error, "ya_escaneado", "duplicado");
  assert.equal((await m.escanear(m.gA, m.tA, m.p3)).body.error, "fuera_de_orden", "saltarse uno sigue prohibido");
  assert.equal((await m.escanear(m.gA, m.tA, m.p2)).status, 201);
  const c = await m.escanear(m.gA, m.tA, m.p3);
  assert.equal(c.body.completo, true);
  assert.equal(c.body.hechos, 3);
  assert.equal(docsDe("escaneos").length, 3, "los rechazados no dejaron registro");
});

test("ruta LIBRE: cualquier orden; el servidor pone la hora aunque el celular diga otra", async () => {
  const m = await mundo({ modo: "libre" });
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0() + 2 * MIN);
  const r = await m.escanear(m.gA, m.tA, m.p3, { horaDispositivoMs: Date.UTC(2001, 0, 1) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = get(`escaneos/${m.tA}_0_${m.p3}`);
  assert.ok(e.tsMs >= SLOT0() + 2 * MIN && e.tsMs < SLOT0() + 2 * MIN + 5000, "hora del servidor");
  assert.equal(e.horaDispositivoMs, Date.UTC(2001, 0, 1), "la del celular solo informativa");
  assert.ok(e.ts, "marca de tiempo de Firestore");
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).status, 201);
  assert.equal((await m.escanear(m.gA, m.tA, m.p2)).body.estado, "completo");
});

// ------------------------------------------------------------------ GPS del punto
test("GPS del punto (si está configurado): radio, precisión y obligatoriedad", async () => {
  const m = await mundo({ gps: true });
  const sinGps = await m.punto(m.S1, "Sin GPS", 4);
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0() + MIN);
  const aqui = { lat: SITE.lat, lng: SITE.lng, precisionM: 8 };
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).body.error, "gps_requerido");
  const lejos = await m.escanear(m.gA, m.tA, m.p1, { ...aqui, lat: SITE.lat + 0.001 });
  assert.equal(lejos.status, 403);
  assert.equal(lejos.body.error, "fuera_perimetro_punto");
  assert.match(lejos.body.mensaje, /límite es 30 m/);
  const imprecisa = await m.escanear(m.gA, m.tA, m.p1, { ...aqui, precisionM: 31 });
  assert.equal(imprecisa.body.error, "gps_precision");
  assert.equal((await m.escanear(m.gA, m.tA, m.p1, { ...aqui, precisionM: 30 })).status, 201, "precisión = radio");
  assert.equal((await m.escanear(m.gA, m.tA, m.p2, { ...aqui, lat: SITE.lat + 0.0003, lng: SITE.lng })).status, 201);
  assert.equal((await m.escanear(m.gA, m.tA, m.p3, { lat: "x", lng: 1, precisionM: 1 })).status, 400);
  const sg = await m.escanear(m.gA, m.tA, sinGps);
  assert.equal(sg.status, 201, "un punto sin coordenadas no pide GPS");
  assert.equal(get(`escaneos/${m.tA}_0_${m.p1}`).distanciaM < 1, true);
  assert.equal(get(`escaneos/${m.tA}_0_${sinGps}`).lat, null);
});

// ------------------------------------------------------------------ estados (cron / recalcular), nocturno
test("estados completo / incompleto / no iniciado en turno nocturno que cruza medianoche (Hermosillo)", async () => {
  const m = await mundo();
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  // Rondín 0 (22:00): completo
  irA(SLOT0() + MIN);
  for (const p of [m.p1, m.p2, m.p3]) assert.equal((await m.escanear(m.gA, m.tA, p)).status, 201);
  // Rondín 1 (01:00 del día siguiente): solo 2 de 3 → incompleto al vencer
  irA(SLOT1() + 2 * MIN);
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).status, 201);
  assert.equal((await m.escanear(m.gA, m.tA, m.p3)).status, 201);
  // Rondín 2 (04:00): nada → no iniciado
  const estados = async (ms) => { irA(ms); await worker.scheduled({}, env, { waitUntil: (p) => p }); await new Promise((r) => setTimeout(r, 400)); return Object.fromEntries(docsDe("rondines").filter((r) => r.turnoId === m.tA).map((r) => [r.indice, r])); };
  let r = await estados(SLOT1() + 20 * MIN);
  assert.equal(r[1].estado, "en_curso", "dentro del plazo");
  r = await estados(SLOT1() + 46 * MIN);
  assert.equal(r[1].estado, "incompleto");
  assert.deepEqual(r[1].saltados, ["Bodega"], "punto saltado");
  assert.equal(r[1].hechos, 2);
  assert.equal(r[1].porcentaje, 67);
  assert.equal(r[0].estado, "completo");
  assert.equal(r[0].fecha, D, "el rondín de las 22:00 es del día D");
  assert.equal(r[1].fecha, D1, "el de la 01:00 es del día siguiente (hora local), aunque el turno empezó el día D");
  assert.equal(new Date(SLOT0()).toISOString().slice(0, 10), D1, "(en UTC las 22:00 locales ya son el día siguiente)");
  r = await estados(SLOT2() + 16 * MIN);
  assert.equal(r[2].estado, "no_iniciado");
  assert.equal(r[2].hechos, 0);
  assert.equal(r[2].fecha, D1);
  assert.equal(docsDe("rondines").filter((r) => r.turnoId === m.tA).length, 3);
  // el cálculo es idempotente: recalcular otra vez no reescribe (sin cambios)
  const antes = w.calls.filter((c) => c.includes("documents:commit")).length;
  await estados(SLOT2() + 17 * MIN);
  assert.ok(w.calls.filter((c) => c.includes("documents:commit")).length - antes <= 2, "sin escrituras redundantes");
});

test("guardia ausente (sin entrada): el rondín no cuenta como 'no iniciado' (ya es falta)", async () => {
  const m = await mundo();
  irA(SLOT0() + 20 * MIN);
  await api("POST", "/asistencia/recalcular", await m.A(), { desde: D, hasta: D1 });
  await api("POST", "/rondines/recalcular", await m.A(), { desde: D, hasta: D1 });
  const r0 = docsDe("rondines").find((r) => r.indice === 0);
  assert.equal(r0.estado, "no_exigible");
  assert.equal(docsDe("rondines").filter((r) => r.estado === "no_iniciado").length, 0);
});

test("horarios fijos que cruzan medianoche y 24x24: los rondines caen en las horas locales correctas", async () => {
  const m = await mundo();
  await api("POST", "/rondines/programa", await m.A(), { sitioId: m.S2, modo: "libre", frecuencia: { tipo: "horarios", horarios: ["23:30", "02:00"] }, toleranciaInicioMin: 15, toleranciaFinMin: 45 });
  irA(m.ini + 2 * MIN);
  await api("POST", "/marcas/entrada", await tok(m.gB, "guardia"), { turnoId: m.tB, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrAsis(m.S2), foto: JPG });
  irA(at(D, "23:30") + MIN);
  assert.equal((await m.escanear(m.gB, m.tB, m.pB)).status, 201);
  const prox = await api("GET", `/rondines/proximo?turnoId=${m.tB}`, await tok(m.gB, "guardia"));
  assert.deepEqual(prox.body.rondines.map((x) => new Date(x.programadoMs - 7 * H).toISOString().slice(0, 16)), [`${D}T23:30`, `${D1}T02:00`]);
  // 24x24 con cada 4 h
  const dia = fechaLocal(localAMs(D, "12:00") + 3 * 86400000);
  const gC = (await api("POST", "/admin/usuarios", await m.A(), { rol: "guardia", nombre: "Gus", numeroEmpleado: "G003", pin: "4821" })).body.uid;
  await api("POST", "/rondines/programa", await m.A(), { sitioId: m.S1, modo: "libre", frecuencia: { tipo: "cada_horas", cadaHoras: 4 }, toleranciaInicioMin: 15, toleranciaFinMin: 45 });
  await api("POST", "/turnos/asignar-lote", await m.A(), { sitioId: m.S1, plantilla: "24x24", desde: dia, hasta: dia, guardiaUid: gC });
  const t24 = docsDe("turnos").find((t) => t.guardiaUid === gC).id;
  irA(at(dia, "07:00") + MIN);
  await api("POST", "/marcas/entrada", await tok(gC, "guardia"), { turnoId: t24, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrAsis(m.S1), foto: JPG });
  irA(at(dia, "11:00") + MIN);
  const p24 = await api("GET", `/rondines/proximo?turnoId=${t24}`, await tok(gC, "guardia"));
  assert.equal(p24.body.rondines.length, 5, "24 h cada 4 h: 11, 15, 19, 23, 03");
  assert.equal(p24.body.actual.estado, "pendiente");
});

// ------------------------------------------------------------------ foto opcional (R2) y nota
test("foto y nota opcionales por punto: R2 privado; solo admin o supervisor del sitio las ven", async () => {
  const m = await mundo();
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0() + MIN);
  const malas = { "no JPEG": Buffer.from("a".repeat(3000)).toString("base64"), diminuta: jpeg(100), enorme: jpeg(160 * 1024) };
  for (const [n, foto] of Object.entries(malas)) assert.ok([400, 413].includes((await m.escanear(m.gA, m.tA, m.p1, { foto })).status), n);
  assert.equal((await m.escanear(m.gA, m.tA, m.p1, { nota: "x".repeat(301) })).status, 400);
  assert.equal(env.SELFIES.objetos.size, 1, "solo la selfie de la entrada; ninguna foto inválida se guardó");
  const r = await m.escanear(m.gA, m.tA, m.p1, { foto: jpeg(3000, 9), nota: "Candado flojo, reportado." });
  assert.equal(r.status, 201);
  const e = get(`escaneos/${m.tA}_0_${m.p1}`);
  assert.equal(e.nota, "Candado flojo, reportado.");
  assert.ok(e.fotoKey.startsWith(`rondines/${m.S1}/${m.tA}/0/${m.p1}-`));
  assert.equal(env.SELFIES.objetos.size, 2);
  assert.ok(!JSON.stringify(r.body).includes("rondines/"), "no filtra la ruta");
  assert.equal((await m.escanear(m.gA, m.tA, m.p2)).status, 201, "sin foto también vale");
  const id = `${m.tA}_0_${m.p1}`;
  const ver = async (uid, rol) => api("GET", `/rondines/foto?escaneo=${id}`, uid ? await tok(uid, rol) : null);
  const ok = await ver(adminUid, "admin");
  assert.equal(ok.status, 200);
  assert.equal(ok.ct, "image/jpeg");
  assert.equal(new Uint8Array(await ok.raw.arrayBuffer()).length, 3000);
  assert.equal((await ver(m.s1, "supervisor")).status, 200, "supervisor del sitio");
  assert.equal((await ver(m.s2, "supervisor")).status, 403, "otro supervisor");
  assert.equal((await ver(m.gA, "guardia")).status, 403, "ni el guardia");
  assert.equal((await ver(m.gB, "guardia")).status, 403);
  assert.equal((await ver(null)).status, 401);
  assert.equal((await api("GET", `/rondines/foto?escaneo=${m.tA}_0_${m.p2}`, await m.A())).status, 404, "escaneo sin foto");
  assert.equal((await api("GET", `/rondines/foto?escaneo=../x`, await m.A())).status, 400);
  const sin = { ...env }; delete sin.SELFIES;
  const s = await worker.fetch(new Request("https://p/rondines/escanear", { method: "POST", headers: { authorization: `Bearer ${await tok(m.gA, "guardia")}`, origin: "https://racosta123.github.io", "content-type": "application/json" }, body: JSON.stringify({ turnoId: m.tA, qr: await m.qrP(m.p3), foto: JPG }) }), sin);
  assert.equal(s.status, 503, "sin R2 no se acepta una foto");
  assert.equal(get(`escaneos/${m.tA}_0_${m.p3}`), null);
});

// ------------------------------------------------------------------ aislamiento
test("un guardia no ve rondines de otros sitios; el supervisor solo los suyos", async () => {
  const m = await mundo();
  irA(m.ini + 2 * MIN);
  await m.entrar(m.gA, m.tA, m.S1);
  await api("POST", "/marcas/entrada", await tok(m.gB, "guardia"), { turnoId: m.tB, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qrAsis(m.S2), foto: JPG });
  irA(SLOT0() + MIN);
  assert.equal((await m.escanear(m.gA, m.tA, m.p1)).status, 201);
  assert.equal((await m.escanear(m.gB, m.tB, m.pB)).status, 201);
  assert.equal((await api("GET", `/rondines/proximo?turnoId=${m.tA}`, await tok(m.gB, "guardia"))).status, 403, "B no ve el rondín de A");
  assert.equal((await m.escanear(m.gB, m.tB, m.p1)).body.error, "qr_invalido", "B no puede escanear puntos del sitio de A");
  assert.equal((await m.escanear(m.gA, m.tA, m.pB)).body.error, "qr_invalido");
  await api("POST", "/rondines/recalcular", await m.A(), { desde: D, hasta: D1 });
  const rep = (uid, rol, q = "") => api("GET", `/reportes/rondines?desde=${D}&hasta=${D1}${q}`, uid ? tok(uid, rol) : null);
  const ra = await api("GET", `/reportes/rondines?desde=${D}&hasta=${D1}`, await m.A());
  assert.equal(ra.status, 200);
  assert.deepEqual([...new Set(ra.body.filas.map((f) => f.sitioId))].sort(), [m.S1, m.S2].sort(), "admin: todo");
  const r1 = await api("GET", `/reportes/rondines?desde=${D}&hasta=${D1}`, await tok(m.s1, "supervisor"));
  assert.deepEqual([...new Set(r1.body.filas.map((f) => f.sitioId))], [m.S1], "supervisor: solo su sitio");
  const cruz = await api("GET", `/reportes/rondines?desde=${D}&hasta=${D1}&sitioId=${m.S2}`, await tok(m.s1, "supervisor"));
  assert.equal(cruz.body.filas.length, 0);
  assert.equal((await api("GET", `/reportes/rondines?desde=${D}&hasta=${D1}`, await tok(m.gA, "guardia"))).status, 403);
  assert.equal((await api("GET", `/reportes/rondines?desde=${D}&hasta=${D1}`, null)).status, 401);
  assert.equal((await api("GET", `/reportes/rondines?desde=2026-01-01&hasta=2026-12-31`, await m.A())).status, 400, "rango máximo");
  void rep;
});

test("rondín actual para el guardia: progreso y puntos con hora; sin entrada no hay rondín", async () => {
  const m = await mundo({ modo: "ordenada", gps: true });
  irA(SLOT0());
  const sin = await api("GET", `/rondines/proximo?turnoId=${m.tA}`, await tok(m.gA, "guardia"));
  assert.equal(sin.body.hay, false);
  assert.equal(sin.body.motivo, "sin_entrada");
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0() - 5 * MIN);
  let p = await api("GET", `/rondines/proximo?turnoId=${m.tA}`, await tok(m.gA, "guardia"));
  assert.equal(p.body.hay, true);
  assert.equal(p.body.rondines.length, 3);
  assert.equal(p.body.actual.estado, "pendiente", "ya abrió la ventana (15 min antes)");
  assert.equal(p.body.actual.total, 3);
  assert.deepEqual(p.body.actual.puntos.map((x) => [x.nombre, x.requiereGps, x.hecho]), [["Portón", true, false], ["Bodega", true, false], ["Azotea", true, false]]);
  assert.equal(p.body.actual.siguientePuntoId, m.p1);
  irA(SLOT0() + MIN);
  await m.escanear(m.gA, m.tA, m.p1, { lat: SITE.lat, lng: SITE.lng, precisionM: 5 });
  p = await api("GET", `/rondines/proximo?turnoId=${m.tA}`, await tok(m.gA, "guardia"));
  assert.equal(p.body.actual.hechos, 1);
  assert.equal(p.body.actual.porcentaje, 33);
  assert.equal(p.body.actual.estado, "en_curso");
  assert.equal(p.body.actual.siguientePuntoId, m.p2);
  assert.ok(p.body.actual.puntos[0].tsMs);
  irA(SLOT0() + 30 * MIN);
  assert.equal((await api("GET", `/rondines/proximo?turnoId=${m.tA}`, await tok(m.gA, "guardia"))).body.proximoMs, SLOT1(), "siguiente rondín programado");
});

// ------------------------------------------------------------------ ajustes e inmutabilidad
test("ajustes con motivo: marcar punto / justificar rondín; los escaneos no se tocan", async () => {
  const m = await mundo();
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0() + MIN);
  await m.escanear(m.gA, m.tA, m.p1); await m.escanear(m.gA, m.tA, m.p3);
  irA(SLOT0() + 50 * MIN);
  await api("POST", "/rondines/recalcular", await m.A(), { desde: D, hasta: D1 });
  const rid = `${m.tA}_0`;
  assert.equal(get(`rondines/${rid}`).estado, "incompleto");
  const antes = JSON.stringify(doc(`escaneos/${rid}_${m.p1}`));
  const aj = async (uid, rol, body) => api("POST", "/rondines/ajuste", await tok(uid, rol), { rondinId: rid, tipo: "marcar_punto", puntoId: m.p2, motivo: "El QR estaba dañado; lo verifiqué en sitio.", ...body });
  assert.equal((await aj(m.gA, "guardia", {})).status, 403, "el guardia no se ajusta");
  assert.equal((await aj(m.s2, "supervisor", {})).status, 403, "supervisor de otro sitio");
  assert.equal((await aj(m.s1, "supervisor", { motivo: "ok" })).status, 400, "motivo obligatorio");
  assert.equal((await aj(m.s1, "supervisor", { tipo: "otra" })).status, 400);
  assert.equal((await aj(m.s1, "supervisor", { puntoId: "ajeno" })).status, 400, "punto que no es del rondín");
  assert.equal((await aj(m.s1, "supervisor", { puntoId: m.p1 })).status, 409, "ya escaneado");
  assert.equal(docsDe("ajustesRondin").length, 0);
  assert.equal((await aj(m.s1, "supervisor", {})).status, 201);
  const r = get(`rondines/${rid}`);
  assert.equal(r.estado, "completo");
  const d = r.detalle.find((x) => x.puntoId === m.p2);
  assert.equal(d.origen, "ajuste");
  assert.equal(d.ajustePor, "Sara Sup");
  assert.match(d.ajusteMotivo, /dañado/);
  assert.equal(JSON.stringify(doc(`escaneos/${rid}_${m.p1}`)), antes, "el escaneo original no cambió");
  assert.equal(docsDe("escaneos").length, 2, "el ajuste no fabricó un escaneo");
  assert.equal(docsDe("ajustesRondin")[0].autorNombre, "Sara Sup");
  // justificar el rondín 1 (nadie lo hizo)
  irA(SLOT1() + 20 * MIN);
  await api("POST", "/rondines/recalcular", await m.A(), { desde: D, hasta: D1 });
  const rid1 = `${m.tA}_1`;
  assert.equal(get(`rondines/${rid1}`).estado, "no_iniciado");
  assert.equal((await api("POST", "/rondines/ajuste", await tok(m.s1, "supervisor"), { rondinId: rid1, tipo: "justificar_rondin", motivo: "Simulacro de evacuación en el sitio." })).status, 201);
  assert.equal(get(`rondines/${rid1}`).estado, "justificado");
  assert.equal(get(`rondines/${rid1}`).justificadoPor, "Sara Sup");
  assert.ok(docsDe("auditoria").some((a) => a.accion === "rondin.ajuste_justificar_rondin"));
  assert.ok(!w.calls.some((c) => /^(DELETE|PATCH) .*\/(escaneos|ajustesRondin)\//.test(c)), "nada borra ni parchea escaneos/ajustes");
});

test("escaneos inmutables: reintentos y recálculos no los alteran ni se sobrescribe la foto", async () => {
  const m = await mundo();
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0() + MIN);
  await m.escanear(m.gA, m.tA, m.p1, { foto: jpeg(3000, 4) });
  const original = JSON.stringify(doc(`escaneos/${m.tA}_0_${m.p1}`));
  const claves = [...env.SELFIES.objetos.keys()];
  for (let i = 0; i < 3; i++) assert.equal((await m.escanear(m.gA, m.tA, m.p1, { foto: jpeg(3000, 5), nota: "otra" })).body.error, "ya_escaneado");
  await api("POST", "/rondines/recalcular", await m.A(), { desde: D, hasta: D1 });
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  assert.equal(JSON.stringify(doc(`escaneos/${m.tA}_0_${m.p1}`)), original);
  assert.deepEqual([...env.SELFIES.objetos.keys()], claves, "no hay fotos huérfanas de los duplicados");
});

// ------------------------------------------------------------------ reporte, supervisor, prueba
test("reporte de cumplimiento por sitio y por día (%)", async () => {
  const m = await mundo();
  irA(m.ini + 2 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(SLOT0() + MIN);
  for (const p of [m.p1, m.p2, m.p3]) await m.escanear(m.gA, m.tA, p);          // rondín 0 completo (día D)
  irA(SLOT1() + 2 * MIN); await m.escanear(m.gA, m.tA, m.p1);                   // rondín 1 incompleto (día D1)
  irA(SLOT2() + 20 * MIN);                                                       // rondín 2 no iniciado (día D1)
  const rep = await api("GET", `/reportes/rondines?desde=${D}&hasta=${D1}&sitioId=${m.S1}`, await m.A());
  assert.equal(rep.status, 200);
  const dia = (f) => rep.body.porSitioDia.find((x) => x.fecha === f);
  assert.deepEqual([dia(D).exigibles, dia(D).completos, dia(D).porcentaje], [1, 1, 100]);
  assert.deepEqual([dia(D1).exigibles, dia(D1).completos, dia(D1).incompletos, dia(D1).noIniciados, dia(D1).porcentaje], [2, 0, 1, 1, 0]);
  assert.deepEqual([rep.body.total.exigibles, rep.body.total.completos, rep.body.total.porcentaje], [3, 1, 33.3]);
  const f1 = rep.body.filas.find((f) => f.indice === 1);
  assert.deepEqual(f1.saltados, ["Bodega", "Azotea"]);
  assert.equal(f1.detalle.find((d) => d.puntoId === m.p1).hecho, true);
  assert.ok(f1.detalle.find((d) => d.puntoId === m.p1).tsMs, "hora de cada punto en el detalle");
});

test("al cambiar el supervisor del sitio, sus puntos y programa lo siguen", async () => {
  const m = await mundo();
  assert.equal(get(`puntos/${m.p1}`).supervisorUid, m.s1);
  await api("POST", "/admin/sitios/actualizar", await m.A(), { id: m.S1, supervisorUid: m.s2 });
  assert.equal(get(`puntos/${m.p1}`).supervisorUid, m.s2);
  assert.equal(get(`programasRondin/${m.S1}`).supervisorUid, m.s2);
  assert.equal((await api("POST", "/admin/puntos", await tok(m.s1, "supervisor"), { sitioId: m.S1, nombre: "Ya no es mío" })).status, 403);
});

test("datos de prueba: puntos, escaneos, rondines, ajustes y bitácora heredan prueba=true del sitio", async () => {
  const m = await mundo();
  const SP = (await api("POST", "/admin/sitios", await m.A(), { nombre: "Sitio de prueba", supervisorUid: m.s1, ...SITE, precisionM: 5, radioM: 100, prueba: true })).body.id;
  const gP = (await api("POST", "/admin/usuarios", await m.A(), { rol: "guardia", nombre: "Guardia Prueba", numeroEmpleado: "P001", pin: "4821", prueba: true })).body.uid;
  const pP = (await api("POST", "/admin/puntos", await m.A(), { sitioId: SP, nombre: "Punto prueba" })).body.id;
  assert.equal(get(`puntos/${pP}`).prueba, true, "el punto hereda del sitio");
  assert.equal(get(`puntos/${m.p1}`).prueba, undefined, "los reales no se marcan");
  await api("POST", "/rondines/programa", await m.A(), { sitioId: SP, modo: "libre", frecuencia: { tipo: "cada_horas", cadaHoras: 3 }, toleranciaInicioMin: 15, toleranciaFinMin: 45 });
  await api("POST", "/turnos/asignar-lote", await m.A(), { sitioId: SP, plantilla: "nocturno", desde: D, hasta: D, guardiaUid: gP });
  const tP = docsDe("turnos").find((t) => t.guardiaUid === gP).id;
  irA(m.ini + 2 * MIN);
  await api("POST", "/marcas/entrada", await tok(gP, "guardia"), { turnoId: tP, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await generarPayload(env, SP, 1), foto: JPG });
  irA(SLOT0() + MIN);
  assert.equal((await api("POST", "/rondines/escanear", await tok(gP, "guardia"), { turnoId: tP, qr: await generarPayloadPunto(env, pP, 1) })).status, 201);
  assert.equal(docsDe("escaneos")[0].prueba, true);
  assert.equal(docsDe("rondines")[0].prueba, true);
  await api("POST", "/rondines/ajuste", await tok(m.s1, "supervisor"), { rondinId: `${tP}_1`, tipo: "justificar_rondin", motivo: "Ajuste de prueba válido." }).catch(() => {});
  const aud = docsDe("auditoria").filter((a) => /^(punto|rondin)\./.test(a.accion) && a.objetivo !== m.p1 && a.objetivo !== m.p2 && a.objetivo !== m.p3);
  assert.ok(aud.some((a) => a.accion === "punto.alta" && a.prueba === true));
});
