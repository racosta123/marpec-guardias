// Licencia de demostración: vencimiento al final del día (hora de Hermosillo), 403 "demo_vencido" en todo menos el
// estado público, cron apagado, aviso push una sola vez a 10 días y modo producción sin vencimiento.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { avisarVencimiento, estadoLicencia, leerLicencia, resetLicencia } from "../src/licencia.js";
import { createWorld, call, PROJECT } from "./harness.js";

let w, env, ahora;
const realNow = Date.now;
Date.now = () => ahora;
// Vence el 2026-11-04 a las 23:59:59.999 hora de Hermosillo (UTC-7) = 2026-11-05T06:59:59.999Z.
const VENCE = Date.parse("2026-11-05T06:59:59.999Z");
const INICIO = Date.parse("2026-10-05T07:00:00.000Z");
const RUTA = `projects/${PROJECT}/databases/(default)/documents/config/licencia`;
const poner = (modo, venceMs = VENCE) => { w.docs.set(RUTA, { modo: { stringValue: modo }, inicio: { timestampValue: new Date(INICIO).toISOString() }, vence: { timestampValue: new Date(venceMs).toISOString() } }); resetLicencia(); };

beforeEach(async () => {
  if (w) w.restore();
  ahora = Date.parse("2026-10-20T18:00:00Z");
  w = await createWorld();
  env = w.env;
  poner("demo");
});
after(() => { w.restore(); Date.now = realNow; });

const RUTAS_PROTEGIDAS = [
  ["POST", "/auth/guardia", { numero: "G001", pin: "4821" }],
  ["GET", "/me"],
  ["POST", "/setup/primer-admin"],
  ["POST", "/panico", { mantenidoMs: 3000 }],
  ["GET", "/catalogo/incidencias"],
  ["POST", "/admin/usuarios", {}],
  ["GET", "/push/clave"],
];

test("vigente: el servicio responde normal y el estado público informa los días que faltan", async () => {
  const r = await call(worker, env, "POST", "/auth/guardia", { body: { numero: "G001", pin: "4821" } });
  assert.notEqual(r.status, 403, "una demo vigente no devuelve demo_vencido");
  const e = await (await call(worker, env, "GET", "/licencia/estado")).json();
  assert.deepEqual([e.modo, e.vencido, e.venceDia, e.diasRestantes], ["demo", false, "2026-11-04", 15]);
  assert.deepEqual(Object.keys(e).sort(), ["ahoraMs", "diasRestantes", "modo", "venceDia", "venceMs", "vencido"], "estado mínimo: nada de datos del cliente");
});

test("vence al FINAL del día 30 en hora de Hermosillo, ni un milisegundo antes", async () => {
  ahora = VENCE - 1; // 23:59:59.998 del último día
  assert.notEqual((await call(worker, env, "GET", "/catalogo/incidencias")).status, 403);
  resetLicencia(); ahora = VENCE + 1; // ya es el día siguiente en Hermosillo
  const r = await call(worker, env, "GET", "/catalogo/incidencias");
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "demo_vencido");
});

test("vencida: TODOS los endpoints responden 403 demo_vencido salvo el estado público", async () => {
  ahora = VENCE + 3600e3;
  for (const [m, p, body] of RUTAS_PROTEGIDAS) {
    const r = await call(worker, env, m, p, { body });
    const j = await r.json();
    assert.deepEqual([r.status, j.error], [403, "demo_vencido"], `${m} ${p}`);
    assert.match(j.mensaje, /Periodo de demostración concluido.*Diagonal Catorce/);
  }
  const e = await call(worker, env, "GET", "/licencia/estado");
  assert.equal(e.status, 200);
  const j = await e.json();
  assert.deepEqual([j.vencido, j.diasRestantes], [true, 0]);
  assert.equal((await call(worker, env, "GET", "/ruta-que-no-existe")).status, 404, "las rutas inexistentes siguen siendo 404");
});

