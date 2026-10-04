import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorld, call, PROJECT } from "./harness.js";
import { localAMs, fechaLocal } from "../src/common.js";
import { generarTurnos } from "../src/turnos.js";

let w, env;
beforeEach(async () => {
  if (w) w.restore();
  w = await createWorld();
  env = w.env;
});
after(() => w.restore());

const BASE = `projects/${PROJECT}/databases/(default)/documents`;
const doc = (p) => w.docs.get(`${BASE}/${p}`);
const val = (f) => (f === undefined ? undefined : "stringValue" in f ? f.stringValue : "integerValue" in f ? Number(f.integerValue) : "booleanValue" in f ? f.booleanValue : "nullValue" in f ? null : "doubleValue" in f ? f.doubleValue : "arrayValue" in f ? (f.arrayValue.values || []).map(val) : f);
const docsDe = (col) => [...w.docs.entries()].filter(([k]) => k.startsWith(`${BASE}/${col}/`)).map(([k, v]) => ({ id: k.split("/").pop(), ...Object.fromEntries(Object.entries(v).map(([a, b]) => [a, val(b)])) }));

const DIA = 86400000;
const enDias = (n) => fechaLocal(Date.now() + n * DIA);
const PASS = "una-clave-muy-larga-1";

async function api(method, path, tok, body, ip = "1.1.1.1", extra = {}) {
  const r = await call(worker, env, method, path, { body, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra }, ip });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Admin + (opcional) personal y sitios. Devuelve tokens listos.
async function mundo() {
  let r = await call(worker, env, "POST", "/setup/primer-admin", {
    headers: { "x-setup-token": env.SETUP_TOKEN }, body: { nombre: "Ana Admin", email: "ana@marpec.mx", password: PASS } });
  const adminUid = (await r.json()).uid;
  const A = await w.idToken(adminUid, "admin");
  const mkG = async (num, nombre, pin = "4821") => {
    const x = await api("POST", "/admin/usuarios", A, { rol: "guardia", nombre, numeroEmpleado: num, pin });
    assert.equal(x.status, 201, JSON.stringify(x.body));
    return x.body.uid;
  };
  const mkS = async (email, nombre) => {
    const x = await api("POST", "/admin/usuarios", A, { rol: "supervisor", nombre, email, password: PASS });
    assert.equal(x.status, 201, JSON.stringify(x.body));
    return x.body.uid;
  };
  const mkSitio = async (nombre, supervisorUid = null, extra = {}) => {
    const x = await api("POST", "/admin/sitios", A, { nombre, direccion: "Calle 1", cliente: "Cliente", consignas: "Reportar todo.", supervisorUid, lat: 29.0729, lng: -110.9559, precisionM: 12.5, radioM: 100, ...extra });
    assert.equal(x.status, 201, JSON.stringify(x.body));
    return x.body.id;
  };
  return { adminUid, A, mkG, mkS, mkSitio };
}

test("hora de Hermosillo: UTC-7 fijo, sin horario de verano", () => {
  assert.equal(localAMs("2026-10-05", "07:00"), Date.UTC(2026, 9, 5, 14, 0));
  assert.equal(localAMs("2026-07-05", "07:00"), Date.UTC(2026, 6, 5, 14, 0)); // verano: mismo desfase
  assert.equal(fechaLocal(Date.UTC(2026, 9, 5, 6, 59)), "2026-10-04"); // 23:59 del día anterior en Hermosillo
  assert.throws(() => localAMs("2026-02-30", "07:00"));
});

