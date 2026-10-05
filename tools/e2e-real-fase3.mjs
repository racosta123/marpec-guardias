// Pruebas de seguridad y de negocio de la FASE 3 EN REAL (Firebase + Worker + R2 desplegados).
// Uso: node tools/e2e-real-fase3.mjs <uid-admin>      (tarda ~4 min: espera a que termine un turno de prueba)
// Crea datos de PRUEBA (marcados prueba=true por herencia del sitio): node tools/borrar-pruebas.mjs --aplicar
import { execSync } from "node:child_process";
import { createSign, randomBytes, randomInt } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "marpec-guardias";
const W = "https://marpec-guardias-proxy.acosta4770.workers.dev";
const KEY = /apiKey:\s*"([^"]+)"/.exec(readFileSync("js/config.js", "utf8"))[1]; // apiKey web (pública)
const ORIGIN = "https://racosta123.github.io";
const SA = `marpec-worker@${PROJECT}.iam.gserviceaccount.com`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const adminUid = process.argv[2];
if (!adminUid) throw new Error("falta uid del admin");
const SITE = { lat: 29.0729, lng: -110.9559 };

let fallos = 0;
const inicioCorrida = new Date().toISOString();
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✖"} ${n}${extra ? "  → " + extra : ""}`); if (!ok) fallos++; };
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (f) => (f === undefined ? undefined : "stringValue" in f ? f.stringValue : "integerValue" in f ? Number(f.integerValue) : "booleanValue" in f ? f.booleanValue : "nullValue" in f ? null : "doubleValue" in f ? f.doubleValue : f);
const plano = (d) => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)]));

async function canjear(customToken) {
  const r = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }));
  return r.body.idToken;
}
function adminCustomToken() {
  const f = join(tmpdir(), `k-${randomBytes(6).toString("hex")}.json`);
  try {
    execSync(`gcloud iam service-accounts keys create "${f}" --iam-account=${SA} --project=${PROJECT}`, { stdio: "pipe" });
    const k = JSON.parse(readFileSync(f, "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b({ alg: "RS256", typ: "JWT" })}.${b({ iss: SA, sub: SA, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iat: now, exp: now + 300, uid: adminUid, claims: { rol: "admin" } })}`;
    return { token: `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(k.private_key).toString("base64url")}`, cleanup: () => execSync(`gcloud iam service-accounts keys delete ${k.private_key_id} --iam-account=${SA} --project=${PROJECT} --quiet`, { stdio: "pipe" }) };
  } finally { rmSync(f, { force: true }); }
}
const api = (path, { method = "POST", token, body } = {}) =>
  fetch(`${W}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ct: r.headers.get("content-type") || "", raw: r, body: (r.headers.get("content-type") || "").includes("json") ? await r.json().catch(() => ({})) : null }));
const fsGet = (path, token) => fetch(`${FS}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, doc: r.status === 200 ? plano(await r.json()) : null }));

// JPEG mínimo válido (FFD8FF … FFD9) de n bytes
const jpeg = (n = 4000) => { const b = Buffer.alloc(n, 7); b.set([0xff, 0xd8, 0xff, 0xe0], 0); b.set([0xff, 0xd9], n - 2); return b; };
const FOTO = jpeg(4000).toString("base64");

// ---------------------------------------------------------------- preparación
const ac = adminCustomToken();
await espera(10000);
let A;
try { A = await canjear(ac.token); } finally { ac.cleanup(); console.log("llave temporal revocada"); }
check("token de admin", Boolean(A));

const nowLocal = new Date(Date.now() - 7 * 3600e3);
if (nowLocal.getUTCHours() === 23 && nowLocal.getUTCMinutes() > 40 || nowLocal.getUTCHours() === 0 && nowLocal.getUTCMinutes() < 20) throw new Error("Ejecuta la prueba lejos de la medianoche (los turnos de prueba duran minutos).");
const hhmm = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(11, 16);
const fechaHoy = new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10);
const minuto = (ms, redondeo) => Math[redondeo](ms / 60000) * 60000;
const t0 = Date.now();
const ini = minuto(t0 - 12 * 60000, "floor"); // 12-13 min tarde → RETARDO (tolerancia 10, límite 30)
const fin = minuto(t0 + 100000, "ceil");        // termina en ~1.5-2.5 min
const finSucesor = fin + 30 * 60000;

