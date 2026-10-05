// Fase 6: modo sin internet (cola offline con validación idéntica), botón de pánico y notificaciones push.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorld, call, PROJECT } from "./harness.js";
import { fechaLocal, localAMs } from "../src/common.js";
import { generarPayload, generarPayloadPunto } from "../src/qr.js";
import { b64u, b64uToBytes } from "../src/crypto.js";
import { cifrarPush, clavePublica, endpointPermitido } from "../src/push.js";

let w, env;
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const irA = (ms) => { offset = ms - realNow(); };
const pushes = [];
const pushEstado = {};
beforeEach(async () => {
  if (w) w.restore();
  offset = 0; contador = 0;
  w = await createWorld(); env = w.env;
  pushes.length = 0;
  for (const k of Object.keys(pushEstado)) delete pushEstado[k];
  const previo = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (new URL(url).host === "fcm.googleapis.com") { pushes.push({ url, headers: init.headers, body: new Uint8Array(init.body) }); return new Response(null, { status: pushEstado[url] ?? 201 }); }
    return previo(input, init);
  };
});
after(() => { w.restore(); Date.now = realNow; });

const MIN = 60000, DIA = 86400000, H = 3600000;
const BASE = `projects/${PROJECT}/databases/(default)/documents`;
const doc = (p) => w.docs.get(`${BASE}/${p}`);
const val = (f) => (f === undefined ? undefined : "stringValue" in f ? f.stringValue : "integerValue" in f ? Number(f.integerValue) : "booleanValue" in f ? f.booleanValue : "nullValue" in f ? null : "doubleValue" in f ? f.doubleValue : "timestampValue" in f ? f.timestampValue : "arrayValue" in f ? (f.arrayValue.values || []).map(val) : "mapValue" in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : f);
const plano = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, val(v)]));
const docsDe = (col) => [...w.docs.entries()].filter(([k]) => k.startsWith(`${BASE}/${col}/`)).map(([k, v]) => ({ id: k.split("/").pop(), ...plano(v) }));
const get = (p) => (doc(p) ? plano(doc(p)) : null);

const PASS = "una-clave-muy-larga-1";
const SITE = { lat: 29.0729, lng: -110.9559 };
const D = fechaLocal(Date.now() + 5 * DIA);
const at = (f, h) => localAMs(f, h);
const jpeg = (n = 4000, r = 3) => { const b = new Uint8Array(n).fill(r); b.set([0xff, 0xd8, 0xff, 0xe0], 0); b.set([0xff, 0xd9], n - 2); return Buffer.from(b).toString("base64"); };
const JPG = jpeg();

async function api(method, path, tok, body) {
  const r = await call(worker, env, method, path, { body, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json().catch(() => ({})) : null, raw: r };
}
let adminUid;
const tok = (uid, rol) => w.idToken(uid, rol);
let contador = 0;
const sync = (eventoMs, extra = {}) => ({ clientId: `cli-${++contador}-${"abcdefghij".repeat(2)}`, offline: true, horaDispositivoMs: eventoMs - 3 * MIN, horaEstimadaMs: eventoMs, ...extra });

async function mundo() {
  const r = await call(worker, env, "POST", "/setup/primer-admin", { headers: { "x-setup-token": env.SETUP_TOKEN }, body: { nombre: "Ana Admin", email: "ana@marpec.mx", password: PASS } });
  adminUid = (await r.json()).uid;
  const A = () => tok(adminUid, "admin");
  const mkG = async (n, nombre) => (await api("POST", "/admin/usuarios", await A(), { rol: "guardia", nombre, numeroEmpleado: n, pin: "4821" })).body.uid;
  const mkS = async (e, n) => (await api("POST", "/admin/usuarios", await A(), { rol: "supervisor", nombre: n, email: e, password: PASS })).body.uid;
  const [gA, gB, gC, s1, s2] = [await mkG("G001", "Gael"), await mkG("G002", "Gema"), await mkG("G003", "Gus"), await mkS("s1@marpec.mx", "Sara Sup"), await mkS("s2@marpec.mx", "Saúl Sup")];
  const mkSitio = async (nombre, sup, extra = {}) => (await api("POST", "/admin/sitios", await A(), { nombre, supervisorUid: sup, ...SITE, precisionM: 8, radioM: 100, ...extra })).body.id;
  const S1 = await mkSitio("Plaza Norte", s1, { telefonoEmergencia: "662 123 4567" }), S2 = await mkSitio("Bodega Sur", s2);
  const lote = async (sitioId, plantilla, fecha, guardiaUid) => (await api("POST", "/turnos/asignar-lote", await A(), { sitioId, plantilla, desde: fecha, hasta: fecha, guardiaUid })).status;
  assert.equal(await lote(S1, "diurno", D, gA), 201); // gA: 07:00-19:00 en S1
  assert.equal(await lote(S1, "nocturno", D, gC), 201); // gC: 19:00-07:00 en S1 (relevo de gA)
  assert.equal(await lote(S2, "diurno", D, gB), 201);
  const turnos = docsDe("turnos");
  const T = (g) => turnos.find((t) => t.guardiaUid === g).id;
  const qrAsis = async (s) => generarPayload(env, s, get(`sitios/${s}`).qrVersion);
  const marca = async (uid, tipo, turnoId, sitio, extra = {}) => api("POST", `/marcas/${tipo}`, await tok(uid, "guardia"), { turnoId, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await qrAsis(sitio), foto: JPG, ...extra });
  const entrar = (uid, turnoId, sitio, extra) => marca(uid, "entrada", turnoId, sitio, extra);
  const G = async (uid, metodo, ruta, body) => api(metodo, ruta, await tok(uid, "guardia"), body);
  const SUP = async (uid, metodo, ruta, body) => api(metodo, ruta, await tok(uid, "supervisor"), body);
  const AD = async (metodo, ruta, body) => api(metodo, ruta, await A(), body);
  return { A, AD, SUP, gA, gB, gC, s1, s2, S1, S2, tA: T(gA), tB: T(gB), tC: T(gC), qrAsis, marca, entrar, G };
}
const INICIO = () => at(D, "07:00");

// ------------------------------------------------------------------ sin conexión: marcas
test("marca de entrada sin conexión: misma validación, hora estimada, tres horas guardadas, sin_conexion y supervisor la ve", async () => {
  const m = await mundo();
  irA(INICIO() + 40 * MIN); // llega la señal 40 min después
  const evento = INICIO() + 5 * MIN;
  const s = sync(evento);
  const r = await m.entrar(m.gA, m.tA, m.S1, { sync: s });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.sin_conexion, true);
  const marca = get(`marcas/${m.tA}_entrada`);
  assert.equal(marca.tsMs, evento, "la hora de la marca es la ESTIMADA, no la de recepción");
  assert.equal(marca.sin_conexion, true);
  assert.equal(marca.horaEstimadaMs, evento);
  assert.equal(marca.horaDispositivoMs, s.horaDispositivoMs, "hora del dispositivo guardada");
  assert.ok(Math.abs(marca.recibidoMs - Date.now()) < 5000, "hora de recepción del servidor guardada");
  assert.ok(marca.ts, "y la marca de tiempo del servidor de Firestore");
  // vista para el supervisor + asistencia calculada con la hora estimada
  const reg = docsDe("offlineVista");
  assert.equal(reg.length, 1);
  assert.deepEqual([reg[0].estadoRevision, reg[0].tipo, reg[0].supervisorUid, reg[0].guardiaNombre, reg[0].sitioNombre], ["pendiente", "entrada", m.s1, "Gael", "Plaza Norte"]);
  const asis = get(`asistencias/${m.tA}`);
  assert.equal(asis.entradaMs, evento);
  assert.equal(asis.entradaSinConexion, true);
  assert.equal(asis.retardo, false, "5 min tarde: dentro de la tolerancia (10 min), calculado con la hora estimada y no con la de recepción");
  // reenviar el MISMO registro: no se duplica
  const antes = [docsDe("marcas").length, docsDe("registrosOffline").length, docsDe("offlineVista").length, w.commits];
  const dup = await m.entrar(m.gA, m.tA, m.S1, { sync: s });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicado, true);
  assert.deepEqual([docsDe("marcas").length, docsDe("registrosOffline").length, docsDe("offlineVista").length, w.commits], antes, "no se escribió nada");
  // otro clientId para la misma marca: ya existe (no es un duplicado, es un conflicto real)
  const otra = await m.entrar(m.gA, m.tA, m.S1, { sync: sync(evento + MIN) });
  assert.equal(otra.status, 409);
  assert.equal(otra.body.error, "ya_marcada");
  assert.equal(docsDe("marcas").length, 1);
});