test("los datos NO se borran al vencer", async () => {
  w.docs.set(`projects/${PROJECT}/databases/(default)/documents/sitios/s1`, { nombre: { stringValue: "Planta" } });
  const antes = w.docs.size;
  ahora = VENCE + 86400e3 * 40;
  await call(worker, env, "GET", "/me");
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  assert.equal(w.docs.size, antes);
});

test("sin documento de licencia el servicio se cierra igual que vencido", async () => {
  w.docs.delete(RUTA); resetLicencia();
  const r = await call(worker, env, "GET", "/me");
  assert.deepEqual([r.status, (await r.json()).error], [403, "demo_vencido"]);
  assert.equal((await (await call(worker, env, "GET", "/licencia/estado")).json()).modo, "sin_licencia");
});

test("modo producción: sin vencimiento aunque la fecha ya pasó", async () => {
  poner("produccion"); ahora = VENCE + 86400e3 * 400;
  assert.notEqual((await call(worker, env, "GET", "/catalogo/incidencias")).status, 403);
  assert.deepEqual(await (await call(worker, env, "GET", "/licencia/estado")).json().then(({ modo, vencido }) => ({ modo, vencido })), { modo: "produccion", vencido: false });
});

test("extender la fecha reabre el servicio (tras el caché de 30 s)", async () => {
  ahora = VENCE + 1000;
  assert.equal((await call(worker, env, "GET", "/catalogo/incidencias")).status, 403);
  poner("demo", VENCE + 30 * 86400e3);
  assert.notEqual((await call(worker, env, "GET", "/catalogo/incidencias")).status, 403);
});

test("un fallo transitorio al leer la licencia reutiliza el último valor conocido", async () => {
  assert.equal((await leerLicencia(env, ahora)).modo, "demo");
  const f = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).includes("/config/licencia") ? new Response("{}", { status: 503 }) : f(u, o));
  try {
    assert.equal((await leerLicencia(env, ahora + 60000)).modo, "demo");
  } finally { globalThis.fetch = f; }
});

test("cron: vencida no genera alertas ni notificaciones; vigente sí corre", async () => {
  const consultas = () => w.calls.filter((c) => c.includes(":runQuery")).length;
  w.calls.length = 0;
  ahora = VENCE + 3600e3;
  const trabajos = [];
  await worker.scheduled({}, env, { waitUntil: (p) => trabajos.push(p) });
  await Promise.all(trabajos);
  const vencido = w.calls.filter((c) => c.includes(":commit")).length;
  assert.equal(vencido, 0, "sin escrituras (alertas/avisos) con la demo vencida");
  poner("demo"); resetLicencia(); ahora = Date.parse("2026-10-20T18:00:00Z");
  w.calls.length = 0;
  const t2 = [];
  await worker.scheduled({}, env, { waitUntil: (p) => t2.push(p) });
  await Promise.all(t2);
  assert.ok(consultas() > 0, "con la demo vigente el cron sí consulta turnos y rondines");
});

test("aviso push: solo el día en que faltan 10 días y una sola vez", async () => {
  const lic = await leerLicencia(env, ahora);
  const dia = (iso) => Date.parse(`${iso}T18:00:00Z`);
  assert.equal(estadoLicencia(lic, dia("2026-10-25")).diasRestantes, 10);
  assert.equal((await avisarVencimiento(env, lic, dia("2026-10-24"))).repetida, undefined);
  assert.ok(![...w.docs.keys()].some((k) => k.includes("/pushEnviados/")), "a 11 días no se avisa");
  await avisarVencimiento(env, lic, dia("2026-10-25"));
  assert.ok([...w.docs.keys()].some((k) => k.endsWith("/pushEnviados/licencia-2026-11-04")), "a 10 días se registra el aviso");
  assert.equal((await avisarVencimiento(env, lic, dia("2026-10-25"))).repetida, true, "no se repite el mismo día");
  assert.equal((await avisarVencimiento(env, lic, dia("2026-10-26"))).enviados, 0, "a 9 días no vuelve a avisar");
});