test("plantillas generan los horarios correctos", () => {
  const h = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(0, 16);
  const d = generarTurnos({ plantilla: "diurno", desde: "2026-10-05", hasta: "2026-10-06" });
  assert.deepEqual(d.map((t) => h(t.inicioMs) + ">" + h(t.finMs)), ["2026-10-05T07:00>2026-10-05T19:00", "2026-10-06T07:00>2026-10-06T19:00"]);
  const n = generarTurnos({ plantilla: "nocturno", desde: "2026-10-05", hasta: "2026-10-05" });
  assert.equal(h(n[0].finMs), "2026-10-06T07:00");
  const x12 = generarTurnos({ plantilla: "12x24", desde: "2026-10-05", hasta: "2026-10-08" });
  assert.deepEqual(x12.map((t) => h(t.inicioMs)), ["2026-10-05T07:00", "2026-10-06T19:00", "2026-10-08T07:00"]); // cada 36 h
  const x24 = generarTurnos({ plantilla: "24x24", desde: "2026-10-05", hasta: "2026-10-08" });
  assert.deepEqual(x24.map((t) => h(t.inicioMs)), ["2026-10-05T07:00", "2026-10-07T07:00"]); // cada 48 h
  const p = generarTurnos({ plantilla: "personalizada", desde: "2026-10-05", hasta: "2026-10-05", horaInicio: "22:00", horaFin: "06:00" });
  assert.equal(h(p[0].finMs), "2026-10-06T06:00");
  assert.throws(() => generarTurnos({ plantilla: "diurno", desde: "2026-10-05", hasta: "2027-01-05" }), (e) => /máximo/i.test(e.detail));
  assert.throws(() => generarTurnos({ plantilla: "personalizada", desde: "2026-10-05", hasta: "2026-10-05", horaInicio: "08:00", horaFin: "08:00" }));
});

test("personal: solo el admin da de alta; supervisor y guardia reciben 403", async () => {
  const { A, mkG, mkS } = await mundo();
  const g = await mkG("G001", "Gael Guardia");
  const s = await mkS("sara@marpec.mx", "Sara Sup");
  const tg = await w.idToken(g, "guardia");
  const ts = await w.idToken(s, "supervisor");
  for (const tok of [tg, ts]) {
    assert.equal((await api("POST", "/admin/usuarios", tok, { rol: "guardia", nombre: "X", numeroEmpleado: "X999", pin: "1234" })).status, 403);
    assert.equal((await api("POST", "/admin/sitios", tok, { nombre: "Sitio", radioM: 100 })).status, 403);
    assert.equal((await api("POST", "/admin/config", tok, { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3 })).status, 403);
    assert.equal((await api("POST", "/admin/usuarios/baja", tok, { uid: g })).status, 403);
  }
  assert.equal(val(doc(`usuarios/${g}`).sitiosAsignados.arrayValue ? { arrayValue: doc(`usuarios/${g}`).sitiosAsignados.arrayValue } : undefined).length, 0);
  assert.equal((await api("POST", "/admin/usuarios", A, { rol: "guardia", nombre: "Dup", numeroEmpleado: "G001", pin: "1234" })).status, 409);
});

test("personal: editar nombre/correo", async () => {
  const { A, mkG, mkS } = await mundo();
  const g = await mkG("G001", "Gael");
  const s = await mkS("sara@marpec.mx", "Sara");
  assert.equal((await api("POST", "/admin/usuarios/actualizar", A, { uid: g, nombre: "Gael Pérez" })).status, 200);
  assert.equal(val(doc(`usuarios/${g}`).nombre), "Gael Pérez");
  assert.equal((await api("POST", "/admin/usuarios/actualizar", A, { uid: s, email: "sara2@marpec.mx" })).status, 200);
  assert.equal(w.authUsers.get(s).email, "sara2@marpec.mx");
  assert.equal((await api("POST", "/admin/usuarios/actualizar", A, { uid: g, email: "x@x.mx" })).status, 400, "un guardia no tiene correo");
  assert.equal((await api("POST", "/admin/usuarios/actualizar", A, { uid: g })).status, 400);
});

