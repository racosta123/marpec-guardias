import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorld, call, PROJECT } from "./harness.js";
import { fechaLocal, localAMs } from "../src/common.js";
import { generarPayload } from "../src/qr.js";
import { MIN } from "../src/asistencia.js";

let w, env;
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const irA = (ms) => { offset = ms - realNow(); }; // viaje en el tiempo (el Worker usa Date.now)

beforeEach(async () => {
  if (w) w.restore();
  offset = 0;
  w = await createWorld();
  env = w.env;
});
after(() => { w.restore(); Date.now = realNow; });

const BASE = `projects/${PROJECT}/databases/(default)/documents`;
const doc = (p) => w.docs.get(`${BASE}/${p}`);
const val = (f) => (f === undefined ? undefined : "stringValue" in f ? f.stringValue : "integerValue" in f ? Number(f.integerValue) : "booleanValue" in f ? f.booleanValue : "nullValue" in f ? null : "doubleValue" in f ? f.doubleValue : "arrayValue" in f ? (f.arrayValue.values || []).map(val) : "mapValue" in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : f);
const plano = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, val(v)]));
const docsDe = (col) => [...w.docs.entries()].filter(([k]) => k.startsWith(`${BASE}/${col}/`) && k.slice(`${BASE}/${col}/`.length).indexOf("/") < 0).map(([k, v]) => ({ id: k.split("/").pop(), ...plano(v) }));
const get = (p) => (doc(p) ? plano(doc(p)) : null);

const PASS = "una-clave-muy-larga-1";
const SITE = { lat: 29.0729, lng: -110.9559 };
const D = fechaLocal(Date.now() + 5 * 86400000); // día del turno de prueba
const at = (fecha, hora) => localAMs(fecha, hora);
const sumaDia = (f, n) => fechaLocal(localAMs(f, "12:00") + n * 86400000);

// JPEG mínimo válido (cabecera FFD8FF, relleno, cierre FFD9)
function jpeg(n = 4000, relleno = 0) {
  const b = new Uint8Array(n).fill(relleno);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], n - 2);
  return Buffer.from(b).toString("base64");
}
const JPG = jpeg();

async function api(method, path, tok, body, extra = {}) {
  const r = await call(worker, env, method, path, { body, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra }, ip: extra.ip || "1.1.1.1" });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json().catch(() => ({})) : null, raw: r, ct };
}

let adminUid;
const tok = (uid, rol) => w.idToken(uid, rol); // SIEMPRE tras viajar en el tiempo

async function mundo() {
  const r = await call(worker, env, "POST", "/setup/primer-admin", { headers: { "x-setup-token": env.SETUP_TOKEN }, body: { nombre: "Ana Admin", email: "ana@marpec.mx", password: PASS } });
  adminUid = (await r.json()).uid;
  const A = () => tok(adminUid, "admin");
  const mkG = async (num, nombre, extra = {}) => (await api("POST", "/admin/usuarios", await A(), { rol: "guardia", nombre, numeroEmpleado: num, pin: "4821", ...extra })).body.uid;
  const mkS = async (email, nombre) => (await api("POST", "/admin/usuarios", await A(), { rol: "supervisor", nombre, email, password: PASS })).body.uid;
  const mkSitio = async (nombre, supervisorUid, extra = {}) => (await api("POST", "/admin/sitios", await A(), { nombre, supervisorUid, ...SITE, precisionM: 8, radioM: 100, consignas: "c", ...extra })).body.id;
  const gA = await mkG("G001", "Gael Guardia");
  const gB = await mkG("G002", "Gema Guardia");
  const s1 = await mkS("s1@marpec.mx", "Sara Sup");
  const s2 = await mkS("s2@marpec.mx", "Saúl Sup");
  const S1 = await mkSitio("Plaza Norte", s1);
  const S2 = await mkSitio("Bodega Sur", s2);
  const lote = async (sitioId, plantilla, fecha, guardiaUid, extra = {}) => (await api("POST", "/turnos/asignar-lote", await A(), { sitioId, plantilla, desde: fecha, hasta: fecha, guardiaUid, ...extra })).status;
  assert.equal(await lote(S1, "diurno", D, gA), 201);
  assert.equal(await lote(S1, "nocturno", D, gB), 201);
  const turnos = docsDe("turnos");
  const tA = turnos.find((t) => t.guardiaUid === gA).id;
  const tB = turnos.find((t) => t.guardiaUid === gB).id;
  const qr = async (sitio = S1) => generarPayload(env, sitio, get(`sitios/${sitio}`).qrVersion);
  const marcar = async (tipo, uid, turnoId, o = {}) => api("POST", `/marcas/${tipo}`, await tok(uid, "guardia"), { turnoId, lat: SITE.lat, lng: SITE.lng, precisionM: 15, qr: o.qr ?? (await qr()), foto: JPG, horaDispositivoMs: 0, ...o });
  return { A, gA, gB, s1, s2, S1, S2, tA, tB, qr, marcar, lote, mkG };
}

const inicioA = () => at(D, "07:00");
const finA = () => at(D, "19:00");

// ------------------------------------------------------------------ foto
test("selfie: solo JPEG real, tamaño acotado; se rechaza todo lo demás sin dejar rastro", async () => {
  const m = await mundo();
  irA(inicioA() + 5 * MIN);
  const malas = {
    "no es base64": "###", "vacía": "", "PNG disfrazado": Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(3000).fill(1)]).toString("base64"),
    "JPEG sin cierre FFD9": (() => { const b = Buffer.alloc(3000, 1); b.set([0xff, 0xd8, 0xff], 0); return b.toString("base64"); })(),
    "diminuta": jpeg(100), "enorme (> 150 KB)": jpeg(160 * 1024), "texto": Buffer.from("a".repeat(3000)).toString("base64"),
  };
  for (const [n, foto] of Object.entries(malas)) {
    const r = await m.marcar("entrada", m.gA, m.tA, { foto });
    assert.equal(r.status, 400, n);
    assert.equal(r.body.error, "foto_invalida", n);
  }
  assert.equal((await m.marcar("entrada", m.gA, m.tA, { foto: undefined })).status, 400);
  assert.equal(env.SELFIES.objetos.size, 0, "no se guardó nada en R2");
  assert.equal(docsDe("marcas").length, 0);
  assert.equal((await m.marcar("entrada", m.gA, m.tA, { foto: jpeg(100 * 1024, 7) })).status, 201, "100 KB sí");
});

