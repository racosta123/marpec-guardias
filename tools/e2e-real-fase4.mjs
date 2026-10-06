// Pruebas de seguridad y de negocio de la FASE 4 (rondines) EN REAL: Firebase + Worker + R2 desplegados.
// Uso: node tools/e2e-real-fase4.mjs <uid-admin>      (tarda ~8 min: espera a que venzan rondines de prueba)
// Crea datos de PRUEBA (prueba=true por herencia del sitio): node tools/borrar-pruebas.mjs --aplicar
import "./_referer.mjs"; // la clave web está restringida por Referer
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
const dec = (f) => (f === undefined ? undefined : "stringValue" in f ? f.stringValue : "integerValue" in f ? Number(f.integerValue) : "booleanValue" in f ? f.booleanValue : "nullValue" in f ? null : "doubleValue" in f ? f.doubleValue : "arrayValue" in f ? (f.arrayValue.values || []).map(dec) : "mapValue" in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, v]) => [k, dec(v)])) : f);
const plano = (d) => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)]));

async function canjear(customToken) {
  const r = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }));
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
const fsQuery = (coleccion, campo, valor, token) => fetch(`${FS}:runQuery`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coleccion }], where: { fieldFilter: { field: { fieldPath: campo }, op: "EQUAL", value: { stringValue: valor } } }, limit: 100 } }) }).then(async (r) => ({ status: r.status, docs: (await r.json().catch(() => [])).filter?.((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(), ...plano(x.document) })) || [] }));
const jpeg = (n = 4000) => { const b = Buffer.alloc(n, 7); b.set([0xff, 0xd8, 0xff, 0xe0], 0); b.set([0xff, 0xd9], n - 2); return b; };
const FOTO = jpeg().toString("base64");

// ---------------------------------------------------------------- preparación
const ac = adminCustomToken();
await espera(10000);
let A;
try { A = await canjear(ac.token); } finally { ac.cleanup(); console.log("llave temporal revocada"); }
check("token de admin", Boolean(A));
const nowLocal = new Date(Date.now() - 7 * 3600e3);
if ((nowLocal.getUTCHours() === 23 && nowLocal.getUTCMinutes() > 30) || (nowLocal.getUTCHours() === 0 && nowLocal.getUTCMinutes() < 20)) throw new Error("Ejecuta la prueba lejos de la medianoche.");
const hhmm = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(11, 16);
const fechaHoy = new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10);
const minuto = (ms) => Math.ceil(ms / 60000) * 60000;

const sx = randomBytes(3).toString("hex");
const pins = { A: String(randomInt(1000, 9999)), B: String(randomInt(1000, 9999)), C: String(randomInt(1000, 9999)), D: String(randomInt(1000, 9999)) };
const nums = Object.fromEntries(Object.keys(pins).map((k) => [k, `F4${sx}${k}`.toUpperCase()]));
const pass = randomBytes(18).toString("base64url") + "aA1";
const mk = (b) => api("/admin/usuarios", { token: A, body: { ...b, prueba: true } });
const g = {};
for (const k of Object.keys(pins)) g[k] = (await mk({ rol: "guardia", nombre: `PRUEBA F4 Guardia ${k}`, numeroEmpleado: nums[k], pin: pins[k] })).body.uid;
const s1 = (await mk({ rol: "supervisor", nombre: "PRUEBA F4 Sup 1", email: `prueba-f4-1-${sx}@prueba.invalid`, password: pass })).body.uid;
const s2 = (await mk({ rol: "supervisor", nombre: "PRUEBA F4 Sup 2", email: `prueba-f4-2-${sx}@prueba.invalid`, password: pass })).body.uid;
const sitio = async (n, sup) => (await api("/admin/sitios", { token: A, body: { nombre: n, supervisorUid: sup, ...SITE, precisionM: 6, radioM: 100, prueba: true } })).body.id;
const S1 = await sitio("PRUEBA F4 Sitio 1", s1), S2 = await sitio("PRUEBA F4 Sitio 2", s2), S3 = await sitio("PRUEBA F4 Sitio 3", s1), S4 = await sitio("PRUEBA F4 Sitio 4", s1);
const punto = async (sitioId, nombre, orden, extra = {}) => (await api("/admin/puntos", { token: A, body: { sitioId, nombre, orden, ...extra } })).body.id;
const P = { 1: await punto(S1, "Portón", 1, { ...SITE, precisionM: 5, radioM: 30 }), 2: await punto(S1, "Bodega", 2), 3: await punto(S1, "Azotea", 3), b: await punto(S2, "Caseta", 1),
  c1: await punto(S3, "Punto C1", 1), c2: await punto(S3, "Punto C2", 2), d1: await punto(S4, "Punto D1", 1) };