test("baja de guardia: acceso cortado al instante, cuenta inhabilitada, tokens revocados, turnos liberados", async () => {
  const { A, mkG, mkSitio } = await mundo();
  const g = await mkG("G001", "Gael");
  const sid = await mkSitio("Plaza Norte");
  const lote = await api("POST", "/turnos/asignar-lote", A, { sitioId: sid, plantilla: "diurno", desde: enDias(5), hasta: enDias(6), guardiaUid: g });
  assert.equal(lote.status, 201);
  // el guardia ya había entrado alguna vez: existe en Auth
  w.authUsers.set(g, { email: undefined });
  const tokViejo = await w.idToken(g, "guardia");
  assert.equal((await api("GET", "/me", tokViejo)).status, 200);
  assert.equal((await call(worker, env, "POST", "/auth/guardia", { body: { numero: "G001", pin: "4821" }, ip: "2.2.2.2" })).status, 200);

  const baja = await api("POST", "/admin/usuarios/baja", A, { uid: g });
  assert.equal(baja.status, 200);
  assert.equal(baja.body.tokensRevocados, true);
  assert.equal(baja.body.turnosLiberados, 2);

  assert.equal(w.authUsers.get(g).disableUser, true, "cuenta inhabilitada");
  assert.ok(Number(w.authUsers.get(g).validSince) > 0, "refresh tokens revocados (validSince)");
  assert.equal((await api("GET", "/me", tokViejo)).status, 403, "token aún vigente ya no sirve en el Worker");
  assert.equal((await call(worker, env, "POST", "/auth/guardia", { body: { numero: "G001", pin: "4821" }, ip: "3.3.3.3" })).status, 401, "ni con PIN correcto");
  assert.equal(val(doc("usuarios/" + g).activo), false);
  assert.equal(val(doc("credenciales/G001").activo), false);
  assert.ok(docsDe("turnos").every((t) => t.guardiaUid === null), "turnos futuros quedan vacantes");

  assert.equal((await api("POST", "/admin/usuarios/reactivar", A, { uid: g })).status, 200);
  assert.equal(w.authUsers.get(g).disableUser, false);
  assert.equal((await call(worker, env, "POST", "/auth/guardia", { body: { numero: "G001", pin: "4821" }, ip: "4.4.4.4" })).status, 200);
});

test("baja de supervisor: sus sitios y turnos quedan sin supervisor", async () => {
  const { A, mkS, mkSitio } = await mundo();
  const s = await mkS("sara@marpec.mx", "Sara");
  const sid = await mkSitio("Plaza", s);
  await api("POST", "/turnos/asignar-lote", A, { sitioId: sid, plantilla: "diurno", desde: enDias(5), hasta: enDias(5) });
  assert.equal(docsDe("turnos")[0].supervisorUid, s);
  const r = await api("POST", "/admin/usuarios/baja", A, { uid: s });
  assert.equal(r.status, 200);
  assert.equal(w.authUsers.get(s).disableUser, true);
  assert.equal(doc(`sitios/${sid}`).supervisorUid.nullValue, null);
  assert.equal(docsDe("turnos")[0].supervisorUid, null);
  assert.equal((await api("GET", "/me", await w.idToken(s, "supervisor"))).status, 403);
});

test("PIN: bloqueo, desbloqueo por admin y restablecimiento", async () => {
  const { A, mkG } = await mundo();
  await mkG("G001", "Gael", "4821");
  const login = (pin, ip) => call(worker, env, "POST", "/auth/guardia", { body: { numero: "G001", pin }, ip });
  for (let i = 0; i < 5; i++) await login("0000", `10.0.0.${i}`);
  assert.equal((await login("4821", "10.0.1.1")).status, 401, "bloqueado");
  assert.equal((await api("POST", "/admin/usuarios/desbloquear-pin", A, { numero: "G001" })).status, 200);
  assert.equal((await login("4821", "10.0.1.2")).status, 200, "desbloqueado");
  for (let i = 0; i < 5; i++) await login("0000", `10.0.2.${i}`);
  assert.equal((await api("POST", "/admin/usuarios/restablecer-pin", A, { numero: "G001", pin: "9753" })).status, 200);
  assert.equal((await login("4821", "10.0.3.1")).status, 401, "el PIN anterior ya no sirve");
  assert.equal((await login("9753", "10.0.3.2")).status, 200, "el nuevo PIN entra y también desbloquea");
  assert.equal((await api("POST", "/admin/usuarios/restablecer-pin", A, { numero: "G001", pin: "12" })).status, 400);
  assert.ok(!JSON.stringify([...w.docs.values()]).includes("9753"), "el PIN nunca se guarda en claro");
});