const sx = randomBytes(3).toString("hex");
const pins = Object.fromEntries(["A", "B", "C", "D"].map((k) => [k, String(randomInt(1000, 9999))]));
const nums = Object.fromEntries(["A", "B", "C", "D"].map((k) => [k, `F3${sx}${k}`.toUpperCase()]));
const pass = randomBytes(18).toString("base64url") + "aA1";
const mk = (b) => api("/admin/usuarios", { token: A, body: { ...b, prueba: true } });
const g = {};
for (const k of ["A", "B", "C", "D"]) g[k] = (await mk({ rol: "guardia", nombre: `PRUEBA F3 Guardia ${k}`, numeroEmpleado: nums[k], pin: pins[k] })).body.uid;
const s1 = (await mk({ rol: "supervisor", nombre: "PRUEBA F3 Sup 1", email: `prueba-f3-1-${sx}@prueba.invalid`, password: pass })).body.uid;
const s2 = (await mk({ rol: "supervisor", nombre: "PRUEBA F3 Sup 2", email: `prueba-f3-2-${sx}@prueba.invalid`, password: pass })).body.uid;
const sitio = async (nombre, sup) => (await api("/admin/sitios", { token: A, body: { nombre, supervisorUid: sup, ...SITE, precisionM: 6, radioM: 100, consignas: "PRUEBA", prueba: true } })).body.id;
const S1 = await sitio("PRUEBA F3 Sitio 1", s1), S2 = await sitio("PRUEBA F3 Sitio 2", s2), S3 = await sitio("PRUEBA F3 Sitio 3", s2);
check("personal y sitios de prueba creados", Boolean(g.A && g.B && g.C && g.D && s1 && s2 && S1 && S2 && S3));
const lote = (sitioId, guardiaUid, desde, hasta) => api("/turnos/asignar-lote", { token: A, body: { sitioId, plantilla: "personalizada", desde: fechaHoy, hasta: fechaHoy, horaInicio: hhmm(desde), horaFin: hhmm(hasta), guardiaUid } });
check("turnos de prueba: S1(A), S2(B→C), S3(D→vacante)", (await Promise.all([lote(S1, g.A, ini, fin), lote(S2, g.B, ini, fin), lote(S2, g.C, fin, finSucesor), lote(S3, g.D, ini, fin), lote(S3, null, fin, finSucesor)])).every((r) => r.status === 201));
// turno de mañana para probar la ventana de entrada
const manana = new Date(Date.now() - 7 * 3600e3 + 86400e3).toISOString().slice(0, 10);
check("turno de mañana (fuera de ventana)", (await api("/turnos/asignar-lote", { token: A, body: { sitioId: S1, plantilla: "diurno", desde: manana, hasta: manana, guardiaUid: g.A } })).status === 201);
const turnos = (await (await fetch(`${FS}:runQuery`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "turnos" }], limit: 300 } }) })).json()).filter((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(), ...plano(x.document) }));
const T = (sitioId, guardiaUid, inicio) => turnos.find((t) => t.sitioId === sitioId && t.guardiaUid === guardiaUid && (!inicio || t.inicioMs === inicio));
const t1 = T(S1, g.A, ini).id, t2 = T(S2, g.B, ini).id, t3 = T(S2, g.C, fin).id, t4 = T(S3, g.D, ini).id, tManana = turnos.find((t) => t.sitioId === S1 && t.guardiaUid === g.A && t.inicioMs > fin + 3600e3)?.id;