test("el clientId es por usuario: otro guardia con el mismo clientId no choca ni lo ve como duplicado", async () => {
  const m = await mundo();
  irA(INICIO() + 40 * MIN);
  const s = sync(INICIO() + 5 * MIN);
  assert.equal((await m.entrar(m.gA, m.tA, m.S1, { sync: s })).status, 201);
  const b = await m.entrar(m.gB, m.tB, m.S2, { sync: s });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.ok(!b.body.duplicado);
  assert.equal(docsDe("registrosOffline").length, 2);
});

test("registros sin conexión rechazados: muy viejos, futuros, fuera de turno, QR alterado, fuera de perímetro, sin entrada, campos extra", async () => {
  const m = await mundo();
  irA(at(D, "20:00")); // 13 h después del inicio
  // más de 12 h
  let r = await m.entrar(m.gA, m.tA, m.S1, { sync: sync(INICIO() + 5 * MIN) });
  assert.equal(r.status, 409); assert.equal(r.body.error, "registro_muy_antiguo");
  // fuera del turno (antes de que abra la ventana de entrada) aunque sea reciente
  irA(at(D, "06:00") + 30 * MIN);
  r = await m.entrar(m.gA, m.tA, m.S1, { sync: sync(at(D, "06:00") + 5 * MIN) });
  assert.equal(r.status, 409); assert.equal(r.body.error, "fuera_de_turno");
  // en el futuro
  irA(INICIO() + 10 * MIN);
  r = await m.entrar(m.gA, m.tA, m.S1, { sync: sync(Date.now() + 30 * MIN) });
  assert.equal(r.status, 400); assert.equal(r.body.error, "hora_futura");
  // QR alterado (se rechaza igual que en línea) y de otro sitio
  const qr = await m.qrAsis(m.S1);
  const partes = qr.split(".");
  const alterado = [...partes.slice(0, 3), partes[3].slice(0, -2) + (partes[3].endsWith("AA") ? "BB" : "AA")].join(".");
  r = await m.entrar(m.gA, m.tA, m.S1, { qr: alterado, sync: sync(INICIO() + 5 * MIN) });
  assert.equal(r.status, 400); assert.equal(r.body.error, "qr_invalido");
  r = await m.entrar(m.gA, m.tA, m.S1, { qr: await m.qrAsis(m.S2), sync: sync(INICIO() + 5 * MIN) });
  assert.equal(r.body.error, "qr_invalido", "QR de otro puesto");
  // fuera del perímetro
  r = await m.entrar(m.gA, m.tA, m.S1, { lat: SITE.lat + 0.01, sync: sync(INICIO() + 5 * MIN) });
  assert.equal(r.status, 403); assert.equal(r.body.error, "fuera_perimetro");
  // precisión mala
  r = await m.entrar(m.gA, m.tA, m.S1, { precisionM: 500, sync: sync(INICIO() + 5 * MIN) });
  assert.equal(r.body.error, "gps_precision");
  // foto inválida
  r = await m.entrar(m.gA, m.tA, m.S1, { foto: "AAAA", sync: sync(INICIO() + 5 * MIN) });
  assert.equal(r.status, 400);
  // sync mal formado
  for (const malo of [{ clientId: "corto", offline: true, horaDispositivoMs: 1, horaEstimadaMs: 1 }, { ...sync(INICIO() + 5 * MIN), extra: 1 }, { ...sync(INICIO() + 5 * MIN), horaEstimadaMs: "ayer" }, "x", [], { clientId: "x".repeat(70), offline: true }])
    assert.equal((await m.entrar(m.gA, m.tA, m.S1, { sync: malo })).status, 400, JSON.stringify(malo).slice(0, 50));
  // turno ajeno
  r = await m.entrar(m.gB, m.tA, m.S1, { sync: sync(INICIO() + 5 * MIN) });
  assert.equal(r.status, 403);
  assert.equal(docsDe("marcas").length + docsDe("registrosOffline").length + docsDe("offlineVista").length, 0, "nada quedó guardado");
  // y un rechazo NO consume el clientId: el mismo registro corregido sí se acepta
  const s = sync(INICIO() + 5 * MIN);
  assert.equal((await m.entrar(m.gA, m.tA, m.S1, { qr: alterado, sync: s })).status, 400);
  assert.equal((await m.entrar(m.gA, m.tA, m.S1, { sync: s })).status, 201);
});