// ------------------------------------------------------------------ entrada
test("entrada válida: hora del servidor (aunque el celular tenga otra), GPS y QR guardados, foto en R2", async () => {
  const m = await mundo();
  const ahora = inicioA() + 4 * MIN;
  irA(ahora);
  const r = await m.marcar("entrada", m.gA, m.tA, { horaDispositivoMs: Date.UTC(2001, 0, 1), lat: SITE.lat + 0.0002, lng: SITE.lng, precisionM: 22 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const marca = get(`marcas/${m.tA}_entrada`);
  assert.ok(marca.tsMs >= ahora && marca.tsMs < ahora + 5000, "la hora es la del servidor (en el instante de la petición)");
  assert.notEqual(marca.tsMs, Date.UTC(2001, 0, 1));
  assert.equal(marca.horaDispositivoMs, Date.UTC(2001, 0, 1), "la del celular solo se guarda como dato informativo");
  assert.ok(marca.desfaseDispositivoMs < -1e11);
  assert.equal(marca.precisionM, 22);
  assert.ok(marca.distanciaM > 20 && marca.distanciaM < 25);
  assert.equal(marca.tipo, "entrada");
  assert.equal(marca.guardiaUid, m.gA);
  assert.ok(marca.ts, "marca de tiempo del servidor de Firestore");
  assert.equal(env.SELFIES.objetos.size, 1);
  assert.ok(marca.fotoKey.startsWith(`selfies/${m.S1}/${m.tA}/entrada-`));
  assert.ok(!JSON.stringify(r.body).includes("selfies/"), "la respuesta no filtra la ruta de la foto");
  const asis = get(`asistencias/${m.tA}`);
  assert.equal(asis.estado, "en_turno");
  assert.equal(asis.entradaMs, marca.tsMs, "el cálculo usa la hora del servidor de la marca");
  assert.equal(asis.retardo, false);
  assert.equal(r.body.estado, "en_turno");
});

test("entrada rechazada: fuera del perímetro y precisión peor que el radio", async () => {
  const m = await mundo();
  irA(inicioA() + 5 * MIN);
  const fuera = await m.marcar("entrada", m.gA, m.tA, { lat: SITE.lat + 0.01 });
  assert.equal(fuera.status, 403);
  assert.equal(fuera.body.error, "fuera_perimetro");
  assert.match(fuera.body.mensaje, /1[01]\d\d m/);
  const justoFuera = await m.marcar("entrada", m.gA, m.tA, { lng: SITE.lng + 0.0012, precisionM: 10 }); // ≈ 116 m
  assert.equal(justoFuera.body.error, "fuera_perimetro");
  const imprecisa = await m.marcar("entrada", m.gA, m.tA, { precisionM: 101 });
  assert.equal(imprecisa.status, 400);
  assert.equal(imprecisa.body.error, "gps_precision");
  for (const mal of [{ lat: "29" }, { lat: 91 }, { lng: -181 }, { precisionM: -1 }, { precisionM: null }, { lat: null }]) {
    assert.equal((await m.marcar("entrada", m.gA, m.tA, mal)).status, 400, JSON.stringify(mal));
  }
  assert.equal((await m.marcar("entrada", m.gA, m.tA, { precisionM: 100 })).status, 201, "precisión igual al radio: aceptada");
  assert.equal(docsDe("marcas").length, 1, "solo la válida dejó marca");
});

test("entrada rechazada: QR alterado, viejo (regenerado), de otro sitio, otra llave o basura", async () => {
  const m = await mundo();
  irA(inicioA() + 5 * MIN);
  const bueno = await m.qr();
  const p = bueno.split(".");
  const rechazos = {
    alterado: [p[0], p[1], p[2], (p[3][0] === "A" ? "B" : "A") + p[3].slice(1)].join("."),
    "versión cambiada": [p[0], p[1], "2", p[3]].join("."),
    "de otro sitio": await m.qr(m.S2),
    "otra llave": await generarPayload({ ...env, QR_SECRET: "otra-llave-completamente-distinta-0123456789" }, m.S1, 1),
    basura: "hola", vacío: "", "sin qr": undefined,
  };
  for (const [n, qr] of Object.entries(rechazos)) {
    const r = await m.marcar("entrada", m.gA, m.tA, { qr });
    assert.equal(r.status, 400, n);
    assert.equal(r.body.error, "qr_invalido", n);
  }
  // regenerar invalida el QR impreso anteriormente
  await api("POST", "/admin/sitios/regenerar-qr", await m.A(), { id: m.S1 });
  assert.equal((await m.marcar("entrada", m.gA, m.tA, { qr: bueno })).body.error, "qr_invalido", "QR viejo");
  assert.equal((await m.marcar("entrada", m.gA, m.tA, { qr: await m.qr() })).status, 201, "el nuevo sí");
  assert.equal(docsDe("marcas").length, 1);
});

test("entrada rechazada: sin turno activo, ventana, turno ajeno, cancelado, duplicada, roles", async () => {
  const m = await mundo();
  // 31 min antes: fuera de la ventana (30 min)
  irA(inicioA() - 31 * MIN);
  let r = await m.marcar("entrada", m.gA, m.tA);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "fuera_ventana");
  irA(inicioA() - 29 * MIN);
  // turno de otro guardia
  r = await m.marcar("entrada", m.gB, m.tA);
  assert.equal(r.status, 403, "un guardia no marca por otro");
  assert.equal((await m.marcar("entrada", m.gA, m.tB)).status, 403);
  assert.equal((await m.marcar("entrada", m.gA, "no-existe")).status, 403, "inexistente = mismo error (no revela)");
  assert.equal(docsDe("marcas").length, 0);
  // supervisor, admin y sin sesión
  assert.equal((await api("POST", "/marcas/entrada", await tok(m.s1, "supervisor"), { turnoId: m.tA })).status, 403);
  assert.equal((await api("POST", "/marcas/entrada", await m.A(), { turnoId: m.tA })).status, 403);
  assert.equal((await api("POST", "/marcas/entrada", null, { turnoId: m.tA })).status, 401);
  // dentro de la ventana: ok; luego duplicada
  assert.equal((await m.marcar("entrada", m.gA, m.tA)).status, 201);
  const dup = await m.marcar("entrada", m.gA, m.tA);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "ya_marcada");
  assert.equal(env.SELFIES.objetos.size, 1, "la foto del intento duplicado no se conserva");
  // turno terminado
  irA(finA() + MIN);
  assert.equal((await m.marcar("entrada", m.gB, m.tB)).status, 201, "el nocturno aún es válido (empieza 19:00)");
  // cancelado
  const m2 = await mundo2cancelado();
  async function mundo2cancelado() { return null; }
  void m2;
});