check("puntos de prueba creados (heredan prueba del sitio)", Object.values(P).every(Boolean) && (await fsGet(`puntos/${P[1]}`, A)).doc.prueba === true && (await fsGet(`puntos/${P[1]}`, A)).doc.radioM === 30);

const t0 = Date.now();
const iniTurno = minuto(t0 - 6 * 60000) - 60000;     // empezó hace ~6-7 min
const finTurno = minuto(t0 + 3 * 3600e3);
const slotA = minuto(t0 + 90000);                    // rondín de S1/S2 en ~1.5-2.5 min (tolerancia 15/45)
const slotC = minuto(t0 + 60000);                    // rondín de S3: tolerancias 1/5 → vence en ~6 min
const slotD = minuto(t0 + 60000);                    // rondín de S4: nadie lo hace → no iniciado
const programa = (sitioId, slot, modo, ti, tf) => api("/rondines/programa", { token: A, body: { sitioId, modo, frecuencia: { tipo: "horarios", horarios: [hhmm(slot)] }, toleranciaInicioMin: ti, toleranciaFinMin: tf } });
check("programas de rondín", (await Promise.all([programa(S1, slotA, "ordenada", 15, 45), programa(S2, slotA, "libre", 15, 45), programa(S3, slotC, "libre", 1, 5), programa(S4, slotD, "libre", 1, 5)])).every((r) => r.status === 200));
const lote = (sitioId, guardiaUid) => api("/turnos/asignar-lote", { token: A, body: { sitioId, plantilla: "personalizada", desde: fechaHoy, hasta: fechaHoy, horaInicio: hhmm(iniTurno), horaFin: hhmm(finTurno), guardiaUid } });
check("turnos de prueba (A→S1, B→S2, C→S3, D→S4)", (await Promise.all([lote(S1, g.A), lote(S2, g.B), lote(S3, g.C), lote(S4, g.D)])).every((r) => r.status === 201));
const turnos = (await (await fetch(`${FS}:runQuery`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "turnos" }], limit: 400 } }) })).json()).filter((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(), ...plano(x.document) }));
const T = (sitioId, guardia) => turnos.find((t) => t.sitioId === sitioId && t.guardiaUid === guardia && t.inicioMs === iniTurno).id;
const tA = T(S1, g.A), tB = T(S2, g.B), tC = T(S3, g.C), tD = T(S4, g.D);

const login = async (k) => { const l = await api("/auth/guardia", { body: { numero: nums[k], pin: pins[k] } }); return l.body.token ? canjear(l.body.token) : null; };
const TK = { A: await login("A"), B: await login("B"), C: await login("C"), D: await login("D") };
const sl = (n) => fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `prueba-f4-${n}-${sx}@prueba.invalid`, password: pass, returnSecureToken: true }) }).then(j).then((r) => r.body.idToken);
const [S1T, S2T] = [await sl(1), await sl(2)];
check("sesiones de 4 guardias y 2 supervisores", Object.values(TK).every(Boolean) && Boolean(S1T && S2T));
const qrAsis = async (s) => (await api(`/sitios/qr?id=${s}`, { method: "GET", token: A })).body.payload;
const qrP = async (p, token = A) => (await api(`/puntos/qr?id=${p}`, { method: "GET", token })).body.payload;
const entrar = async (k, turnoId, sitioId) => api("/marcas/entrada", { token: TK[k], body: { turnoId, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await qrAsis(sitioId), foto: FOTO } });
const esc = (k, turnoId, qr, o = {}) => api("/rondines/escanear", { token: TK[k], body: { turnoId, qr, horaDispositivoMs: Date.UTC(2001, 0, 1), ...o } });
const rej = (n, r, status, error) => check(n, r.status === status && (!error || r.body?.error === error), `${r.status} ${r.body?.error || ""}`);

// ---------------------------------------------------------------- QR de puntos (permisos)
const q1 = await qrP(P[1]);
check("QR de punto: formato MPC2 firmado; el guardia no puede obtenerlo", /^MPC2\.[0-9a-f]+\.1\.[A-Za-z0-9_-]{22}$/.test(q1) && (await api(`/puntos/qr?id=${P[1]}`, { method: "GET", token: TK.A })).status === 403);
check("QR de punto: el supervisor del sitio sí; otro supervisor no", (await api(`/puntos/qr?id=${P[1]}`, { method: "GET", token: S1T })).status === 200 && (await api(`/puntos/qr?id=${P[1]}`, { method: "GET", token: S2T })).status === 403);
check("hoja de QR del sitio: solo admin o su supervisor", (await api(`/puntos/qr-sitio?sitioId=${S1}`, { method: "GET", token: S1T })).body.puntos?.length === 3 && (await api(`/puntos/qr-sitio?sitioId=${S1}`, { method: "GET", token: S2T })).status === 403);