test("sitios: validación de datos y permisos", async () => {
  const { A, mkS } = await mundo();
  const s = await mkS("sara@marpec.mx", "Sara");
  const ok = { nombre: "Plaza Norte", direccion: "Blvd 1", cliente: "ACME", consignas: "No dejar solo el acceso.", supervisorUid: s, lat: 29.07, lng: -110.95, precisionM: 8, radioM: 150 };
  const malos = [
    { ...ok, nombre: "" }, { ...ok, nombre: "x".repeat(81) }, { ...ok, lat: 91 }, { ...ok, lng: -181 }, { ...ok, lat: "29" },
    { ...ok, radioM: 5 }, { ...ok, radioM: 5000 }, { ...ok, radioM: 100.5 }, { ...ok, consignas: "x".repeat(2001) },
    { ...ok, supervisorUid: "no-existe" }, { ...ok, lat: 29.07, lng: undefined },
  ];
  for (const m of malos) assert.equal((await api("POST", "/admin/sitios", A, m)).status, 400, JSON.stringify(m).slice(0, 80));
  const good = await api("POST", "/admin/sitios", A, ok);
  assert.equal(good.status, 201);
  const d = doc(`sitios/${good.body.id}`);
  assert.equal(val(d.radioM), 150);
  assert.equal(val(d.qrVersion), 1);
  const def = await api("POST", "/admin/sitios", A, { nombre: "Sin GPS" });
  assert.equal(val(doc(`sitios/${def.body.id}`).radioM), 100, "radio por defecto 100 m");
  assert.equal(doc(`sitios/${def.body.id}`).lat.nullValue, null);
  assert.equal((await api("POST", "/admin/sitios/actualizar", A, { id: good.body.id, radioM: 200, consignas: "Nuevas" })).status, 200);
  assert.equal(val(doc(`sitios/${good.body.id}`).radioM), 200);
  assert.equal(val(doc(`sitios/${good.body.id}`).nombre), "Plaza Norte", "los campos no enviados se conservan");
});

test("QR: firmado; alterado, viejo, de otro sitio o con otra llave es rechazado", async () => {
  const { A, mkS, mkSitio, mkG } = await mundo();
  const s1 = await mkS("s1@marpec.mx", "Sup Uno");
  const s2 = await mkS("s2@marpec.mx", "Sup Dos");
  const g = await mkG("G001", "Gael");
  const siteA = await mkSitio("Sitio A", s1);
  const siteB = await mkSitio("Sitio B", s2);
  const T1 = await w.idToken(s1, "supervisor");
  const T2 = await w.idToken(s2, "supervisor");
  const TG = await w.idToken(g, "guardia");

  const qa = await api("GET", `/sitios/qr?id=${siteA}`, A);
  assert.equal(qa.status, 200);
  assert.match(qa.body.payload, /^MPC1\.[0-9a-f]+\.1\.[A-Za-z0-9_-]{22}$/);
  assert.equal((await api("GET", `/sitios/qr?id=${siteA}`, T1)).status, 200, "su supervisor puede obtenerlo");
  assert.equal((await api("GET", `/sitios/qr?id=${siteA}`, T2)).status, 403, "otro supervisor no");
  assert.equal((await api("GET", `/sitios/qr?id=${siteA}`, TG)).status, 403, "un guardia no obtiene la firma");

  const ver = (payload, sitioId) => api("POST", "/qr/verificar", TG, { payload, ...(sitioId ? { sitioId } : {}) });
  assert.equal((await ver(qa.body.payload)).status, 200);
  assert.equal((await ver(qa.body.payload, siteA)).status, 200);
  assert.equal((await ver(qa.body.payload, siteB)).status, 400, "QR de otro sitio");
  const p = qa.body.payload.split(".");
  const flip = (c) => (c === "A" ? "B" : "A");
  assert.equal((await ver([p[0], p[1], p[2], flip(p[3][0]) + p[3].slice(1)].join("."))).status, 400, "firma alterada");
  assert.equal((await ver([p[0], p[1], "2", p[3]].join("."))).status, 400, "versión alterada");
  assert.equal((await ver([p[0], siteB, p[2], p[3]].join("."))).status, 400, "firma de A usada en B");
  for (const basura of ["", "x", "MPC1.a.b.c", "MPC1..1.x", `${qa.body.payload}.extra`, "A".repeat(500)])
    assert.equal((await ver(basura)).status, 400, basura.slice(0, 20));
  assert.equal((await api("POST", "/qr/verificar", null, { payload: qa.body.payload })).status, 401, "requiere sesión");

  // Regenerar invalida el anterior
  const viejo = qa.body.payload;
  const reg = await api("POST", "/admin/sitios/regenerar-qr", A, { id: siteA });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.version, 2);
  assert.equal((await ver(viejo)).status, 400, "el QR viejo ya no sirve");
  const nuevo = await api("GET", `/sitios/qr?id=${siteA}`, A);
  assert.notEqual(nuevo.body.payload, viejo);
  assert.equal((await ver(nuevo.body.payload)).status, 200);
  assert.equal((await api("POST", "/admin/sitios/regenerar-qr", T1, { id: siteA })).status, 403, "el supervisor no regenera");

  // Mismo contenido firmado con OTRA llave: rechazado
  const otro = { ...env, QR_SECRET: "otra-llave-completamente-distinta-0123456789" };
  const { generarPayload } = await import("../src/qr.js");
  const falso = await generarPayload(otro, siteA, 2);
  assert.equal((await ver(falso)).status, 400, "firmado con otra llave");
});