const login = async (k) => { const l = await api("/auth/guardia", { body: { numero: nums[k], pin: pins[k] } }); return l.body.token ? canjear(l.body.token) : null; };
const TK = { A: await login("A"), B: await login("B"), C: await login("C"), D: await login("D") };
const sl = (n) => fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `prueba-f3-${n}-${sx}@prueba.invalid`, password: pass, returnSecureToken: true }) }).then(j).then((r) => r.body.idToken);
const [S1T, S2T] = [await sl(1), await sl(2)];
check("sesiones de 4 guardias y 2 supervisores", Object.values(TK).every(Boolean) && Boolean(S1T && S2T));
const qr = async (sitioId) => (await api(`/sitios/qr?id=${sitioId}`, { method: "GET", token: A })).body.payload;
const QR = { 1: await qr(S1), 2: await qr(S2), 3: await qr(S3) };
const marcar = (tipo, token, turnoId, o = {}) => api(`/marcas/${tipo}`, { token, body: { turnoId, lat: SITE.lat, lng: SITE.lng, precisionM: 12, qr: QR[1], foto: FOTO, horaDispositivoMs: Date.UTC(2001, 0, 1), ...o } });

// ---------------------------------------------------------------- rechazos
const rej = async (nombre, r, status, error) => check(nombre, r.status === status && (!error || r.body.error === error), `${r.status} ${r.body?.error || ""}`);
await rej("rechazo: fuera del perímetro", await marcar("entrada", TK.A, t1, { lat: SITE.lat + 0.01 }), 403, "fuera_perimetro");
await rej("rechazo: precisión peor que el radio", await marcar("entrada", TK.A, t1, { precisionM: 150 }), 400, "gps_precision");
await rej("rechazo: QR alterado", await marcar("entrada", TK.A, t1, { qr: QR[1].replace(/.$/, QR[1].endsWith("A") ? "B" : "A") }), 400, "qr_invalido");
await rej("rechazo: QR de otro sitio", await marcar("entrada", TK.A, t1, { qr: QR[2] }), 400, "qr_invalido");
await rej("rechazo: foto que no es JPEG de cámara", await marcar("entrada", TK.A, t1, { foto: Buffer.from("a".repeat(3000)).toString("base64") }), 400, "foto_invalida");
{ const r = await marcar("entrada", TK.A, t1, { foto: jpeg(200 * 1024).toString("base64") }); check("rechazo: foto enorme (el cuerpo supera el límite)", r.status === 413 || r.status === 400, `${r.status} ${r.body?.error || ""}`); }
await rej("rechazo: turno de OTRO guardia (no se marca por otro)", await marcar("entrada", TK.B, t1), 403);
await rej("rechazo: sin turno activo / fuera de ventana (turno de mañana)", await marcar("entrada", TK.A, tManana), 409, "fuera_ventana");
await rej("rechazo: supervisor no marca", await api("/marcas/entrada", { token: S1T, body: { turnoId: t1 } }), 403);
await rej("rechazo: admin no marca", await api("/marcas/entrada", { token: A, body: { turnoId: t1 } }), 403);
await rej("rechazo: sin sesión", await api("/marcas/entrada", { body: { turnoId: t1 } }), 401);
await rej("rechazo: salida sin entrada", await marcar("salida", TK.A, t1), 409, "sin_entrada");