// ---------------------------------------------------------------- rechazos (con entrada ya marcada)
await rej("rechazo: sin entrada marcada", await esc("A", tA, q1), 409, "sin_entrada");
check("entrada de A (asistencia)", (await entrar("A", tA, S1)).status === 201);
check("entrada de B (asistencia)", (await entrar("B", tB, S2)).status === 201);
check("entradas de C y D", (await entrar("C", tC, S3)).status === 201 && (await entrar("D", tD, S4)).status === 201);
const aqui = { lat: SITE.lat, lng: SITE.lng, precisionM: 8 };
const q2 = await qrP(P[2]), q3 = await qrP(P[3]), qb = await qrP(P.b);
const sp = q1.split(".");
await rej("rechazo: QR de punto alterado", await esc("A", tA, [sp[0], sp[1], sp[2], (sp[3][0] === "A" ? "B" : "A") + sp[3].slice(1)].join("."), aqui), 400, "qr_invalido");
await rej("rechazo: QR de punto de OTRO sitio", await esc("A", tA, qb, aqui), 400, "qr_invalido");
await rej("rechazo: QR de ASISTENCIA usado como punto", await esc("A", tA, await qrAsis(S1), aqui), 400, "qr_invalido");
await rej("rechazo: QR de punto usado para marcar asistencia", await api("/marcas/salida", { token: TK.A, body: { turnoId: tA, lat: SITE.lat, lng: SITE.lng, precisionM: 8, qr: q1, foto: FOTO } }), 400, "qr_invalido");
await rej("rechazo: turno de OTRO guardia", await esc("B", tA, q1, aqui), 403);
await rej("rechazo: supervisor no escanea", await api("/rondines/escanear", { token: S1T, body: { turnoId: tA, qr: q1 } }), 403);
await rej("rechazo: sin sesión", await api("/rondines/escanear", { body: { turnoId: tA, qr: q1 } }), 401);

// Esperar a que abra la ventana del rondín (15 min antes de slotA ya está abierta, pero C y D esperan su hora)
await rej("ruta ordenada: fuera de orden (Bodega antes que Portón)", await esc("A", tA, q2), 409, "fuera_de_orden");
await rej("punto con GPS: sin ubicación", await esc("A", tA, q1), 400, "gps_requerido");
await rej("punto con GPS: fuera del radio de 30 m", await esc("A", tA, q1, { ...aqui, lat: SITE.lat + 0.001 }), 403, "fuera_perimetro_punto");
await rej("punto con GPS: precisión peor que el radio", await esc("A", tA, q1, { ...aqui, precisionM: 45 }), 400, "gps_precision");
await rej("foto inválida", await esc("A", tA, q1, { ...aqui, foto: Buffer.from("a".repeat(3000)).toString("base64") }), 400, "foto_invalida");

// ---------------------------------------------------------------- rondín completo de A (ordenado, con nota y foto)
const antes = Date.now();
const r1 = await esc("A", tA, q1, { ...aqui, nota: "Candado flojo, reportado.", foto: FOTO });
check("escaneo válido del punto 1 (GPS, nota y foto)", r1.status === 201, JSON.stringify(r1.body));
const escRow = (await fsGet(`escaneos/${tA}_0_${P[1]}`, A)).doc;
check("la hora la pone el SERVIDOR (celular decía 2001); GPS y nota guardados", escRow && Math.abs(escRow.tsMs - Date.now()) < 180000 && escRow.tsMs >= antes - 5000 && escRow.horaDispositivoMs === Date.UTC(2001, 0, 1) && escRow.nota === "Candado flojo, reportado." && escRow.distanciaM < 1);
await rej("escaneo duplicado del mismo punto", await esc("A", tA, q1, aqui), 409, "ya_escaneado");
await rej("ruta ordenada: saltarse a la Azotea", await esc("A", tA, q3), 409, "fuera_de_orden");
check("escaneo del punto 2 (sin GPS configurado)", (await esc("A", tA, q2)).status === 201);
const r3 = await esc("A", tA, q3);
check("escaneo del punto 3 completa el rondín", r3.status === 201 && r3.body.completo === true && r3.body.hechos === 3, JSON.stringify(r3.body));
const rondA = (await fsGet(`rondines/${tA}_0`, TK.A)).doc;
check("estado COMPLETO con la hora de cada punto", rondA && rondA.estado === "completo" && rondA.hechos === 3 && rondA.detalle.every((d) => d.hecho && d.tsMs), rondA ? rondA.estado : "");
check("el supervisor y el admin ven el rondín", (await fsGet(`rondines/${tA}_0`, S1T)).status === 200 && (await fsGet(`rondines/${tA}_0`, A)).status === 200);