test("turnos: empalmes rechazados (mismo sitio, otro sitio); turnos consecutivos permitidos", async () => {
  const { A, mkG, mkSitio } = await mundo();
  const g = await mkG("G001", "Gael");
  const s1 = await mkSitio("Sitio 1");
  const s2 = await mkSitio("Sitio 2");
  const d = enDias(5);
  const lote = (sitioId, plantilla, extra = {}) => api("POST", "/turnos/asignar-lote", A, { sitioId, plantilla, desde: d, hasta: d, guardiaUid: g, ...extra });

  assert.equal((await lote(s1, "diurno")).status, 201);
  const otroSitio = await lote(s2, "personalizada", { horaInicio: "10:00", horaFin: "14:00" });
  assert.equal(otroSitio.status, 409);
  assert.equal(otroSitio.body.error, "empalme", "no puede estar en dos sitios a la vez");
  assert.equal((await lote(s1, "diurno")).status, 409, "mismo sitio, mismo horario");
  assert.equal((await lote(s2, "personalizada", { horaInicio: "18:00", horaFin: "20:00" })).status, 409, "empalme parcial");
  assert.equal((await lote(s2, "nocturno")).status, 201, "consecutivo (19:00 justo al terminar el diurno) sí");
  assert.equal(docsDe("turnos").length, 2, "los rechazados no dejaron turnos a medias");
  assert.equal((await lote(s2, "diurno", { desde: enDias(6), hasta: enDias(6) })).status, 201, "el diurno siguiente empieza justo cuando termina el nocturno");
  assert.equal((await lote(s1, "personalizada", { desde: enDias(6), hasta: enDias(6), horaInicio: "06:00", horaFin: "08:00" })).status, 409, "pero 06:00-08:00 se empalma con el final del nocturno");
});

test("turnos: vacantes (puestos sin cubrir), asignar con validación y cancelar", async () => {
  const { A, mkG, mkSitio } = await mundo();
  const g = await mkG("G001", "Gael");
  const s1 = await mkSitio("Sitio 1");
  const s2 = await mkSitio("Sitio 2");
  const d = enDias(5);
  assert.equal((await api("POST", "/turnos/asignar-lote", A, { sitioId: s1, plantilla: "diurno", desde: d, hasta: d })).status, 201);
  assert.equal((await api("POST", "/turnos/asignar-lote", A, { sitioId: s2, plantilla: "diurno", desde: d, hasta: d })).status, 201);
  const [t1, t2] = docsDe("turnos").sort((a, b) => a.sitioId.localeCompare(b.sitioId));
  assert.ok(docsDe("turnos").every((t) => t.guardiaUid === null), "vacantes");
  assert.equal((await api("POST", "/turnos/asignar", A, { turnoId: t1.id, guardiaUid: g })).status, 200);
  const dup = await api("POST", "/turnos/asignar", A, { turnoId: t2.id, guardiaUid: g });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "empalme");
  assert.deepEqual(val(doc(`usuarios/${g}`).sitiosAsignados ? { arrayValue: doc(`usuarios/${g}`).sitiosAsignados.arrayValue } : 0), [t1.sitioId]);
  assert.equal((await api("POST", "/turnos/cancelar", A, { turnoId: t1.id })).status, 200);
  assert.deepEqual(val({ arrayValue: doc(`usuarios/${g}`).sitiosAsignados.arrayValue }), [], "al cancelar pierde el acceso al sitio");
  assert.equal((await api("POST", "/turnos/asignar", A, { turnoId: t2.id, guardiaUid: g })).status, 200, "ya sin empalme");
  assert.equal((await api("POST", "/turnos/asignar", A, { turnoId: t2.id, guardiaUid: null })).status, 200, "se puede liberar");
});