test("la antigüedad máxima es configurable por el admin", async () => {
  const m = await mundo();
  const c = (await api("POST", "/admin/config", await m.A(), { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3, offlineMaxHoras: 2 }));
  assert.equal(c.status, 200, JSON.stringify(c.body));
  irA(INICIO() + 3 * H);
  assert.equal((await m.entrar(m.gA, m.tA, m.S1, { sync: sync(INICIO() + 10 * MIN) })).body.error, "registro_muy_antiguo");
  assert.equal((await m.entrar(m.gA, m.tA, m.S1, { sync: sync(INICIO() + 2 * H + 30 * MIN) })).status, 201);
  assert.equal((await api("POST", "/admin/config", await m.A(), { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3, offlineMaxHoras: 100 })).status, 400);
});

// ------------------------------------------------------------------ sin conexión: libro del turno
test("incidencia, novedad, visitante y salida sin conexión: validan igual, se marcan y respetan entrada/salida del turno", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); assert.equal((await m.entrar(m.gA, m.tA, m.S1)).status, 201);
  irA(INICIO() + 4 * H);
  const e0 = INICIO() + 2 * H;
  // novedad
  const n = await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "Ronda sin novedad.", sync: sync(e0) });
  assert.equal(n.status, 201);
  const nd = docsDe("novedades")[0];
  assert.deepEqual([nd.tsMs, nd.sin_conexion, nd.horaEstimadaMs], [e0, true, e0]);
  // incidencia con fotos y GPS
  const i = await m.G(m.gA, "POST", "/incidencias", { turnoId: m.tA, tipoId: "robo", gravedad: "alta", descripcion: "Candado forzado en el portón.", fotos: [JPG, jpeg(3500, 2)], lat: SITE.lat, lng: SITE.lng, precisionM: 9, sync: sync(e0 + 10 * MIN) });
  assert.equal(i.status, 201, JSON.stringify(i.body));
  const inc = get(`incidencias/${i.body.id}`);
  assert.deepEqual([inc.creadoMs, inc.sin_conexion, inc.fotoKeys.length], [e0 + 10 * MIN, true, 2]);
  assert.equal(get(`incidenciasResumen/${i.body.id}`).sin_conexion, true, "el resumen que lee el supervisor trae la etiqueta");
  // visitante entra (sin conexión) y sale (sin conexión) refiriéndose a la entrada por clientId
  const sv = sync(e0 + 20 * MIN);
  const v = await m.G(m.gA, "POST", "/visitantes/entrada", { turnoId: m.tA, nombre: "Luis Pérez", visitaA: "Casa 12", motivo: "visita", foto: JPG, sync: sv });
  assert.equal(v.status, 201);
  const vd = docsDe("visitantes")[0];
  assert.deepEqual([vd.entradaMs, vd.sin_conexion], [e0 + 20 * MIN, true]);
  assert.equal(vd.expiraMs, e0 + 20 * MIN + 90 * DIA, "la retención corre desde la hora del evento");
  const sal = await m.G(m.gA, "POST", "/visitantes/salida", { turnoId: m.tA, visitanteClientId: sv.clientId, sync: sync(e0 + 50 * MIN) });
  assert.equal(sal.status, 201, JSON.stringify(sal.body));
  assert.deepEqual([get(`visitantesVista/${v.body.id}`).dentro, get(`visitantesVista/${v.body.id}`).salidaMs], [false, e0 + 50 * MIN]);
  // salida del visitante anterior a su entrada: rechazada
  const v2 = await m.G(m.gA, "POST", "/visitantes/entrada", { turnoId: m.tA, nombre: "Ana Ruiz", visitaA: "Casa 3", motivo: "proveedor", sync: sync(e0 + 60 * MIN) });
  assert.equal((await m.G(m.gA, "POST", "/visitantes/salida", { turnoId: m.tA, visitanteId: v2.body.id, sync: sync(e0 + 30 * MIN) })).status, 409);
  // los registros aparecen en la bitácora con la etiqueta
  const b = await m.G(m.gA, "GET", `/bitacora/turno?turnoId=${m.tA}`);
  assert.ok(b.body.items.find((x) => x.tipo === "novedad").sin_conexion);
  assert.ok(b.body.items.find((x) => x.tipo === "incidencia").sin_conexion);
  // no se guardan nombres de visitantes en la vista de revisión (la retención los borra en otro lado)
  assert.ok(docsDe("offlineVista").every((x) => !JSON.stringify(x).includes("Luis")));
  // esquema estricto: un campo de identificación sigue rechazado también sin conexión
  assert.equal((await m.G(m.gA, "POST", "/visitantes/entrada", { turnoId: m.tA, nombre: "X Y", visitaA: "Casa", motivo: "visita", ine: "123", sync: sync(e0) })).status, 400);
  // fuera de turno / sin entrada
  assert.equal((await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "Antes de entrar.", sync: sync(INICIO() + 2 * MIN) })).body.error, "fuera_de_turno", "anterior a la entrada marcada (07:05)");
  assert.equal((await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "En la madrugada.", sync: sync(INICIO() - 2 * H) })).body.error, "fuera_de_turno");
  assert.equal((await m.G(m.gB, "POST", "/novedades", { turnoId: m.tB, texto: "Sin entrada marcada.", sync: sync(e0) })).body.error, "sin_entrada");
  // tras la salida: un registro con hora anterior a la salida SÍ entra; uno posterior, no
  irA(at(D, "19:05"));
  await api("POST", "/relevo/autorizar-cierre", await tok(m.s1, "supervisor"), { turnoId: m.tA, motivo: "El relevo llegará tarde." });
  assert.equal((await m.marca(m.gA, "salida", m.tA, m.S1)).status, 201);
  assert.equal((await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "Pendiente de enviar.", sync: sync(at(D, "18:30")) })).status, 201, "capturada antes de la salida");
  irA(at(D, "19:15"));
  assert.equal((await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "Ya salí.", sync: sync(at(D, "19:10")) })).body.error, "fuera_de_turno", "posterior a la salida (19:05)");
  assert.equal((await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "En línea tras salir." })).body.error, "sin_turno_activo", "en línea sigue igual");
});