// ---------------------------------------------------------------- aislamiento y fotos (R2 privado)
check("guardia B NO lee el rondín de A; supervisor 2 tampoco", (await fsGet(`rondines/${tA}_0`, TK.B)).status === 403 && (await fsGet(`rondines/${tA}_0`, S2T)).status === 403);
check("guardia B NO lee rondines por consulta ajena", (await fsQuery("rondines", "guardiaUid", g.A, TK.B)).docs.length === 0);
check("el guardia NO lee puntos, programas ni escaneos", (await Promise.all([fsGet(`puntos/${P[1]}`, TK.A), fsGet(`programasRondin/${S1}`, TK.A), fsGet(`escaneos/${tA}_0_${P[1]}`, TK.A)])).every((r) => r.status === 403));
check("el supervisor NO lee escaneos (GPS/foto) pero sí puntos de su sitio", (await fsGet(`escaneos/${tA}_0_${P[1]}`, S1T)).status === 403 && (await fsGet(`puntos/${P[1]}`, S1T)).status === 200);
check("sin sesión no lee nada de rondines", (await Promise.all([`rondines/${tA}_0`, `puntos/${P[1]}`, `programasRondin/${S1}`, `escaneos/${tA}_0_${P[1]}`, `ajustesRondin`].map((p) => fsGet(p)))).every((r) => r.status === 403));
check("guardia B no ve el rondín de A por el Worker", (await api(`/rondines/proximo?turnoId=${tA}`, { method: "GET", token: TK.B })).status === 403);
const foto = (token, id) => api(`/rondines/foto?escaneo=${id}`, { method: "GET", token });
const fA = await foto(A, `${tA}_0_${P[1]}`);
const fb = new Uint8Array(await fA.raw.arrayBuffer());
check("foto del punto: el admin la ve (JPEG íntegro desde R2)", fA.status === 200 && fA.ct === "image/jpeg" && fb.length === 4000 && fb[0] === 0xff);
check("foto del punto: el supervisor del sitio sí; otro supervisor, guardias y anónimos no", (await foto(S1T, `${tA}_0_${P[1]}`)).status === 200 && (await foto(S2T, `${tA}_0_${P[1]}`)).status === 403 && (await foto(TK.A, `${tA}_0_${P[1]}`)).status === 403 && (await foto(TK.B, `${tA}_0_${P[1]}`)).status === 403 && (await foto(null, `${tA}_0_${P[1]}`)).status === 401 && (await foto("abc.def.ghi", `${tA}_0_${P[1]}`)).status === 401);
const patch = await fetch(`${FS}/escaneos/${tA}_0_${P[1]}?updateMask.fieldPaths=tsMs`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ fields: { tsMs: { integerValue: "1" } } }) });
check("escaneos inmutables: ni el admin los edita ni los borra desde el cliente", patch.status === 403 && (await fetch(`${FS}/escaneos/${tA}_0_${P[1]}`, { method: "DELETE", headers: { authorization: `Bearer ${A}` } })).status === 403);

// ---------------------------------------------------------------- C: rondín incompleto; D: no iniciado
const c1 = await qrP(P.c1);
const espSlot = slotC - Date.now() - 20000;
if (espSlot > 0) { console.log(`  (esperando ${Math.ceil(espSlot / 1000)} s a que abra el rondín de C…)`); await espera(espSlot); }
const rc = await esc("C", tC, c1);
check("C escanea 1 de 2 puntos (rondín de las " + hhmm(slotC) + ")", rc.status === 201 && rc.body.hechos === 1 && rc.body.total === 2, JSON.stringify(rc.body));
const vence = slotC + 5 * 60000 + 20000 - Date.now();
if (vence > 0) { console.log(`  (esperando ${Math.ceil(vence / 1000)} s a que venza el plazo de C y D…)`); await espera(vence); }
await api("/rondines/recalcular", { token: A, body: { desde: fechaHoy, hasta: fechaHoy } });
const rC = (await fsGet(`rondines/${tC}_0`, S1T)).doc, rD = (await fsGet(`rondines/${tD}_0`, S1T)).doc;
check("estado INCOMPLETO con punto saltado (C)", rC && rC.estado === "incompleto" && rC.hechos === 1 && rC.saltados.includes("Punto C2"), rC ? `${rC.estado} saltados=${rC.saltados}` : "");
check("estado NO INICIADO (D)", rD && rD.estado === "no_iniciado" && rD.hechos === 0, rD ? rD.estado : "");
check("el rondín fuera de plazo se rechaza (ya venció)", (await esc("C", tC, await qrP(P.c2))).body.error === "sin_rondin_activo");