test("turnos: validaciones (pasado, rango, guardia inválido, plantilla)", async () => {
  const { A, mkG, mkSitio, mkS } = await mundo();
  const g = await mkG("G001", "Gael");
  const s = await mkS("sara@marpec.mx", "Sara");
  const sid = await mkSitio("Sitio");
  const post = (b) => api("POST", "/turnos/asignar-lote", A, { sitioId: sid, plantilla: "diurno", desde: enDias(5), hasta: enDias(5), ...b });
  assert.equal((await post({ desde: enDias(-3), hasta: enDias(-3) })).status, 400, "pasado");
  assert.equal((await post({ hasta: enDias(90) })).status, 400, "rango > 62 días");
  assert.equal((await post({ hasta: enDias(4) })).status, 400, "fin < inicio");
  assert.equal((await post({ plantilla: "turbo" })).status, 400);
  assert.equal((await post({ desde: "2026-13-45" })).status, 400);
  assert.equal((await post({ guardiaUid: s })).status, 400, "un supervisor no puede cubrir un turno");
  assert.equal((await post({ guardiaUid: "no-existe" })).status, 400);
  assert.equal((await post({ sitioId: "no-existe" })).status, 404);
  assert.equal((await post({ guardiaUid: g })).status, 201);
});

test("supervisor: solo gestiona turnos de SUS sitios", async () => {
  const { A, mkG, mkS, mkSitio } = await mundo();
  const g = await mkG("G001", "Gael");
  const s1 = await mkS("s1@marpec.mx", "Sup Uno");
  const s2 = await mkS("s2@marpec.mx", "Sup Dos");
  const mio = await mkSitio("Mío", s1);
  const ajeno = await mkSitio("Ajeno", s2);
  const T1 = await w.idToken(s1, "supervisor");
  const d = enDias(5);
  assert.equal((await api("POST", "/turnos/asignar-lote", T1, { sitioId: mio, plantilla: "diurno", desde: d, hasta: d, guardiaUid: g })).status, 201);
  assert.equal((await api("POST", "/turnos/asignar-lote", T1, { sitioId: ajeno, plantilla: "diurno", desde: d, hasta: d })).status, 403);
  await api("POST", "/turnos/asignar-lote", A, { sitioId: ajeno, plantilla: "nocturno", desde: d, hasta: d });
  const tAjeno = docsDe("turnos").find((t) => t.sitioId === ajeno);
  assert.equal((await api("POST", "/turnos/asignar", T1, { turnoId: tAjeno.id, guardiaUid: g })).status, 403);
  assert.equal((await api("POST", "/turnos/cancelar", T1, { turnoId: tAjeno.id })).status, 403);
  assert.equal(docsDe("turnos").find((t) => t.id === tAjeno.id).estado, "programado");
  const tMio = docsDe("turnos").find((t) => t.sitioId === mio);
  assert.equal((await api("POST", "/turnos/cancelar", T1, { turnoId: tMio.id })).status, 200);
  // y no puede editar sitios, personal ni config
  assert.equal((await api("POST", "/admin/sitios/actualizar", T1, { id: mio, nombre: "Hack" })).status, 403);
  assert.equal((await api("POST", "/admin/usuarios/restablecer-pin", T1, { numero: "G001", pin: "1234" })).status, 403);
});

test("el supervisor de un sitio cambia: los turnos siguen al nuevo supervisor", async () => {
  const { A, mkS, mkSitio } = await mundo();
  const s1 = await mkS("s1@marpec.mx", "Uno");
  const s2 = await mkS("s2@marpec.mx", "Dos");
  const sid = await mkSitio("Sitio", s1);
  await api("POST", "/turnos/asignar-lote", A, { sitioId: sid, plantilla: "diurno", desde: enDias(5), hasta: enDias(6) });
  assert.ok(docsDe("turnos").every((t) => t.supervisorUid === s1));
  assert.equal((await api("POST", "/admin/sitios/actualizar", A, { id: sid, supervisorUid: s2 })).status, 200);
  assert.ok(docsDe("turnos").every((t) => t.supervisorUid === s2));
  assert.equal((await api("POST", "/turnos/asignar-lote", await w.idToken(s1, "supervisor"), { sitioId: sid, plantilla: "diurno", desde: enDias(8), hasta: enDias(8) })).status, 403);
});