// ---------------------------------------------------------------- entrada válida y hora del servidor
const antes = Date.now();
const e1 = await marcar("entrada", TK.A, t1);
check("entrada válida (A)", e1.status === 201, JSON.stringify(e1.body));
const marcaA = (await fsGet(`marcas/${t1}_entrada`, TK.A)).doc;
check("la hora la pone el SERVIDOR aunque el celular diga 2001", marcaA && Math.abs(marcaA.tsMs - Date.now()) < 120000 && marcaA.tsMs >= antes - 5000 && marcaA.horaDispositivoMs === Date.UTC(2001, 0, 1), marcaA ? `servidor=${new Date(marcaA.tsMs).toISOString()}` : "sin marca");
check("se guardó GPS, precisión y distancia", marcaA && marcaA.lat === SITE.lat && marcaA.precisionM === 12 && marcaA.distanciaM < 1);
await rej("entrada duplicada rechazada", await marcar("entrada", TK.A, t1), 409, "ya_marcada");
const asisA = (await fsGet(`asistencias/${t1}`, TK.A)).doc;
check("RETARDO calculado en el servidor (12-13 min tarde, hora de Hermosillo)", asisA && asisA.retardo === true && asisA.retardoMin >= 12 && asisA.retardoMin <= 14 && asisA.falta === false && asisA.fecha === fechaHoy, asisA ? `retardoMin=${asisA.retardoMin}` : "");

// ---------------------------------------------------------------- aislamiento (reglas reales + Worker)
check("guardia A lee SU marca y SU asistencia", marcaA !== null && asisA !== null);
await espera(1500);
check("guardia A NO lee marcas ni asistencias de otro", (await Promise.all([fsGet(`marcas/${t2}_entrada`, TK.A), fsGet(`asistencias/${t2}`, TK.A), fsGet(`asistencias/${t4}`, TK.A)])).every((r) => r.status === 403));
check("supervisor NO lee marcas (GPS/ruta de foto) ni asistencias de otro sitio", (await fsGet(`marcas/${t1}_entrada`, S1T)).status === 403 && (await fsGet(`asistencias/${t2}`, S1T)).status === 403);
check("supervisor SÍ lee asistencias de su sitio", (await fsGet(`asistencias/${t1}`, S1T)).status === 200);
check("sin sesión no lee nada de asistencia", (await Promise.all([fsGet(`marcas/${t1}_entrada`), fsGet(`asistencias/${t1}`), fsGet(`ajustesAsistencia`), fsGet(`autorizaciones`)])).every((r) => r.status === 403));
const patch = await fetch(`${FS}/marcas/${t1}_entrada?updateMask.fieldPaths=tsMs`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ fields: { tsMs: { integerValue: "1" } } }) });
check("marcas inmutables: ni el admin las edita desde el cliente", patch.status === 403);
check("marcas inmutables: ni las borra", (await fetch(`${FS}/marcas/${t1}_entrada`, { method: "DELETE", headers: { authorization: `Bearer ${A}` } })).status === 403);