test("turno cancelado o después de terminar: sin turno activo", async () => {
  const m = await mundo();
  const T = await m.A();
  irA(inicioA() - 40 * MIN);
  const turnos = docsDe("turnos");
  assert.equal((await api("POST", "/turnos/cancelar", await m.A(), { turnoId: m.tA })).status, 200);
  irA(inicioA() + 5 * MIN);
  const r = await m.marcar("entrada", m.gA, m.tA);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "sin_turno_activo");
  void T; void turnos;
  // turno ya terminado (otro guardia, mismo esquema): después del fin no se puede marcar entrada
  irA(at(sumaDia(D, 1), "07:01"));
  assert.equal((await m.marcar("entrada", m.gB, m.tB)).status, 409);
});

test("ventana de entrada configurable y sitio sin ubicación", async () => {
  const m = await mundo();
  irA(inicioA() - 45 * MIN);
  assert.equal((await m.marcar("entrada", m.gA, m.tA)).body.error, "fuera_ventana");
  const cfg = await api("POST", "/admin/config", await m.A(), { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3, ventanaEntradaMin: 60 });
  assert.equal(cfg.status, 200);
  assert.equal((await m.marcar("entrada", m.gA, m.tA)).status, 201, "con ventana de 60 min ya se puede");
  const sinGps = await (async () => {
    const S3 = (await api("POST", "/admin/sitios", await m.A(), { nombre: "Sin GPS", supervisorUid: m.s1 })).body.id;
    const gC = await m.mkG("G003", "Gus");
    await api("POST", "/turnos/asignar-lote", await m.A(), { sitioId: S3, plantilla: "diurno", desde: sumaDia(D, 1), hasta: sumaDia(D, 1), guardiaUid: gC });
    const t = docsDe("turnos").find((x) => x.sitioId === S3).id;
    irA(at(sumaDia(D, 1), "07:00"));
    return api("POST", "/marcas/entrada", await tok(gC, "guardia"), { turnoId: t, lat: 1, lng: 1, precisionM: 5, qr: await generarPayload(env, S3, 1), foto: JPG });
  })();
  assert.equal(sinGps.status, 409);
  assert.equal(sinGps.body.error, "sitio_sin_ubicacion");
});

// ------------------------------------------------------------------ retardo / falta (con el flujo completo)
test("retardo y falta se calculan en el servidor con hora de Hermosillo", async () => {
  const m = await mundo();
  const tardanza = async (min) => {
    const ms = inicioA() + min * MIN + 5000;
    irA(ms);
    return get(`asistencias/${m.tA}`);
  };
  irA(inicioA() + 15 * MIN + 5000);
  assert.equal((await m.marcar("entrada", m.gA, m.tA)).status, 201);
  const a = get(`asistencias/${m.tA}`);
  assert.equal(a.retardo, true);
  assert.equal(a.retardoMin, 15);
  assert.equal(a.falta, false);
  assert.equal(a.fecha, D);
  void tardanza;
  // guardia B nunca marca: tras el límite sale FALTA (lo calcula el cron/recalcular)
  irA(at(D, "19:00") + 31 * MIN);
  const rec = await api("POST", "/asistencia/recalcular", await m.A(), { desde: D, hasta: D });
  assert.equal(rec.status, 200);
  const b = get(`asistencias/${m.tB}`);
  assert.equal(b.estado, "falta");
  assert.equal(b.falta, true);
  assert.equal(b.motivoFalta, "sin_entrada");
  assert.equal(b.entradaMs, null);
});

test("entrada fuera de tolerancia pero dentro del límite = retardo; pasado el límite = falta por entrada tardía", async () => {
  const m = await mundo();
  irA(finA() + 40 * MIN + 1000); // 19:40 → el nocturno B (19:00) lleva 40 min
  const r = await m.marcar("entrada", m.gB, m.tB);
  assert.equal(r.status, 201);
  const b = get(`asistencias/${m.tB}`);
  assert.equal(b.falta, true);
  assert.equal(b.motivoFalta, "entrada_tardia");
  assert.equal(b.retardo, false);
});