test("rondín sin conexión: el escaneo cuenta con su hora estimada aunque llegue después de vencer el plazo", async () => {
  const m = await mundo();
  const pto = (await api("POST", "/admin/puntos", await m.A(), { sitioId: m.S1, nombre: "Portón", orden: 1 })).body.id;
  await api("POST", "/rondines/programa", await m.A(), { sitioId: m.S1, modo: "libre", frecuencia: { tipo: "horarios", horarios: ["10:00"] }, toleranciaInicioMin: 15, toleranciaFinMin: 45 });
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(at(D, "10:50")); // el plazo (10:45) ya venció cuando regresa la señal
  const qr = await generarPayloadPunto(env, pto, 1);
  const s = sync(at(D, "10:06"));
  const r = await m.G(m.gA, "POST", "/rondines/escanear", { turnoId: m.tA, qr, sync: s });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.completo, true);
  const e = docsDe("escaneos")[0];
  assert.deepEqual([e.tsMs, e.sin_conexion], [at(D, "10:06"), true]);
  const rondin = docsDe("rondines").find((x) => x.turnoId === m.tA);
  assert.equal(rondin.estado, "completo");
  assert.equal(rondin.detalle[0].sin_conexion, true);
  // duplicado: no vuelve a escribir ni cambia el estado
  const dup = await m.G(m.gA, "POST", "/rondines/escanear", { turnoId: m.tA, qr, sync: s });
  assert.equal(dup.body.duplicado, true);
  assert.equal(docsDe("escaneos").length, 1);
  // QR de punto alterado o de asistencia: se rechaza igual
  const mal = qr.slice(0, -3) + "AAA";
  assert.equal((await m.G(m.gA, "POST", "/rondines/escanear", { turnoId: m.tA, qr: mal, sync: sync(at(D, "10:07")) })).body.error, "qr_invalido");
  assert.equal((await m.G(m.gA, "POST", "/rondines/escanear", { turnoId: m.tA, qr: await m.qrAsis(m.S1), sync: sync(at(D, "10:07")) })).body.error, "qr_invalido");
  // hora estimada fuera de toda ventana de rondín
  assert.equal((await m.G(m.gA, "POST", "/rondines/escanear", { turnoId: m.tA, qr, sync: sync(at(D, "08:00")) })).status, 409);
});

test("no se duplica aunque el celular reintente en paralelo (respuesta perdida)", async () => {
  const m = await mundo();
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  irA(INICIO() + 2 * H);
  const s = sync(INICIO() + H);
  const cuerpo = { turnoId: m.tA, texto: "Una sola vez.", sync: s };
  const rs = await Promise.all([1, 2, 3].map(() => m.G(m.gA, "POST", "/novedades", cuerpo)));
  assert.ok(rs.every((x) => x.status === 200 || x.status === 201), JSON.stringify(rs.map((x) => x.body)));
  assert.equal(docsDe("novedades").length, 1);
  assert.equal(docsDe("registrosOffline").length, 1);
  // envío en línea con clientId (sin offline): también idempotente
  const so = { clientId: `en-linea-${"z".repeat(16)}` };
  const a = await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "En línea con clave.", sync: so });
  const b = await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "En línea con clave.", sync: so });
  assert.equal(a.status, 201); assert.equal(b.body.duplicado, true);
  assert.equal(docsDe("novedades").length, 2);
  assert.ok(!docsDe("novedades").some((x) => x.sin_conexion && x.texto === "En línea con clave."), "no se marca sin conexión");
  assert.equal(docsDe("offlineVista").length, 1, "solo los sin conexión llegan a la bandeja de revisión");
});

// ------------------------------------------------------------------ revisión del supervisor
test("el supervisor acepta o ajusta con motivo; otro supervisor y el guardia no pueden; ajustar una entrada corrige la asistencia", async () => {
  const m = await mundo();
  irA(INICIO() + 40 * MIN);
  const evento = INICIO() + 20 * MIN; // 20 min tarde: retardo
  await m.entrar(m.gA, m.tA, m.S1, { sync: sync(evento) });
  assert.equal(get(`asistencias/${m.tA}`).retardo, true);
  await m.G(m.gA, "POST", "/novedades", { turnoId: m.tA, texto: "Todo bien.", sync: sync(evento + 10 * MIN) });
  const [rEntrada, rNov] = [docsDe("offlineVista").find((x) => x.tipo === "entrada"), docsDe("offlineVista").find((x) => x.tipo === "novedad")];
  const rev = (quien, body) => (quien === "s1" ? m.SUP(m.s1, "POST", "/offline/revisar", body) : quien === "s2" ? m.SUP(m.s2, "POST", "/offline/revisar", body) : quien === "g" ? m.G(m.gA, "POST", "/offline/revisar", body) : m.AD("POST", "/offline/revisar", body));
  assert.equal((await rev("s2", { registroId: rNov.id, accion: "aceptar" })).status, 403, "supervisor de otro sitio");
  assert.equal((await rev("g", { registroId: rNov.id, accion: "aceptar" })).status, 403, "guardia");
  assert.equal((await rev("s1", { registroId: "no-existe", accion: "aceptar" })).status, 404);
  assert.equal((await rev("s1", { registroId: rNov.id, accion: "borrar" })).status, 400);
  assert.equal((await rev("s1", { registroId: rNov.id, accion: "ajustar", motivo: "x", horaAjustadaMs: evento })).status, 400, "ajustar exige motivo");
  assert.equal((await rev("s1", { registroId: rNov.id, accion: "ajustar", motivo: "Hora corregida", horaAjustadaMs: Date.now() + H })).status, 400, "hora futura");
  assert.equal((await rev("s1", { registroId: rNov.id, accion: "aceptar", extra: 1 })).status, 400);
  const ok = await rev("s1", { registroId: rNov.id, accion: "aceptar", motivo: "Coincide con la bitácora de papel." });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const v = get(`offlineVista/${rNov.id}`);
  assert.deepEqual([v.estadoRevision, v.revisionPorNombre, v.revisionMotivo], ["aceptado", "Sara Sup", "Coincide con la bitácora de papel."]);
  assert.equal(docsDe("revisionesOffline").length, 1);
  assert.equal((await rev("s1", { registroId: rNov.id, accion: "aceptar" })).body.error, "ya_revisado");
  assert.equal(get(`novedades/${docsDe("novedades")[0].id}`).texto, "Todo bien.", "el original no se modificó");
  // ajustar la ENTRADA: hora real 07:03 → ya no hay retardo (por el ajuste con motivo y autor)
  const aj = await rev("admin", { registroId: rEntrada.id, accion: "ajustar", motivo: "El guardia entró a las 07:03 según el testigo.", horaAjustadaMs: INICIO() + 3 * MIN });
  assert.equal(aj.status, 200, JSON.stringify(aj.body));
  const ajuste = docsDe("ajustesAsistencia")[0];
  assert.deepEqual([ajuste.tipo, ajuste.horaMs, ajuste.horaOriginalMs, ajuste.autorNombre], ["entrada", INICIO() + 3 * MIN, evento, "Ana Admin"]);
  assert.match(ajuste.motivo, /sin conexión/);
  const asis = get(`asistencias/${m.tA}`);
  assert.equal(asis.entradaMs, INICIO() + 3 * MIN);
  assert.equal(asis.retardo, false);
  assert.equal(asis.entradaOriginalMs, evento, "la marca original sigue ahí");
  assert.equal(get(`offlineVista/${rEntrada.id}`).estadoRevision, "ajustado");
  assert.ok(docsDe("auditoria").some((a) => a.accion === "offline.ajustar") && docsDe("auditoria").some((a) => a.accion === "offline.aceptar"));
});