// ---------------------------------------------------------------- ajustes
const aj = (token, body) => api("/rondines/ajuste", { token, body: { rondinId: `${tC}_0`, tipo: "marcar_punto", puntoId: P.c2, motivo: "El QR estaba dañado; verificado en sitio.", ...body } });
await rej("ajuste: el guardia no se ajusta", await aj(TK.C, {}), 403);
await rej("ajuste: supervisor de otro sitio no puede", await aj(S2T, {}), 403);
await rej("ajuste: motivo obligatorio", await aj(S1T, { motivo: "ok" }), 400);
const crudo = (p) => fetch(`${FS}/${p}`, { headers: { authorization: `Bearer ${A}` } }).then(async (r) => (r.status === 200 ? r.json() : null));
const escOrig = await crudo(`escaneos/${tC}_0_${P.c1}`);
await rej("ajuste: el supervisor del sitio marca el punto con motivo", await aj(S1T, {}), 201);
const rC2 = (await fsGet(`rondines/${tC}_0`, S1T)).doc;
check("ajuste: el rondín queda completo y el punto lleva ajuste, nombre y motivo", rC2 && rC2.estado === "completo" && rC2.detalle.find((d) => d.puntoId === P.c2).origen === "ajuste" && rC2.detalle.find((d) => d.puntoId === P.c2).ajustePor === "PRUEBA F4 Sup 1");
const escDespues = await crudo(`escaneos/${tC}_0_${P.c1}`);
check("ajuste: el escaneo original NO cambió (mismo contenido y updateTime = createTime)", Boolean(escOrig && escDespues) && JSON.stringify(escDespues.fields) === JSON.stringify(escOrig.fields) && escDespues.updateTime === escDespues.createTime, escDespues ? `${escDespues.createTime === escDespues.updateTime}` : "sin lectura");
await rej("justificar el rondín de D (con motivo)", await api("/rondines/ajuste", { token: S1T, body: { rondinId: `${tD}_0`, tipo: "justificar_rondin", motivo: "Simulacro de evacuación." } }), 201);
check("D queda justificado y deja de contar", (await fsGet(`rondines/${tD}_0`, S1T)).doc.estado === "justificado");

// ---------------------------------------------------------------- reporte y bitácora
const rep = (token, q = "") => api(`/reportes/rondines?desde=${fechaHoy}&hasta=${fechaHoy}${q}`, { method: "GET", token });
const rA = await rep(A), rS1 = await rep(S1T), rS2 = await rep(S2T), rG = await rep(TK.A);
check("reporte: el admin ve los rondines con cumplimiento por sitio y día", rA.status === 200 && rA.body.filas.length >= 4 && Array.isArray(rA.body.porSitioDia) && rA.body.total.porcentaje !== undefined);
check("reporte: el supervisor solo ve sus sitios (S1, S3, S4; no S2)", rS1.status === 200 && rS1.body.filas.every((f) => [S1, S3, S4].includes(f.sitioId)) && !rS1.body.filas.some((f) => f.sitioId === S2));
check("reporte: el otro supervisor solo ve el suyo; el guardia no puede", rS2.body.filas.every((f) => f.sitioId === S2) && rG.status === 403);
const lista = await (await fetch(`${FS}/auditoria?pageSize=300`, { headers: { authorization: `Bearer ${A}` } })).json();
const nuevas = (lista.documents || []).filter((d) => d.createTime >= inicioCorrida);
check("bitácora: TODAS las entradas de esta corrida llevan prueba=true", nuevas.length > 8 && nuevas.every((d) => d.fields.prueba?.booleanValue === true), `${nuevas.filter((d) => d.fields.prueba?.booleanValue === true).length}/${nuevas.length}`);

console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS EN REAL (FASE 4) PASARON");
process.exit(fallos ? 1 : 0);