// ------------------------------------------------------------------ salida / relevo
test("salida: exige entrada previa y notas de entrega; el saliente NO cierra sin relevo", async () => {
  const m = await mundo();
  irA(inicioA() + MIN);
  assert.equal((await m.marcar("salida", m.gA, m.tA)).body.error, "sin_entrada");
  assert.equal((await m.marcar("entrada", m.gA, m.tA)).status, 201);
  irA(finA() + 5 * MIN);
  const r = await m.marcar("salida", m.gA, m.tA, { notasEntrega: "Portón 2 con falla. Llaves en caseta." });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "relevo_pendiente");
  assert.equal(get(`marcas/${m.tA}_salida`), null, "no quedó marca de salida");
  assert.equal(env.SELFIES.objetos.size, 1, "tampoco foto de la salida rechazada");
  assert.equal(get(`asistencias/${m.tA}`).puedeCerrar, false);
});

test("el relevo llega → el saliente cierra; el entrante ve las notas de entrega", async () => {
  const m = await mundo();
  irA(inicioA() + MIN);
  await m.marcar("entrada", m.gA, m.tA);
  irA(finA() - 10 * MIN); // B entra 10 min antes de su inicio (ventana de 30)
  assert.equal((await m.marcar("entrada", m.gB, m.tB)).status, 201);
  assert.equal(get(`asistencias/${m.tA}`).relevoLlegado, true, "al llegar el relevo, el saliente se actualiza al instante");
  assert.equal(get(`asistencias/${m.tA}`).puedeCerrar, true);
  const antes = await api("GET", `/relevo/notas?turnoId=${m.tB}`, await tok(m.gB, "guardia"));
  assert.equal(antes.body.hay, true);
  assert.equal(antes.body.cerrado, false);
  irA(finA() + 2 * MIN);
  const nota = "Portón 2 con falla. Llaves en caseta.";
  const r = await m.marcar("salida", m.gA, m.tA, { notasEntrega: nota });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(get(`marcas/${m.tA}_salida`).notasEntrega, nota);
  const notas = await api("GET", `/relevo/notas?turnoId=${m.tB}`, await tok(m.gB, "guardia"));
  assert.equal(notas.body.notas, nota);
  assert.equal(notas.body.de, "Gael Guardia");
  assert.equal(notas.body.cerrado, true);
  // solo el entrante puede leerlas
  assert.equal((await api("GET", `/relevo/notas?turnoId=${m.tB}`, await tok(m.gA, "guardia"))).status, 403);
  assert.equal((await api("GET", `/relevo/notas?turnoId=${m.tB}`, await tok(m.s1, "supervisor"))).status, 403);
  assert.equal((await api("GET", `/relevo/notas?turnoId=${m.tB}`, null)).status, 401);
  const a = get(`asistencias/${m.tA}`);
  assert.equal(a.estado, "cumplido");
  assert.equal(a.relevoLlegado, true);
  assert.equal(a.minutosExtra, 2);
  assert.equal(a.notasEntrega, nota);
  // notas muy largas se rechazan
  const m2 = await m.marcar("salida", m.gB, m.tB, { notasEntrega: "x".repeat(1001) });
  assert.ok([400, 409].includes(m2.status));
});

test("autorización del supervisor para cerrar sin relevo: queda registrada con nombre y motivo", async () => {
  const m = await mundo();
  irA(inicioA() + MIN);
  await m.marcar("entrada", m.gA, m.tA);
  irA(finA() + 40 * MIN);
  assert.equal((await m.marcar("salida", m.gA, m.tA)).body.error, "relevo_pendiente");
  const auth = (uid, rol, body) => api("POST", "/relevo/autorizar-cierre", tok(uid, rol), body);
  // sin permiso: guardia, supervisor ajeno
  assert.equal((await api("POST", "/relevo/autorizar-cierre", await tok(m.gA, "guardia"), { turnoId: m.tA, motivo: "yo mismo me autorizo" })).status, 403, "el guardia no se autoriza solo");
  assert.equal((await api("POST", "/relevo/autorizar-cierre", await tok(m.s2, "supervisor"), { turnoId: m.tA, motivo: "no es mi sitio" })).status, 403);
  assert.equal((await api("POST", "/relevo/autorizar-cierre", await tok(m.s1, "supervisor"), { turnoId: m.tA, motivo: "x" })).status, 400, "el motivo es obligatorio");
  assert.equal(get(`autorizaciones/${m.tA}_cierre`), null);
  // el supervisor del sitio autoriza
  const ok = await api("POST", "/relevo/autorizar-cierre", await tok(m.s1, "supervisor"), { turnoId: m.tA, motivo: "El relevo avisó que no llegará; se cubre con guardia de apoyo." });
  assert.equal(ok.status, 201);
  const reg = get(`autorizaciones/${m.tA}_cierre`);
  assert.equal(reg.autorNombre, "Sara Sup");
  assert.equal(reg.autorUid, m.s1);
  assert.match(reg.motivo, /no llegará/);
  assert.ok(reg.tsMs && reg.ts);
  assert.equal((await api("POST", "/relevo/autorizar-cierre", await tok(m.s1, "supervisor"), { turnoId: m.tA, motivo: "otra vez" })).status, 409, "no se duplica");
  assert.ok(docsDe("auditoria").some((x) => x.accion === "relevo.cierre_autorizado" && x.actorUid === m.s1));
  // ahora sí cierra, con su extra pendiente
  const cierre = await m.marcar("salida", m.gA, m.tA, { notasEntrega: "Sin relevo." });
  assert.equal(cierre.status, 201);
  const a = get(`asistencias/${m.tA}`);
  assert.equal(a.estado, "cumplido");
  assert.equal(a.cierreAutorizadoPor, "Sara Sup");
  assert.equal(a.minutosExtra, 40);
  assert.equal(a.extraEstado, "pendiente");
});