test("configuración de empresa: valida y guarda (solo admin)", async () => {
  const { A } = await mundo();
  const ok = { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3 };
  assert.equal((await api("POST", "/admin/config", A, ok)).status, 200);
  const c = doc("configuracion/empresa");
  assert.equal(val(c.toleranciaRetardoMin), 10);
  assert.equal(val(c.limiteFaltaMin), 30);
  assert.equal(val(c.retardosPorFalta), 3);
  assert.equal(val(c.zonaHoraria), "America/Hermosillo");
  for (const m of [{ ...ok, limiteFaltaMin: 10 }, { ...ok, toleranciaRetardoMin: -1 }, { ...ok, retardosPorFalta: 0 }, { ...ok, limiteFaltaMin: "30" }, { ...ok, retardosPorFalta: 2.5 }, { limiteFaltaMin: 30 }])
    assert.equal((await api("POST", "/admin/config", A, m)).status, 400, JSON.stringify(m));
});

test("auditoría: cada cambio queda registrado (quién, qué, cuándo), sin datos sensibles", async () => {
  const { adminUid, A, mkG, mkSitio } = await mundo();
  const g = await mkG("G001", "Gael", "4821");
  const sid = await mkSitio("Plaza");
  await api("POST", "/admin/usuarios/restablecer-pin", A, { numero: "G001", pin: "9753" });
  await api("POST", "/turnos/asignar-lote", A, { sitioId: sid, plantilla: "diurno", desde: enDias(5), hasta: enDias(5), guardiaUid: g });
  await api("POST", "/admin/usuarios/baja", A, { uid: g });
  await api("POST", "/admin/config", A, { toleranciaRetardoMin: 5, limiteFaltaMin: 20, retardosPorFalta: 2 });
  const logs = docsDe("auditoria");
  const acciones = logs.map((l) => l.accion);
  for (const a of ["personal.alta", "sitio.alta", "personal.pin_restablecido", "turnos.crear", "personal.baja", "config.guardar"])
    assert.ok(acciones.includes(a), `falta ${a}`);
  assert.ok(logs.every((l) => l.actorUid === adminUid && l.actorRol === "admin" && l.ts && l.accion && l.objetivo));
  const todo = JSON.stringify(logs);
  assert.ok(!todo.includes("4821") && !todo.includes("9753"), "la auditoría no contiene PIN");
  assert.ok(!/hash|salt|password/i.test(todo));
});

test("auditoría inmutable: el Worker nunca actualiza ni borra auditoria/", async () => {
  const { A, mkG } = await mundo();
  await mkG("G001", "Gael");
  await api("POST", "/admin/usuarios/baja", A, { uid: "g-G001" });
  const antes = JSON.stringify(docsDe("auditoria"));
  const llamadasDelete = w.calls.filter((c) => c.startsWith("DELETE") && c.includes("auditoria"));
  assert.equal(llamadasDelete.length, 0);
  // Ningún commit usa updateMask sobre auditoria/ (se verifica por código): el contenido previo no cambia
  await api("POST", "/admin/config", A, { toleranciaRetardoMin: 5, limiteFaltaMin: 20, retardosPorFalta: 2 });
  const despues = docsDe("auditoria");
  assert.ok(JSON.stringify(despues).includes(antes.slice(1, -1).split("},{")[0]), "los registros anteriores permanecen idénticos");
});

test("un token de admin ya dado de baja ya no funciona (perfil inactivo)", async () => {
  const { adminUid, A } = await mundo();
  w.docs.get(`${BASE}/usuarios/${adminUid}`).activo = { booleanValue: false };
  assert.equal((await api("GET", "/me", A)).status, 403);
  assert.equal((await api("POST", "/admin/sitios", A, { nombre: "X" })).status, 403);
});