// ------------------------------------------------------------------ pánico
test("pánico: exige 3 s, llega al supervisor del sitio y al admin (no a otros), se atiende una sola vez con quién y cuándo", async () => {
  const m = await mundo();
  irA(INICIO() + 30 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const P = (uid, body) => m.G(uid, "POST", "/panico", body);
  const gps = { lat: SITE.lat + 0.0002, lng: SITE.lng, precisionM: 12 };
  for (const mal of [{ mantenidoMs: 2999, ...gps }, { ...gps }, { mantenidoMs: "3000" }, { mantenidoMs: 3000, extra: 1 }, { mantenidoMs: 3000, lat: 99, lng: 0, precisionM: 5 }])
    assert.equal((await P(m.gA, mal)).status, 400, JSON.stringify(mal));
  assert.equal((await P(m.gA, { mantenidoMs: 2999, ...gps })).body.error, "pulsacion_corta");
  assert.equal(docsDe("panicos").length, 0);
  // solo el guardia
  for (const [uid, rol] of [[m.s1, "supervisor"], [adminUid, "admin"]]) assert.equal((await api("POST", "/panico", await tok(uid, rol), { mantenidoMs: 3000 })).status, 403);
  assert.equal((await api("POST", "/panico", null, { mantenidoMs: 3000 })).status, 401);
  const r = await P(m.gA, { mantenidoMs: 3200, ...gps, horaDispositivoMs: 5 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const pv = get(`panicoVista/${r.body.id}`);
  assert.deepEqual([pv.estado, pv.supervisorUid, pv.sitioId, pv.sitioNombre, pv.guardiaNombre, pv.telefonoEmergencia], ["activa", m.s1, m.S1, "Plaza Norte", "Gael", "662 123 4567"]);
  assert.ok(Math.abs(pv.tsMs - Date.now()) < 5000, "hora del servidor");
  assert.ok(pv.distanciaM > 5 && pv.lat === gps.lat);
  assert.ok(get(`panicos/${r.body.id}`) && docsDe("auditoria").some((a) => a.accion === "panico.alerta"));
  // pulsación repetida con la alerta activa: se reutiliza
  const rep = await P(m.gA, { mantenidoMs: 3000, ...gps });
  assert.deepEqual([rep.status, rep.body.repetida, rep.body.id], [200, true, r.body.id]);
  assert.equal(docsDe("panicos").length, 1);
  // atención: guardia y supervisor ajeno no; el supervisor del sitio sí, una sola vez
  assert.equal((await m.G(m.gA, "POST", "/panico/atender", { id: r.body.id })).status, 403);
  assert.equal((await m.SUP(m.s2, "POST", "/panico/atender", { id: r.body.id })).status, 403);
  assert.equal((await m.SUP(m.s1, "POST", "/panico/atender", { id: "no-existe" })).status, 404);
  const at1 = await m.SUP(m.s1, "POST", "/panico/atender", { id: r.body.id, nota: "Voy en camino con la patrulla." });
  assert.equal(at1.status, 200, JSON.stringify(at1.body));
  const pv2 = get(`panicoVista/${r.body.id}`);
  assert.deepEqual([pv2.estado, pv2.atendidaPorNombre, pv2.atendidaPorRol, pv2.notaAtencion], ["atendida", "Sara Sup", "supervisor", "Voy en camino con la patrulla."]);
  assert.ok(pv2.atendidaMs >= pv.tsMs);
  assert.equal(get(`atencionesPanico/${r.body.id}`).atendidaPorUid, m.s1);
  const otra = await m.AD("POST", "/panico/atender", { id: r.body.id });
  assert.equal(otra.status, 409); assert.equal(otra.body.error, "ya_atendida");
  assert.equal(get(`panicoVista/${r.body.id}`).atendidaPorNombre, "Sara Sup", "no se sobrescribe");
  assert.ok(docsDe("auditoria").some((a) => a.accion === "panico.atendida" && a.actorNombre === "Sara Sup"));
  // el guardia de OTRO sitio genera una alerta que ve su supervisor, no s1
  irA(INICIO() + 40 * MIN); await m.entrar(m.gB, m.tB, m.S2);
  const rb = await P(m.gB, { mantenidoMs: 3000 });
  assert.equal(get(`panicoVista/${rb.body.id}`).supervisorUid, m.s2);
  assert.equal((await m.SUP(m.s1, "POST", "/panico/atender", { id: rb.body.id })).status, 403, "s1 no puede atender un sitio ajeno");
  assert.equal((await m.AD("POST", "/panico/atender", { id: rb.body.id })).status, 200, "el admin sí");
});

test("pánico: límite de frecuencia, sin turno (solo admin), y sin conexión con idempotencia", async () => {
  const m = await mundo();
  irA(INICIO() + 30 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const P = (uid, body) => m.G(uid, "POST", "/panico", body);
  for (let i = 0; i < 5; i++) {
    const r = await P(m.gA, { mantenidoMs: 3000 });
    assert.equal(r.status, 201, `alerta ${i + 1}: ${JSON.stringify(r.body)}`);
    assert.equal((await m.SUP(m.s1, "POST", "/panico/atender", { id: r.body.id })).status, 200);
  }
  const lim = await P(m.gA, { mantenidoMs: 3000 });
  assert.equal(lim.status, 429); assert.equal(lim.body.error, "demasiadas_alertas");
  assert.equal(docsDe("panicos").length, 5);
  irA(Date.now() + 11 * MIN);
  assert.equal((await P(m.gA, { mantenidoMs: 3000 })).status, 201, "pasada la ventana vuelve a funcionar");
  // guardia sin turno vigente (gB: 07:00-19:00 en S2, ahora es de madrugada del día siguiente): admin solamente
  irA(at(D, "23:50") + DIA);
  const sin = await P(m.gB, { mantenidoMs: 3000 });
  assert.equal(sin.status, 201);
  const sv = get(`panicoVista/${sin.body.id}`);
  assert.deepEqual([sv.sinSitio, sv.supervisorUid, sv.sitioId], [true, null, null]);
  assert.equal((await m.SUP(m.s1, "POST", "/panico/atender", { id: sin.body.id })).status, 403, "supervisores no atienden alertas sin sitio");
  assert.equal((await m.AD("POST", "/panico/atender", { id: sin.body.id })).status, 200);
  // sin conexión: se encola y se envía al volver la señal; idempotente
  const m2 = m;
  irA(INICIO() + 2 * H);
  const s = sync(INICIO() + H + 10 * MIN);
  const off = await m2.G(m2.gA, "POST", "/panico", { mantenidoMs: 3100, lat: SITE.lat, lng: SITE.lng, precisionM: 10, sync: s });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  const pvo = get(`panicoVista/${off.body.id}`);
  assert.deepEqual([pvo.sin_conexion, pvo.tsMs, pvo.estado], [true, INICIO() + H + 10 * MIN, "activa"]);
  assert.ok(Math.abs(pvo.recibidoMs - Date.now()) < 5000);
  const dup = await m2.G(m2.gA, "POST", "/panico", { mantenidoMs: 3100, sync: s });
  assert.equal(dup.body.duplicado, true);
  assert.equal(docsDe("panicos").filter((p) => p.sin_conexion).length, 1);
  // más de 12 h: se rechaza como todo registro sin conexión
  irA(INICIO() + 20 * H);
  assert.equal((await m2.G(m2.gA, "POST", "/panico", { mantenidoMs: 3000, sync: sync(INICIO() + H) })).body.error, "registro_muy_antiguo");
});

// ------------------------------------------------------------------ push
async function nuevaSuscripcion(id, host = "fcm.googleapis.com") {
  const par = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey));
  return { endpoint: `https://${host}/fcm/send/${id}`, keys: { p256dh: b64u(pub), auth: b64u(auth) }, priv: par.privateKey, pub, auth };
}
// Receptor RFC 8291 (lo que hace el navegador): descifra el cuerpo recibido.
async function descifrar(cuerpo, sub) {
  const salt = cuerpo.slice(0, 16);
  const idlen = cuerpo[20];
  const asPub = cuerpo.slice(21, 21 + idlen);
  const ct = cuerpo.slice(21 + idlen);
  const hkdf = async (ikm, s, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, sub.priv, 256));
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode("WebPush: info\0"), ...sub.pub, ...asPub]);
  const ikm = await hkdf(ecdh, sub.auth, info, 32);
  const cek = await hkdf(ikm, salt, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, te.encode("Content-Encoding: nonce\0"), 12);
  const claro = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  assert.equal(claro[claro.length - 1], 2, "delimitador del último registro");
  return JSON.parse(new TextDecoder().decode(claro.slice(0, -1)));
}
async function configurarVapid() {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey("jwk", k.privateKey));
}
const suscribir = async (m, uid, rol, sub, prefs) => api("POST", "/push/suscribir", await tok(uid, rol), { endpoint: sub.endpoint, keys: sub.keys, ...(prefs ? { prefs } : {}) });
const paraSub = (sub) => pushes.filter((p) => p.url === sub.endpoint);