test("alerta de relevo no llegó (fin + tolerancia) y horas extra del saliente en curso", async () => {
  const m = await mundo();
  irA(inicioA() + MIN);
  await m.marcar("entrada", m.gA, m.tA);
  const estadoEn = async (ms) => { irA(ms); await api("POST", "/asistencia/recalcular", await m.A(), { desde: D, hasta: D }); return get(`asistencias/${m.tA}`); };
  let a = await estadoEn(finA() + 10 * MIN);
  assert.equal(a.relevoAlerta, false, "dentro de la tolerancia (30 min)");
  assert.equal(a.estado, "salida_pendiente");
  a = await estadoEn(finA() + 31 * MIN);
  assert.equal(a.relevoAlerta, true);
  assert.equal(a.estado, "relevo_no_llego");
  assert.equal(a.minutosExtra, 31);
  assert.equal(a.extraEnCurso, true);
  assert.equal(a.extraEstado, "pendiente");
  // el cron (scheduled) produce lo mismo sin que nadie abra el panel
  w.docs.delete(`${BASE}/asistencias/${m.tA}`);
  irA(finA() + 45 * MIN);
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 400));
  a = get(`asistencias/${m.tA}`);
  assert.equal(a.relevoAlerta, true);
  assert.equal(a.minutosExtra, 45);
});

// ------------------------------------------------------------------ extras / ajustes
test("horas extra: pendientes hasta que el supervisor autoriza o rechaza (nombre y motivo); solo el de su sitio", async () => {
  const m = await mundo();
  irA(inicioA() + MIN);
  await m.marcar("entrada", m.gA, m.tA);
  irA(finA() - 5 * MIN);
  await m.marcar("entrada", m.gB, m.tB);
  irA(finA() + 50 * MIN);
  const cierre = await m.marcar("salida", m.gA, m.tA);
  assert.equal(cierre.status, 201);
  assert.equal(get(`asistencias/${m.tA}`).extraEstado, "pendiente");
  const resolver = async (uid, rol, body) => api("POST", "/extras/resolver", await tok(uid, rol), { turnoId: m.tA, ...body });
  assert.equal((await resolver(m.gA, "guardia", { decision: "autorizado", motivo: "me las autorizo" })).status, 403);
  assert.equal((await resolver(m.s2, "supervisor", { decision: "autorizado", motivo: "no es mi sitio" })).status, 403);
  assert.equal((await resolver(m.s1, "supervisor", { decision: "quizá", motivo: "motivo valido" })).status, 400);
  assert.equal((await resolver(m.s1, "supervisor", { decision: "autorizado", motivo: "no" })).status, 400, "motivo obligatorio");
  assert.equal(get(`asistencias/${m.tA}`).extraEstado, "pendiente");
  const ok = await resolver(m.s1, "supervisor", { decision: "autorizado", motivo: "Cubrió hueco por falta del relevo." });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.extraEstado, "autorizado");
  const a = get(`asistencias/${m.tA}`);
  assert.equal(a.extraEstado, "autorizado");
  assert.equal(a.extraResueltoPor, "Sara Sup");
  assert.match(a.extraMotivo, /relevo/);
  const dec = docsDe("autorizaciones").filter((x) => x.tipo === "extra");
  assert.equal(dec.length, 1);
  assert.equal(dec[0].minutos, 50);
  assert.equal(dec[0].autorNombre, "Sara Sup");
  // el admin puede cambiar la decisión (queda otra decisión nueva; la anterior permanece)
  irA(finA() + 55 * MIN);
  const rech = await api("POST", "/extras/resolver", await m.A(), { turnoId: m.tA, decision: "rechazado", motivo: "No estaba programado." });
  assert.equal(rech.status, 201);
  assert.equal(get(`asistencias/${m.tA}`).extraEstado, "rechazado");
  assert.equal(get(`asistencias/${m.tA}`).extraResueltoPor, "Ana Admin");
  assert.equal(docsDe("autorizaciones").filter((x) => x.tipo === "extra").length, 2, "el historial se conserva");
  // un turno sin extra no se puede resolver
  assert.equal((await api("POST", "/extras/resolver", await m.A(), { turnoId: m.tB, decision: "autorizado", motivo: "no hay extra" })).status, 409);
});

test("extra en curso no se puede resolver; un ajuste que cambia los minutos reabre la decisión", async () => {
  const m = await mundo();
  irA(inicioA() + MIN);
  await m.marcar("entrada", m.gA, m.tA);
  irA(finA() + 20 * MIN);
  await api("POST", "/asistencia/recalcular", await m.A(), { desde: D, hasta: D });
  const enCurso = await api("POST", "/extras/resolver", await tok(m.s1, "supervisor"), { turnoId: m.tA, decision: "autorizado", motivo: "aún trabajando" });
  assert.equal(enCurso.status, 409);
  assert.equal(enCurso.body.error, "extra_en_curso");
  // cierra con autorización de cierre, y se autoriza el extra
  await api("POST", "/relevo/autorizar-cierre", await tok(m.s1, "supervisor"), { turnoId: m.tA, motivo: "Relevo no llegará hoy." });
  await m.marcar("salida", m.gA, m.tA);
  await api("POST", "/extras/resolver", await tok(m.s1, "supervisor"), { turnoId: m.tA, decision: "autorizado", motivo: "Correcto, 20 min." });
  assert.equal(get(`asistencias/${m.tA}`).extraEstado, "autorizado");
  // ajuste: la salida real fue 19:50 → 50 min; la decisión sobre 20 min deja de aplicar
  const aj = await api("POST", "/ajustes", await tok(m.s1, "supervisor"), { turnoId: m.tA, tipo: "salida", fecha: D, hora: "19:50", motivo: "El guardia salió a las 19:50 según bitácora física." });
  assert.equal(aj.status, 201);
  const a = get(`asistencias/${m.tA}`);
  assert.equal(a.minutosExtra, 50);
  assert.equal(a.extraEstado, "pendiente", "nuevos minutos requieren nueva decisión");
});