test("bitácora: la marca prueba la decide el SERVIDOR (actor o registro afectado), nunca la cabecera x-prueba", async () => {
  const { A, mkSitio } = await mundo();
  const mkSup = async (email, prueba) => {
    const r = await api("POST", "/admin/usuarios", A, { rol: "supervisor", nombre: "Sup " + email, email, password: PASS, ...(prueba ? { prueba: true } : {}) });
    return r.body.uid;
  };
  const real = await mkSup("real@marpec.mx", false);
  const prueba = await mkSup("prueba@marpec.mx", true);
  const sitioReal = await mkSitio("Sitio real", real);
  const sitioPrueba = (await api("POST", "/admin/sitios", A, { nombre: "Sitio prueba", supervisorUid: prueba, prueba: true })).body.id;
  const T = (uid) => w.idToken(uid, "supervisor");
  const X = { "x-prueba": "1" };
  const n0 = docsDe("auditoria").length;
  const nuevas = () => docsDe("auditoria").slice(n0);

  // 1) Supervisor REAL que envía x-prueba (en cabecera y en el cuerpo): bitácora SIN marca
  const r1 = await api("POST", "/turnos/asignar-lote", await T(real), { sitioId: sitioReal, plantilla: "diurno", desde: enDias(5), hasta: enDias(5), prueba: true }, "1.1.1.1", X);
  assert.equal(r1.status, 201);
  const turnoReal = docsDe("turnos").find((x) => x.sitioId === sitioReal);
  assert.equal(turnoReal.prueba, undefined, "el cuerpo no puede marcar los turnos como prueba");
  const e1 = nuevas().filter((x) => x.accion === "turnos.crear");
  assert.equal(e1.length, 1);
  assert.equal(e1[0].prueba, undefined, "x-prueba no esconde la bitácora de un supervisor real");
  assert.equal((await api("POST", "/turnos/cancelar", await T(real), { turnoId: turnoReal.id }, "1.1.1.1", X)).status, 200);
  assert.ok(nuevas().filter((x) => x.actorUid === real).every((x) => x.prueba === undefined));

  // 2) Actor con perfil prueba=true → marcada
  assert.equal((await api("POST", "/turnos/asignar-lote", await T(prueba), { sitioId: sitioPrueba, plantilla: "diurno", desde: enDias(6), hasta: enDias(6) })).status, 201);
  assert.ok(nuevas().filter((x) => x.actorUid === prueba).every((x) => x.prueba === true));
  assert.equal(docsDe("turnos").find((x) => x.sitioId === sitioPrueba).prueba, true, "los turnos heredan prueba del sitio");

  // 3) Registro afectado con prueba=true (actor admin REAL) → marcada; registro real → no
  const antes = nuevas().length;
  await api("POST", "/admin/sitios/actualizar", A, { id: sitioPrueba, consignas: "x" });
  await api("POST", "/admin/sitios/actualizar", A, { id: sitioReal, consignas: "y" });
  await api("POST", "/admin/sitios/regenerar-qr", A, { id: sitioPrueba });
  const e3 = nuevas().slice(antes);
  assert.equal(e3.find((x) => x.accion === "sitio.editar" && x.objetivo === sitioPrueba).prueba, true);
  assert.equal(e3.find((x) => x.accion === "sitio.editar" && x.objetivo === sitioReal).prueba, undefined);
  assert.equal(e3.find((x) => x.accion === "sitio.qr_regenerado").prueba, true);
  // baja de un usuario de prueba (admin real) → marcada; baja de un usuario real → no
  await api("POST", "/admin/usuarios/baja", A, { uid: prueba });
  await api("POST", "/admin/usuarios/baja", A, { uid: real });
  const bajas = nuevas().filter((x) => x.accion === "personal.baja");
  assert.equal(bajas.find((x) => x.objetivo === prueba).prueba, true);
  assert.equal(bajas.find((x) => x.objetivo === real).prueba, undefined);
  // 4) la cabecera ya no se usa en ningún sitio del Worker
  const fuente = (await import("node:fs")).readFileSync(new URL("../src/common.js", import.meta.url), "utf8")
    + (await import("node:fs")).readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.ok(!/x-prueba/i.test(fuente), "el Worker no referencia x-prueba");
});