test("push: cifrado RFC 8291 verificado con un receptor independiente y VAPID ES256 válido", async () => {
  await mundo();
  await configurarVapid();
  const sub = await nuevaSuscripcion("prueba1");
  const cuerpo = await cifrarPush(JSON.stringify({ t: "panico", sitio: "Ñandú 1" }), sub.keys.p256dh, sub.keys.auth);
  assert.deepEqual(await descifrar(cuerpo, sub), { t: "panico", sitio: "Ñandú 1" });
  const otra = await nuevaSuscripcion("otra");
  await assert.rejects(descifrar(cuerpo, { ...sub, priv: otra.priv }), "otro navegador no puede leerlo");
  // el texto cifrado no contiene el contenido
  assert.ok(!Buffer.from(cuerpo).toString("latin1").includes("panico"));
  assert.equal(clavePublica(env).length, 87);
  assert.ok(endpointPermitido("https://fcm.googleapis.com/fcm/send/abc") && endpointPermitido("https://updates.push.services.mozilla.com/wpush/v2/abc") && endpointPermitido("https://web.push.apple.com/abc") && endpointPermitido("https://wns2-par02p.notify.windows.com/w/?token=x"));
  for (const mal of ["http://fcm.googleapis.com/x", "https://evil.example.com/x", "https://fcm.googleapis.com.evil.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "javascript:alert(1)", "https://169.254.169.254/latest"])
    assert.equal(endpointPermitido(mal), false, mal);
});

test("push: solo supervisor y admin se suscriben (opt-in), con endpoint de un servicio push real y llaves válidas", async () => {
  const m = await mundo();
  const sub = await nuevaSuscripcion("s1a");
  // sin llaves VAPID configuradas
  assert.equal((await suscribir(m, m.s1, "supervisor", sub)).status, 503);
  assert.equal((await api("GET", "/push/clave", await tok(m.s1, "supervisor"))).status, 503);
  await configurarVapid();
  const clave = await api("GET", "/push/clave", await tok(m.s1, "supervisor"));
  assert.equal(clave.body.publicKey, clavePublica(env));
  assert.equal((await api("GET", "/push/clave", await tok(m.gA, "guardia"))).status, 403);
  assert.equal((await api("GET", "/push/clave", null)).status, 401);
  assert.equal((await suscribir(m, m.gA, "guardia", sub)).status, 403, "el guardia no se suscribe");
  assert.equal((await api("POST", "/push/suscribir", null, sub)).status, 401);
  const base = { endpoint: sub.endpoint, keys: sub.keys };
  const T = await tok(m.s1, "supervisor");
  for (const mal of [{ ...base, endpoint: "https://evil.example.com/x" }, { ...base, endpoint: "http://fcm.googleapis.com/x" }, { ...base, keys: { ...sub.keys, p256dh: "AAAA" } }, { ...base, keys: { ...sub.keys, auth: "AA" } }, { ...base, keys: undefined },
    { ...base, prefs: { panico: false } }, { ...base, prefs: { otra: true } }, { ...base, extra: 1 }])
    assert.equal((await api("POST", "/push/suscribir", T, mal)).status, 400, JSON.stringify(mal).slice(0, 60));
  assert.equal(docsDe("pushSuscripciones").length, 0);
  const ok = await suscribir(m, m.s1, "supervisor", sub);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.prefs, { incidencia_alta: true, relevo: true, rondin: true });
  const s = docsDe("pushSuscripciones")[0];
  assert.deepEqual([s.uid, s.rol], [m.s1, "supervisor"]);
  // estado propio; otro usuario no ve ni borra la suscripción de alguien más
  assert.equal((await api("POST", "/push/estado", T, { endpoint: sub.endpoint })).body.suscrito, true);
  assert.equal((await api("POST", "/push/estado", await tok(m.s2, "supervisor"), { endpoint: sub.endpoint })).body.suscrito, false);
  await api("POST", "/push/baja", await tok(m.s2, "supervisor"), { endpoint: sub.endpoint });
  assert.equal(docsDe("pushSuscripciones").length, 1);
  await api("POST", "/push/baja", T, { endpoint: sub.endpoint });
  assert.equal(docsDe("pushSuscripciones").length, 0);
});

test("push: el pánico llega solo al supervisor del sitio y a los admin suscritos; contenido mínimo; VAPID firmado; el pánico no se puede silenciar", async () => {
  const m = await mundo();
  await configurarVapid();
  const [subS1, subS2, subAd, subG] = [await nuevaSuscripcion("s1"), await nuevaSuscripcion("s2"), await nuevaSuscripcion("ad"), await nuevaSuscripcion("g")];
  assert.equal((await suscribir(m, m.s1, "supervisor", subS1, { incidencia_alta: false, relevo: false, rondin: false })).status, 201);
  assert.equal((await suscribir(m, m.s2, "supervisor", subS2)).status, 201);
  assert.equal((await suscribir(m, adminUid, "admin", subAd)).status, 201);
  assert.equal((await suscribir(m, m.gA, "guardia", subG)).status, 403);
  irA(INICIO() + 30 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const r = await m.G(m.gA, "POST", "/panico", { mantenidoMs: 3000, lat: SITE.lat, lng: SITE.lng, precisionM: 8 });
  assert.equal(r.status, 201);
  assert.equal(r.body.avisados, 2);
  assert.equal(paraSub(subS1).length, 1, "supervisor del sitio (con todo lo demás silenciado, el pánico sí llega)");
  assert.equal(paraSub(subAd).length, 1, "admin");
  assert.equal(paraSub(subS2).length, 0, "el supervisor de otro sitio NO recibe nada");
  assert.equal(paraSub(subG).length, 0);
  const msg = await descifrar(paraSub(subS1)[0].body, subS1);
  assert.deepEqual(Object.keys(msg).sort(), ["sitio", "t", "ts"], "solo tipo de alerta y sitio");
  assert.equal(msg.t, "panico"); assert.equal(msg.sitio, "Plaza Norte");
  const plano = JSON.stringify(msg);
  for (const secreto of ["Gael", "G001", String(SITE.lat), "selfie", "662"]) assert.ok(!plano.includes(secreto), `sin ${secreto}`);
  // cabeceras: VAPID válido (ES256 con la llave pública derivada) y cifrado aes128gcm
  const h = paraSub(subS1)[0].headers;
  assert.equal(h["content-encoding"], "aes128gcm"); assert.equal(h.urgency, "high");
  const mm = /^vapid t=([\w-]+\.[\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h.authorization);
  assert.ok(mm, h.authorization);
  assert.equal(mm[3], clavePublica(env));
  const pub = await crypto.subtle.importKey("raw", b64uToBytes(mm[3]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64uToBytes(mm[2]), new TextEncoder().encode(mm[1])), true, "firma ES256 válida");
  const claims = JSON.parse(Buffer.from(mm[1].split(".")[1], "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp - Date.now() / 1000 <= 12 * 3600 + 5);
  // el pánico no es configurable
  const T = await tok(m.s1, "supervisor");
  assert.equal((await api("POST", "/push/prefs", T, { prefs: { panico: false } })).status, 400);
  // el supervisor deshabilitado deja de recibir; la baja también quita el acceso
  await api("POST", "/admin/usuarios/baja", await m.A(), { uid: m.s1 });
  pushes.length = 0;
  irA(Date.now() + 20 * MIN); // la alerta anterior ya no está activa por tiempo
  await m.SUP(m.s2, "POST", "/panico/atender", { id: r.body.id }).catch(() => {});
  await m.AD("POST", "/panico/atender", { id: r.body.id });
  const r2 = await m.G(m.gA, "POST", "/panico", { mantenidoMs: 3000 });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(paraSub(subS1).length, 0, "supervisor dado de baja: no recibe");
  assert.equal(paraSub(subAd).length, 1);
});

test("push: incidencia alta, relevo y rondín respetan las preferencias; una sola vez; suscripciones muertas se eliminan", async () => {
  const m = await mundo();
  await configurarVapid();
  await api("POST", "/admin/puntos", await m.A(), { sitioId: m.S1, nombre: "Portón", orden: 1 });
  await api("POST", "/rondines/programa", await m.A(), { sitioId: m.S1, modo: "libre", frecuencia: { tipo: "horarios", horarios: ["10:00"] }, toleranciaInicioMin: 15, toleranciaFinMin: 45 });
  const [subS1, subAd, subMuerta] = [await nuevaSuscripcion("s1"), await nuevaSuscripcion("ad"), await nuevaSuscripcion("muerta")];
  await suscribir(m, m.s1, "supervisor", subS1, { incidencia_alta: false, relevo: true, rondin: false });
  await suscribir(m, adminUid, "admin", subAd);
  await suscribir(m, adminUid, "admin", subMuerta);
  pushEstado[subMuerta.endpoint] = 410;
  irA(INICIO() + 5 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  // incidencia ALTA: admin sí, el supervisor la silenció; la de gravedad media no genera push
  await m.G(m.gA, "POST", "/incidencias", { turnoId: m.tA, tipoId: "robo", gravedad: "media", descripcion: "Algo menor en la caseta." });
  assert.equal(pushes.length, 0, "solo las altas");
  const alta = await m.G(m.gA, "POST", "/incidencias", { turnoId: m.tA, tipoId: "robo", gravedad: "alta", descripcion: "Robo en la bodega 3, hay detenido." });
  assert.equal(alta.status, 201);
  assert.equal(paraSub(subS1).length, 0);
  assert.equal(paraSub(subAd).length, 1);
  const msg = await descifrar(paraSub(subAd)[0].body, subAd);
  assert.deepEqual(msg.t, "incidencia_alta");
  assert.ok(!JSON.stringify(msg).includes("detenido") && !JSON.stringify(msg).includes("bodega"), "sin la descripción");
  assert.equal(docsDe("pushSuscripciones").length, 2, "la suscripción que respondió 410 se eliminó");
  // rondín no iniciado (cron): el supervisor lo silenció, el admin no
  const correrCron = async () => { const ps = []; await worker.scheduled({}, env, { waitUntil: (p) => ps.push(p) }); await Promise.all(ps); };
  pushes.length = 0;
  irA(at(D, "10:20")); await correrCron();
  assert.equal(paraSub(subAd).filter(() => true).length, 1);
  assert.equal((await descifrar(paraSub(subAd)[0].body, subAd)).t, "rondin");
  assert.equal(paraSub(subS1).length, 0);
  irA(at(D, "10:30")); await correrCron();
  assert.equal(pushes.length, 1, "no se repite en el siguiente cron");
  // relevo que no llega (19:00 + 30 min de tolerancia)
  pushes.length = 0;
  irA(at(D, "19:40")); await correrCron();
  const relevo = pushes.filter((p) => p.url === subS1.endpoint);
  assert.equal(relevo.length, 1);
  assert.equal((await descifrar(relevo[0].body, subS1)).t, "relevo");
  assert.equal((await descifrar(relevo[0].body, subS1)).sitio, "Plaza Norte");
  assert.ok(pushes.some((p) => p.url === subAd.endpoint));
  const total = pushes.length;
  irA(at(D, "19:50")); await correrCron();
  assert.equal(pushes.length, total, "una sola vez por turno");
  // supervisor de otro sitio: jamás
  const subS2 = await nuevaSuscripcion("s2");
  await suscribir(m, m.s2, "supervisor", subS2);
  irA(at(D, "20:10")); await correrCron();
  assert.equal(paraSub(subS2).length, 0);
  // preferencias: se guardan en todos los dispositivos del usuario
  const p = await api("POST", "/push/prefs", await tok(m.s1, "supervisor"), { prefs: { incidencia_alta: true, relevo: false, rondin: true } });
  assert.deepEqual(p.body.prefs, { incidencia_alta: true, relevo: false, rondin: true });
  assert.equal((await api("POST", "/push/estado", await tok(m.s1, "supervisor"), { endpoint: subS1.endpoint })).body.prefs.relevo, false);
});

test("las llaves VAPID no aparecen en respuestas, auditoría ni documentos; sin llaves no hay envío ni error", async () => {
  const m = await mundo();
  await configurarVapid();
  const sub = await nuevaSuscripcion("x");
  await suscribir(m, adminUid, "admin", sub);
  irA(INICIO() + 30 * MIN); await m.entrar(m.gA, m.tA, m.S1);
  const r = await m.G(m.gA, "POST", "/panico", { mantenidoMs: 3000 });
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const todo = JSON.stringify([...w.docs.values()]) + JSON.stringify(r.body) + JSON.stringify(pushes.map((p) => p.headers));
  assert.ok(!todo.includes(jwk.d), "la llave privada nunca se escribe en ningún lado");
  // sin VAPID
  delete env.VAPID_PRIVATE_JWK;
  pushes.length = 0;
  await m.SUP(m.s1, "POST", "/panico/atender", { id: r.body.id });
  irA(Date.now() + 20 * MIN);
  const r2 = await m.G(m.gA, "POST", "/panico", { mantenidoMs: 3000 });
  assert.equal(r2.status, 201);
  assert.equal(pushes.length, 0);
});

// ------------------------------------------------------------------ varios
test("las respuestas traen la hora del servidor (para calcular el desfase del celular) y CORS la expone", async () => {
  const m = await mundo();
  const r = await call(worker, env, "GET", "/me", { headers: { authorization: `Bearer ${await tok(m.gA, "guardia")}` } });
  assert.ok(Math.abs(Number(r.headers.get("x-server-time")) - Date.now()) < 3000);
  assert.match(r.headers.get("access-control-expose-headers"), /x-server-time/);
  const e = await call(worker, env, "GET", "/me", { origin: "https://evil.example" });
  assert.equal(e.status, 403);
});

test("teléfono de emergencia del sitio: validado y editable por el admin", async () => {
  const m = await mundo();
  const mk = (tel) => m.AD("POST", "/admin/sitios/actualizar", { id: m.S2, telefonoEmergencia: tel });
  assert.equal((await mk("662-555-0101")).status, 200);
  assert.equal(get(`sitios/${m.S2}`).telefonoEmergencia, "662-555-0101");
  for (const mal of ["abc", "12", "<script>", "1".repeat(21), "tel: 662"]) assert.equal((await mk(mal)).status, 400, mal);
  assert.equal((await m.SUP(m.s2, "POST", "/admin/sitios/actualizar", { id: m.S2, telefonoEmergencia: "999 999 9999" })).status, 403);
});