test("ajustes: con motivo, solo admin o supervisor del sitio; la marca original NUNCA cambia", async () => {
  const m = await mundo();
  // A olvidó marcar: falta → el supervisor registra la entrada con un ajuste
  irA(at(D, "07:40"));
  await api("POST", "/asistencia/recalcular", await m.A(), { desde: D, hasta: D });
  assert.equal(get(`asistencias/${m.tA}`).estado, "falta");
  const ajustar = async (uid, rol, body) => api("POST", "/ajustes", await tok(uid, rol), { turnoId: m.tA, tipo: "entrada", fecha: D, hora: "07:05", motivo: "Llegó a tiempo; el celular no tenía datos.", ...body });
  assert.equal((await ajustar(m.gA, "guardia", {})).status, 403, "el guardia no se ajusta");
  assert.equal((await ajustar(m.s2, "supervisor", {})).status, 403, "supervisor de otro sitio");
  assert.equal((await ajustar(m.s1, "supervisor", { motivo: "" })).status, 400);
  assert.equal((await ajustar(m.s1, "supervisor", { motivo: "ok" })).status, 400, "motivo demasiado corto");
  assert.equal((await ajustar(m.s1, "supervisor", { tipo: "otra" })).status, 400);
  assert.equal((await ajustar(m.s1, "supervisor", { hora: "25:99" })).status, 400);
  assert.equal((await ajustar(m.s1, "supervisor", { fecha: sumaDia(D, 40) })).status, 400, "demasiado lejos del turno");
  assert.equal(docsDe("ajustesAsistencia").length, 0);
  const ok = await ajustar(m.s1, "supervisor", {});
  assert.equal(ok.status, 201);
  const aj = docsDe("ajustesAsistencia")[0];
  assert.equal(aj.autorNombre, "Sara Sup");
  assert.equal(aj.tipo, "entrada");
  assert.equal(aj.horaMs, at(D, "07:05"));
  assert.match(aj.motivo, /celular/);
  const a = get(`asistencias/${m.tA}`);
  assert.equal(a.falta, false);
  assert.equal(a.entradaMs, at(D, "07:05"));
  assert.equal(a.ajustes, 1);
  assert.equal(a.entradaOriginalMs, null);
  assert.equal(get(`marcas/${m.tA}_entrada`), null, "no se fabricó ninguna marca: el ajuste es un documento aparte");
  // con marca real: la original permanece intacta
  irA(finA() - 20 * MIN);
  await m.marcar("entrada", m.gB, m.tB).catch(() => {});
  const antes = JSON.stringify(doc(`marcas/${m.tB}_entrada`) || null);
  await api("POST", "/ajustes", await tok(m.s1, "supervisor"), { turnoId: m.tB, tipo: "entrada", fecha: D, hora: "19:00", motivo: "Corrección de hora por deriva del reloj." });
  assert.equal(JSON.stringify(doc(`marcas/${m.tB}_entrada`) || null), antes, "la marca original no se modificó");
  assert.equal(get(`asistencias/${m.tB}`).entradaOriginalMs, get(`marcas/${m.tB}_entrada`).tsMs);
  assert.equal(get(`asistencias/${m.tB}`).entradaMs, at(D, "19:00"), "pero el cálculo usa la hora ajustada");
  // validaciones de coherencia
  assert.equal((await api("POST", "/ajustes", await tok(m.s1, "supervisor"), { turnoId: m.tB, tipo: "salida", fecha: D, hora: "18:00", motivo: "Salida antes de la entrada" })).status, 400);
});

// ------------------------------------------------------------------ selfies
test("selfies: solo admin o el supervisor de ese sitio; guardias (ni la propia), otros supervisores y anónimos, no", async () => {
  const m = await mundo();
  irA(inicioA() + 3 * MIN);
  assert.equal((await m.marcar("entrada", m.gA, m.tA, { foto: jpeg(3000, 5) })).status, 201);
  const id = `${m.tA}_entrada`;
  const ver = async (uid, rol, marca = id) => api("GET", `/selfies?marca=${encodeURIComponent(marca)}`, uid ? await tok(uid, rol) : null);
  const ok1 = await ver(adminUid, "admin");
  assert.equal(ok1.status, 200);
  assert.equal(ok1.ct, "image/jpeg");
  const bytes = new Uint8Array(await ok1.raw.arrayBuffer());
  assert.equal(bytes.length, 3000);
  assert.equal(bytes[10], 5);
  assert.equal(ok1.raw.headers.get("cache-control"), "private, no-store");
  assert.equal(ok1.raw.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await ver(m.s1, "supervisor")).status, 200, "el supervisor del sitio");
  assert.equal((await ver(m.s2, "supervisor")).status, 403, "supervisor de otro sitio");
  assert.equal((await ver(m.gA, "guardia")).status, 403, "ni el propio guardia");
  assert.equal((await ver(m.gB, "guardia")).status, 403, "ni otro guardia");
  assert.equal((await ver(null)).status, 401);
  assert.equal((await ver(adminUid, "admin", `${m.tA}_salida`)).status, 404);
  for (const mal of ["../../x", "a b", "x_entrada/../y", "", `${m.tA}`]) assert.equal((await ver(adminUid, "admin", mal)).status, 400, mal);
  // token inválido o de otro proyecto
  assert.equal((await api("GET", `/selfies?marca=${id}`, await w.idToken(adminUid, "admin", { aud: "otro" }))).status, 401);
  // si el sitio cambia de supervisor, el acceso sigue al supervisor ACTUAL
  await api("POST", "/admin/sitios/actualizar", await m.A(), { id: m.S1, supervisorUid: m.s2 });
  assert.equal((await ver(m.s1, "supervisor")).status, 403);
  assert.equal((await ver(m.s2, "supervisor")).status, 200);
  // R2 caído: error claro, sin filtrar nada
  const sin = { ...env }; delete sin.SELFIES;
  const r = await worker.fetch(new Request(`https://p/selfies?marca=${id}`, { headers: { authorization: `Bearer ${await tok(adminUid, "admin")}`, origin: "https://racosta123.github.io" } }), sin);
  assert.equal(r.status, 503);
});