// ---------------------------------------------------------------- selfies (R2 privado)
const selfie = (token, marca) => api(`/selfies?marca=${marca}`, { method: "GET", token });
const sA = await selfie(A, `${t1}_entrada`);
const bytes = new Uint8Array(await sA.raw.arrayBuffer());
check("selfie: el admin la ve (JPEG íntegro desde R2)", sA.status === 200 && sA.ct === "image/jpeg" && bytes.length === 4000 && bytes[0] === 0xff && bytes[1] === 0xd8);
check("selfie: el supervisor del sitio la ve", (await selfie(S1T, `${t1}_entrada`)).status === 200);
check("selfie: otro supervisor NO", (await selfie(S2T, `${t1}_entrada`)).status === 403);
check("selfie: ni el propio guardia ni otro guardia", (await selfie(TK.A, `${t1}_entrada`)).status === 403 && (await selfie(TK.B, `${t1}_entrada`)).status === 403);
check("selfie: sin token o con token falso → 401", (await selfie(null, `${t1}_entrada`)).status === 401 && (await selfie("abc.def.ghi", `${t1}_entrada`)).status === 401);
check("selfie: el bucket R2 no tiene acceso público", (() => { try { const o = execSync("wrangler r2 bucket dev-url get marpec-guardias-selfies", { cwd: "worker", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return /disabled|not enabled|Public access is disabled/i.test(o); } catch (e) { return /disabled|not enabled|not found/i.test(String(e.stdout) + String(e.stderr)); } })());

// ---------------------------------------------------------------- relevo (S2: B sale, C entra) y autorización (S3: D sin relevo)
const q2 = (o) => ({ qr: QR[2], ...o });
await rej("relevo: B marca entrada", await marcar("entrada", TK.B, t2, q2({})), 201);
await rej("relevo: el SALIENTE no cierra si su relevo no ha llegado", await marcar("salida", TK.B, t2, q2({ notasEntrega: "Portón 2 con falla. Llaves en caseta." })), 409, "relevo_pendiente");
await rej("relevo: el ENTRANTE (C) marca entrada", await marcar("entrada", TK.C, t3, q2({})), 201);
await rej("relevo: ahora el saliente sí puede cerrar", await marcar("salida", TK.B, t2, q2({ notasEntrega: "Portón 2 con falla. Llaves en caseta." })), 201);
const notas = await api(`/relevo/notas?turnoId=${t3}`, { method: "GET", token: TK.C });
check("relevo: el entrante ve las notas de entrega", notas.body.hay === true && /Llaves en caseta/.test(notas.body.notas), JSON.stringify(notas.body).slice(0, 80));
check("relevo: nadie más las ve (otro guardia, supervisor)", (await api(`/relevo/notas?turnoId=${t3}`, { method: "GET", token: TK.A })).status === 403 && (await api(`/relevo/notas?turnoId=${t3}`, { method: "GET", token: S2T })).status === 403);

const q3 = (o) => ({ qr: QR[3], ...o });
await rej("autorización: D marca entrada", await marcar("entrada", TK.D, t4, q3({})), 201);
await rej("autorización: D no cierra sin relevo (el puesto siguiente está vacante)", await marcar("salida", TK.D, t4, q3({})), 409, "relevo_pendiente");
await rej("autorización: el guardia no se autoriza solo", await api("/relevo/autorizar-cierre", { token: TK.D, body: { turnoId: t4, motivo: "yo mismo me autorizo" } }), 403);
await rej("autorización: supervisor de OTRO sitio no puede", await api("/relevo/autorizar-cierre", { token: S1T, body: { turnoId: t4, motivo: "no es mi sitio" } }), 403);
await rej("autorización: el motivo es obligatorio", await api("/relevo/autorizar-cierre", { token: S2T, body: { turnoId: t4, motivo: "x" } }), 400);
await rej("autorización: el supervisor del sitio autoriza con motivo", await api("/relevo/autorizar-cierre", { token: S2T, body: { turnoId: t4, motivo: "El puesto siguiente está vacante; se cubre con apoyo." } }), 201);
const asis4 = (await fsGet(`asistencias/${t4}`, S2T)).doc;
check("autorización registrada con nombre y motivo", asis4 && asis4.cierreAutorizadoPor === "PRUEBA F3 Sup 2" && /vacante/.test(asis4.cierreMotivo), asis4 ? asis4.cierreAutorizadoPor : "");

// ---------------------------------------------------------------- espera a que termine el turno de A: salida tardía → HORAS EXTRA
const restante = fin + 75000 - Date.now();
if (restante > 0) { console.log(`  (esperando ${Math.ceil(restante / 1000)} s a que termine el turno para medir horas extra…)`); await espera(restante); }
await rej("salida de A (sin relevo previsto en S1) con notas", await marcar("salida", TK.A, t1, { notasEntrega: "Sin novedades." }), 201);
const asis1 = (await fsGet(`asistencias/${t1}`, TK.A)).doc;
check("HORAS EXTRA calculadas en el servidor (≥ 1 min), pendientes de autorización", asis1 && asis1.minutosExtra >= 1 && asis1.minutosExtra <= 3 && asis1.extraEstado === "pendiente" && asis1.estado === "cumplido", asis1 ? `extra=${asis1.minutosExtra} min` : "");
await rej("salida de D (autorizada) con extra pendiente", await marcar("salida", TK.D, t4, q3({ notasEntrega: "Cierre autorizado." })), 201);
const resolver = (token, body) => api("/extras/resolver", { token, body: { turnoId: t1, ...body } });
await rej("extras: el guardia no se las autoriza", await resolver(TK.A, { decision: "autorizado", motivo: "me las autorizo" }), 403);
await rej("extras: supervisor de otro sitio no puede", await resolver(S2T, { decision: "autorizado", motivo: "no es mi sitio" }), 403);
await rej("extras: el supervisor del sitio autoriza con motivo", await resolver(S1T, { decision: "autorizado", motivo: "Cubrió la entrega del puesto." }), 201);
const asis1b = (await fsGet(`asistencias/${t1}`, TK.A)).doc;
check("extras: queda «autorizado» con nombre y motivo", asis1b && asis1b.extraEstado === "autorizado" && asis1b.extraResueltoPor === "PRUEBA F3 Sup 1" && /entrega/.test(asis1b.extraMotivo));

// ---------------------------------------------------------------- ajustes
const ajuste = (token, body) => api("/ajustes", { token, body: { turnoId: t1, tipo: "entrada", fecha: fechaHoy, hora: hhmm(ini + 3 * 60000), ...body } });
await rej("ajuste: el guardia no se ajusta", await ajuste(TK.A, { motivo: "me corrijo yo mismo" }), 403);
await rej("ajuste: motivo obligatorio", await ajuste(S1T, { motivo: "" }), 400);
await rej("ajuste: supervisor de otro sitio no puede", await ajuste(S2T, { motivo: "no es mi sitio" }), 403);
await rej("ajuste: el supervisor del sitio lo registra con motivo", await ajuste(S1T, { motivo: "El celular tardó en sincronizar la hora." }), 201);
const marcaDespues = (await fsGet(`marcas/${t1}_entrada`, TK.A)).doc;
const asisAj = (await fsGet(`asistencias/${t1}`, TK.A)).doc;
check("ajuste: la MARCA ORIGINAL no cambió (mismo tsMs)", marcaDespues && marcaDespues.tsMs === marcaA.tsMs);
check("ajuste: el cálculo sí usa la hora ajustada (ya no hay retardo)", asisAj && asisAj.entradaMs === ini + 3 * 60000 && asisAj.retardo === false && asisAj.ajustes === 1 && asisAj.entradaOriginalMs === marcaA.tsMs);

// ---------------------------------------------------------------- reporte
const rep = (token) => api(`/reportes/asistencia?desde=${fechaHoy}&hasta=${fechaHoy}`, { method: "GET", token });
const rA = await rep(A), rS2 = await rep(S2T), rG = await rep(TK.A);
check("reporte: el admin ve los 4 turnos de prueba", rA.status === 200 && ["A", "B", "C", "D"].every((k) => rA.body.filas.some((f) => f.guardiaUid === g[k])));
check("reporte: el supervisor solo ve sus sitios (S2 y S3, no S1)", rS2.status === 200 && rS2.body.filas.every((f) => [S2, S3].includes(f.sitioId)) && rS2.body.filas.length >= 3);
check("reporte: el guardia no puede pedirlo", rG.status === 403);
check("reporte: incluye acumulado semanal con límite configurable por año", Array.isArray(rA.body.semanal));

// ---------------------------------------------------------------- bitácora de prueba
const bit = await fsGet("auditoria?pageSize=300", A);
const lista = await (await fetch(`${FS}/auditoria?pageSize=300`, { headers: { authorization: `Bearer ${A}` } })).json();
const nuevas = (lista.documents || []).filter((d) => d.createTime >= inicioCorrida);
check("bitácora: TODAS las entradas de esta corrida llevan prueba=true (decidido por el servidor)", nuevas.length > 8 && nuevas.every((d) => d.fields.prueba?.booleanValue === true), `${nuevas.filter((d) => d.fields.prueba?.booleanValue === true).length}/${nuevas.length}`);
void bit;

console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS EN REAL (FASE 3) PASARON");
process.exit(fallos ? 1 : 0);