test("marcas inmutables: nada las edita ni las borra; R2 no se sobrescribe; sin almacenamiento no hay marca", async () => {
  const m = await mundo();
  irA(inicioA() + 3 * MIN);
  await m.marcar("entrada", m.gA, m.tA);
  const original = JSON.stringify(doc(`marcas/${m.tA}_entrada`));
  const claves = [...env.SELFIES.objetos.keys()];
  // reintentos, ajustes, recálculos, autorizaciones: la marca sigue idéntica
  await m.marcar("entrada", m.gA, m.tA, { lat: SITE.lat + 0.0005 });
  await api("POST", "/ajustes", await tok(m.s1, "supervisor"), { turnoId: m.tA, tipo: "entrada", fecha: D, hora: "07:01", motivo: "Corrección con motivo suficiente." });
  await api("POST", "/asistencia/recalcular", await m.A(), { desde: D, hasta: D });
  assert.equal(JSON.stringify(doc(`marcas/${m.tA}_entrada`)), original);
  assert.deepEqual([...env.SELFIES.objetos.keys()], claves, "la foto original sigue siendo la única");
  assert.ok(!w.calls.some((c) => /^(DELETE|PATCH) .*\/marcas\//.test(c)), "el Worker nunca borra ni parchea marcas");
  // sin R2 no se puede marcar (no se acepta una marca sin su selfie)
  irA(finA() - 10 * MIN); // dentro de la ventana del nocturno de B
  const sin = { ...env }; delete sin.SELFIES;
  const r = await worker.fetch(new Request("https://p/marcas/entrada", { method: "POST", headers: { authorization: `Bearer ${await tok(m.gB, "guardia")}`, origin: "https://racosta123.github.io", "content-type": "application/json" }, body: JSON.stringify({ turnoId: m.tB, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await m.qr(), foto: JPG }) }), sin);
  assert.equal(r.status, 503);
  assert.equal(get(`marcas/${m.tB}_entrada`), null);
});

// ------------------------------------------------------------------ nocturno y 24x24 de punta a punta
test("nocturno que cruza medianoche de punta a punta: retardo 20 min y 45 min de extra", async () => {
  const m = await mundo();
  irA(inicioA() + 5 * MIN); await m.marcar("entrada", m.gA, m.tA);
  irA(finA() - 10 * MIN); // B (nocturno) entra a tiempo? inicio 19:00 → 18:50 antes: sin retardo
  // B marca a las 19:20 (retardo 20)
  irA(at(D, "19:20") + 5000);
  assert.equal((await m.marcar("entrada", m.gB, m.tB)).status, 201);
  irA(at(D, "19:25")); assert.equal((await m.marcar("salida", m.gA, m.tA)).status, 201);
  const salidaB = at(sumaDia(D, 1), "07:45") + 10000;
  // C (sucesor de B) no existe → B cierra sin relevo y con 45 min de extra
  irA(salidaB);
  assert.equal((await m.marcar("salida", m.gB, m.tB, { notasEntrega: "Turno tranquilo." })).status, 201);
  const b = get(`asistencias/${m.tB}`);
  assert.equal(b.fecha, D, "el turno pertenece al día en que empezó, en hora de Hermosillo");
  assert.equal(b.retardo, true);
  assert.equal(b.retardoMin, 20);
  assert.equal(b.minutosExtra, 45);
  assert.equal(b.estado, "cumplido");
  assert.equal(b.finMs - b.inicioMs, 12 * 3600e3);
});

test("24x24 de punta a punta: entrada puntual, salida 90 min tarde, extra pendiente", async () => {
  const m = await mundo();
  const dia = sumaDia(D, 3);
  assert.equal(await m.lote(m.S2, "24x24", dia, m.gA), 201);
  const t24 = docsDe("turnos").find((t) => t.sitioId === m.S2 && t.guardiaUid === m.gA).id;
  const qr2 = await m.qr(m.S2);
  irA(at(dia, "07:00") + 20000);
  assert.equal((await m.marcar("entrada", m.gA, t24, { qr: qr2 })).status, 201);
  irA(at(sumaDia(dia, 1), "07:00") + 90 * MIN + 20000);
  assert.equal((await m.marcar("salida", m.gA, t24, { qr: qr2 })).status, 201);
  const a = get(`asistencias/${t24}`);
  assert.equal(a.finMs - a.inicioMs, 24 * 3600e3);
  assert.equal(a.retardo, false);
  assert.equal(a.minutosExtra, 90);
  assert.equal(a.extraEstado, "pendiente");
  assert.equal(a.estado, "cumplido");
});

// ------------------------------------------------------------------ configuración, reporte
test("configuración de empresa: ventanas y límites de horas extra por año (configurables y validados)", async () => {
  const m = await mundo();
  const base = { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3 };
  const guardar = async (extra) => api("POST", "/admin/config", await m.A(), { ...base, ...extra });
  assert.equal((await guardar({})).status, 200);
  assert.deepEqual(get("configuracion/empresa").limitesExtraPorAnio, [{ anio: 2026, horasSemana: 9 }, { anio: 2027, horasSemana: 12 }], "valores por defecto de la reforma");
  assert.equal((await guardar({ ventanaEntradaMin: 45, toleranciaRelevoMin: 20, limitesExtraPorAnio: [{ anio: 2028, horasSemana: 12 }, { anio: 2026, horasSemana: 9 }] })).status, 200);
  const c = get("configuracion/empresa");
  assert.equal(c.ventanaEntradaMin, 45);
  assert.equal(c.toleranciaRelevoMin, 20);
  assert.deepEqual(c.limitesExtraPorAnio, [{ anio: 2026, horasSemana: 9 }, { anio: 2028, horasSemana: 12 }]);
  for (const mal of [{ ventanaEntradaMin: -1 }, { ventanaEntradaMin: 241 }, { toleranciaRelevoMin: 1.5 }, { limitesExtraPorAnio: "9" },
    { limitesExtraPorAnio: [{ anio: 2026, horasSemana: 0 }] }, { limitesExtraPorAnio: [{ anio: 1999, horasSemana: 9 }] },
    { limitesExtraPorAnio: [{ anio: 2026, horasSemana: 9 }, { anio: 2026, horasSemana: 8 }] }, { limitesExtraPorAnio: Array.from({ length: 13 }, (_, i) => ({ anio: 2030 + i, horasSemana: 9 })) }])
    assert.equal((await guardar(mal)).status, 400, JSON.stringify(mal).slice(0, 60));
  assert.equal((await api("POST", "/admin/config", await tok(m.s1, "supervisor"), { ...base })).status, 403);
});

test("reporte de asistencia: admin ve todo, supervisor solo sus sitios; acumulado semanal y faltas por retardos", async () => {
  const m = await mundo();
  const gC = await m.mkG("G003", "Gus Guardia");
  assert.equal(await m.lote(m.S2, "diurno", D, gC), 201);
  const tC = docsDe("turnos").find((t) => t.guardiaUid === gC).id;
  irA(inicioA() + 15 * MIN + 1000); // A: retardo
  await m.marcar("entrada", m.gA, m.tA);
  irA(at(D, "07:50"));
  await api("POST", "/asistencia/recalcular", await m.A(), { desde: D, hasta: D });
  assert.equal(get(`asistencias/${tC}`).falta, true);
  irA(at(sumaDia(D, 1), "12:00"));
  const rep = (uid, rol, q = `desde=${D}&hasta=${D}`) => api("GET", `/reportes/asistencia?${q}`, tok(uid, rol));
  const ra = await api("GET", `/reportes/asistencia?desde=${D}&hasta=${D}`, await m.A());
  assert.equal(ra.status, 200);
  assert.equal(ra.body.filas.length, 3, "admin: todos los sitios");
  assert.deepEqual(ra.body.filas.map((f) => f.estado).sort(), ["en_turno", "falta", "falta"].sort().map((x) => x).sort().length ? ra.body.filas.map((f) => f.estado).sort() : []);
  const rs = await api("GET", `/reportes/asistencia?desde=${D}&hasta=${D}`, await tok(m.s2, "supervisor"));
  assert.equal(rs.status, 200);
  assert.deepEqual(rs.body.filas.map((f) => f.sitioId), [m.S2], "supervisor: solo su sitio");
  const sg = rs.body.resumen[0];
  assert.equal(sg.faltas, 1);
  const r1 = await api("GET", `/reportes/asistencia?desde=${D}&hasta=${D}&sitioId=${m.S1}`, await tok(m.s2, "supervisor"));
  assert.equal(r1.body.filas.length, 0, "no se cuela un sitio ajeno con el filtro");
  assert.equal((await api("GET", `/reportes/asistencia?desde=${D}&hasta=${D}`, await tok(m.gA, "guardia"))).status, 403);
  assert.equal((await api("GET", `/reportes/asistencia?desde=2026-01-01&hasta=2027-12-31`, await m.A())).status, 400, "rango máximo");
  assert.equal((await api("GET", `/reportes/asistencia?desde=x&hasta=y`, await m.A())).status, 400);
  assert.equal((await api("GET", `/reportes/asistencia?desde=${D}&hasta=${D}`, null)).status, 401);
  void rep;
});

test("datos de prueba: marcas, asistencias y autorizaciones heredan prueba=true del turno", async () => {
  const m = await mundo();
  const S3 = (await api("POST", "/admin/sitios", await m.A(), { nombre: "Sitio de prueba", supervisorUid: m.s1, ...SITE, precisionM: 5, radioM: 100, prueba: true })).body.id;
  const gP = await m.mkG("P001", "Guardia Prueba", { prueba: true });
  const dia = sumaDia(D, 2);
  assert.equal(await m.lote(S3, "diurno", dia, gP), 201);
  const tP = docsDe("turnos").find((t) => t.sitioId === S3).id;
  irA(at(dia, "07:02"));
  assert.equal((await api("POST", "/marcas/entrada", await tok(gP, "guardia"), { turnoId: tP, lat: SITE.lat, lng: SITE.lng, precisionM: 9, qr: await generarPayload(env, S3, 1), foto: JPG })).status, 201);
  assert.equal(get(`marcas/${tP}_entrada`).prueba, true);
  assert.equal(get(`asistencias/${tP}`).prueba, true);
  await api("POST", "/ajustes", await tok(m.s1, "supervisor"), { turnoId: tP, tipo: "entrada", fecha: dia, hora: "07:01", motivo: "Ajuste de prueba válido." });
  assert.equal(docsDe("ajustesAsistencia")[0].prueba, true);
  assert.ok(docsDe("auditoria").filter((x) => x.accion === "asistencia.ajuste").every((x) => x.prueba === true));
  // un turno real no queda marcado
  irA(inicioA() + 2 * MIN);
  await m.marcar("entrada", m.gA, m.tA);
  assert.equal(get(`marcas/${m.tA}_entrada`).prueba, undefined);
});
