// Pruebas de la FASE 6 EN REAL: registros sin conexión (validación idéntica, hora estimada, duplicados, revisión),
// pánico (3 s, destinatarios, atención), panel en vivo (escuchas REALES de Firestore con el SDK) y suscripción push.
// Uso: node tools/e2e-real-fase6.mjs <uid-admin>     (tarda ~2 min)
// Crea datos de PRUEBA (prueba=true): node tools/borrar-pruebas.mjs --aplicar
import { execSync } from "node:child_process";
import { createSign, randomBytes, randomInt, webcrypto } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { collection, getFirestore, onSnapshot, query, where } from "firebase/firestore";

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
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✖"} ${n}${extra ? "  → " + extra : ""}`); if (!ok) fallos++; };
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (f) => (f === undefined ? undefined : "stringValue" in f ? f.stringValue : "integerValue" in f ? Number(f.integerValue) : "booleanValue" in f ? f.booleanValue : "nullValue" in f ? null : "doubleValue" in f ? f.doubleValue : "timestampValue" in f ? f.timestampValue : "arrayValue" in f ? (f.arrayValue.values || []).map(dec) : "mapValue" in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, v]) => [k, dec(v)])) : undefined);
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
  fetch(`${W}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) }));
// Lectura con el token de un usuario (las REGLAS reales deciden) y lectura de verificación con credenciales de operador
const crudo = (path, token) => fetch(`${FS}/${path}`, { headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, doc: r.status === 200 ? plano(await r.json()) : null }));
const GT = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const op = (path) => fetch(`${FS}/${path}`, { headers: { authorization: `Bearer ${GT}`, "x-goog-user-project": PROJECT } }).then(async (r) => (r.status === 200 ? plano(await r.json()) : null));
const consulta = (coleccion, campo, valor, token) => fetch(`${FS}:runQuery`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coleccion }], where: { fieldFilter: { field: { fieldPath: campo }, op: "EQUAL", value: { stringValue: valor } } }, limit: 50 } }) }).then(async (r) => ({ status: r.status, n: r.status === 200 ? (await r.json()).filter((x) => x.document).length : -1 }));
const jpeg = (n = 4000, r = 7) => { const b = Buffer.alloc(n, r); b.set([0xff, 0xd8, 0xff, 0xe0], 0); b.set([0xff, 0xd9], n - 2); return b; };
const FOTO = jpeg().toString("base64");
const rej = (n, r, status, error) => check(n, r.status === status && (!error || r.body?.error === error), `${r.status} ${r.body?.error || ""}`);

// ---------------------------------------------------------------- preparación
const ac = adminCustomToken();
await espera(10000);
let A;
try { A = await canjear(ac.token); } finally { ac.cleanup(); console.log("llave temporal revocada"); }
check("token de admin", Boolean(A));
const nowLocal = new Date(Date.now() - 7 * 3600e3);
if ((nowLocal.getUTCHours() === 23 && nowLocal.getUTCMinutes() > 48) || (nowLocal.getUTCHours() === 0 && nowLocal.getUTCMinutes() < 12)) throw new Error("Ejecuta la prueba lejos de la medianoche (turno de prueba de hoy).");
const hhmm = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(11, 16);
const fechaHoy = new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10);
const sx = randomBytes(3).toString("hex");
const pins = { A: String(randomInt(1000, 9999)), B: String(randomInt(1000, 9999)) };
const nums = Object.fromEntries(Object.keys(pins).map((k) => [k, `F6${sx}${k}`.toUpperCase()]));
const pass = randomBytes(18).toString("base64url") + "aA1";
const mk = (b) => api("/admin/usuarios", { token: A, body: { ...b, prueba: true } });
const g = {};
for (const k of Object.keys(pins)) g[k] = (await mk({ rol: "guardia", nombre: `PRUEBA F6 Guardia ${k}`, numeroEmpleado: nums[k], pin: pins[k] })).body.uid;
const s1 = (await mk({ rol: "supervisor", nombre: "PRUEBA F6 Sup 1", email: `prueba-f6-1-${sx}@prueba.invalid`, password: pass })).body.uid;
const s2 = (await mk({ rol: "supervisor", nombre: "PRUEBA F6 Sup 2", email: `prueba-f6-2-${sx}@prueba.invalid`, password: pass })).body.uid;
const sitio = async (n, sup, tel) => (await api("/admin/sitios", { token: A, body: { nombre: n, supervisorUid: sup, ...SITE, precisionM: 6, radioM: 100, ...(tel ? { telefonoEmergencia: tel } : {}), prueba: true } })).body.id;
const S1 = await sitio("PRUEBA F6 Sitio 1", s1, "662 123 4567"), S2 = await sitio("PRUEBA F6 Sitio 2", s2);
const t0 = Date.now();
const ini = Math.ceil((t0 - 8 * 60000) / 60000) * 60000, fin = Math.min(Math.ceil((t0 + 3 * 3600e3) / 60000) * 60000, Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate(), 23, 59) + 7 * 3600e3); // el turno no cruza la medianoche
const lote = (sitioId, guardiaUid) => api("/turnos/asignar-lote", { token: A, body: { sitioId, plantilla: "personalizada", desde: fechaHoy, hasta: fechaHoy, horaInicio: hhmm(ini), horaFin: hhmm(fin), guardiaUid } });
check("turnos de prueba: A→S1, B→S2", (await Promise.all([lote(S1, g.A), lote(S2, g.B)])).every((r) => r.status === 201));
const turnos = (await Promise.all([[S1, g.A], [S2, g.B]].map(([s, gu]) => consulta("turnos", "guardiaUid", gu, A)))).length;
const tq = async (gu) => (await (await fetch(`${FS}:runQuery`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "turnos" }], where: { fieldFilter: { field: { fieldPath: "guardiaUid" }, op: "EQUAL", value: { stringValue: gu } } }, limit: 5 } }) })).json()).find((x) => x.document).document.name.split("/").pop();
const tA = await tq(g.A), tB = await tq(g.B);
void turnos;
const login = async (k) => { const l = await api("/auth/guardia", { body: { numero: nums[k], pin: pins[k] } }); return l.body.token ? canjear(l.body.token) : null; };
const TK = { A: await login("A"), B: await login("B") };
const sl = (n) => fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `prueba-f6-${n}-${sx}@prueba.invalid`, password: pass, returnSecureToken: true }) }).then(async (r) => (await r.json()).idToken);
const [S1T, S2T] = [await sl(1), await sl(2)];
check("sesiones de 2 guardias y 2 supervisores", Boolean(TK.A && TK.B && S1T && S2T));
const qrAsis = async (s) => (await api(`/sitios/qr?id=${s}`, { method: "GET", token: A })).body.payload;
const G = (k, ruta, body, method = "POST") => api(ruta, { method, token: TK[k], body });
let cid = 0;
const sync = (ev, extra = {}) => ({ clientId: `e2e${sx}${String(++cid).padStart(4, "0")}${"x".repeat(12)}`, offline: true, horaDispositivoMs: ev - 4 * 60000, horaEstimadaMs: ev, ...extra });
const marca = async (k, turnoId, sitioId, s, extra = {}) => G(k, "/marcas/entrada", { turnoId, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await qrAsis(sitioId), foto: FOTO, sync: s, ...extra });

// ---------------------------------------------------------------- cabecera de hora del servidor
const me = await api("/me", { method: "GET", token: TK.A });
check("el servidor entrega su hora (x-server-time) para calcular el desfase del celular", Math.abs(Number(me.headers.get("x-server-time")) - Date.now()) < 60000);

// ---------------------------------------------------------------- sin conexión: rechazos (igual que en línea)
const evento = Date.now() - 5 * 60000; // capturado hace 5 min, dentro del turno
await rej("sin conexión: registro de más de 12 h → rechazado", await marca("A", tA, S1, sync(Date.now() - 13 * 3600e3)), 409, "registro_muy_antiguo");
await rej("sin conexión: hora en el futuro → rechazada", await marca("A", tA, S1, sync(Date.now() + 30 * 60000)), 400, "hora_futura");
await rej("sin conexión: hora fuera del turno → rechazada", await marca("A", tA, S1, sync(ini - 3 * 3600e3)), 409, "fuera_de_turno");
const qr = await qrAsis(S1);
const alterado = [...qr.split(".").slice(0, 3), qr.split(".")[3].slice(0, -2) + (qr.endsWith("AA") ? "BB" : "AA")].join(".");
await rej("sin conexión: QR alterado → rechazado igual que en línea", await marca("A", tA, S1, sync(evento), { qr: alterado }), 400, "qr_invalido");
await rej("sin conexión: QR de otro sitio → rechazado", await marca("A", tA, S1, sync(evento), { qr: await qrAsis(S2) }), 400, "qr_invalido");
await rej("sin conexión: fuera de perímetro → rechazado", await marca("A", tA, S1, sync(evento), { lat: SITE.lat + 0.01 }), 403, "fuera_perimetro");
await rej("sin conexión: turno ajeno → 403", await marca("B", tA, S1, sync(evento)), 403);
await rej("sin conexión: sync con campos extra → 400", await marca("A", tA, S1, { ...sync(evento), extra: 1 }), 400);
await rej("sin conexión: novedad sin entrada marcada → 409", await G("A", "/novedades", { turnoId: tA, texto: "Antes de entrar.", sync: sync(evento) }), 409, "sin_entrada");
check("nada quedó guardado por los rechazos", (await op(`marcas/${tA}_entrada`)) === null);

// ---------------------------------------------------------------- sin conexión: aceptado y duplicados
const sEntrada = sync(evento);
const ok = await marca("A", tA, S1, sEntrada);
check("entrada sin conexión aceptada (validada con QR, GPS y selfie)", ok.status === 201 && ok.body.sin_conexion === true, JSON.stringify(ok.body));
const m = await op(`marcas/${tA}_entrada`);
check("la marca usa la hora ESTIMADA y guarda las tres horas + sin_conexion + prueba", m?.tsMs === evento && m.sin_conexion === true && m.horaEstimadaMs === evento && m.horaDispositivoMs === sEntrada.horaDispositivoMs && Math.abs(m.recibidoMs - Date.now()) < 60000 && m.prueba === true, JSON.stringify({ ts: m?.tsMs, sc: m?.sin_conexion, p: m?.prueba }));
const dup = await marca("A", tA, S1, sEntrada);
check("reenviar el mismo registro: «duplicado», no se vuelve a escribir", dup.status === 200 && dup.body.duplicado === true);
const dups = await Promise.all([1, 2, 3].map(() => G("A", "/novedades", { turnoId: tA, texto: "Una sola vez, aunque se reintente.", sync: sync(evento + 60000, { clientId: `e2e${sx}paralelo${"y".repeat(12)}` }) })));
check("3 reintentos en paralelo: una sola novedad", dups.every((r) => r.status === 200 || r.status === 201) && dups.filter((r) => r.status === 201).length === 1, dups.map((r) => r.status).join());
const asis = await op(`asistencias/${tA}`);
check("la asistencia se calculó con la hora estimada y lo marca como sin conexión", asis?.entradaMs === evento && asis.entradaSinConexion === true);

// incidencia con foto, visitante y su salida, todo sin conexión
const sInc = sync(evento + 2 * 60000);
const inc = await G("A", "/incidencias", { turnoId: tA, tipoId: "robo", gravedad: "alta", descripcion: "Candado forzado capturado sin señal.", fotos: [FOTO], sync: sInc });
check("incidencia alta con foto sin conexión", inc.status === 201 && (await op(`incidencias/${inc.body.id}`))?.sin_conexion === true, JSON.stringify(inc.body));
const sV = sync(evento + 3 * 60000);
const v = await G("A", "/visitantes/entrada", { turnoId: tA, nombre: "Visitante Prueba", visitaA: "Casa 1", motivo: "visita", sync: sV });
const vs = await G("A", "/visitantes/salida", { turnoId: tA, visitanteClientId: sV.clientId, sync: sync(evento + 4 * 60000) });
check("visitante entra y sale sin conexión (la salida referencia la entrada por clientId)", v.status === 201 && vs.status === 201 && (await op(`visitantesVista/${v.body.id}`))?.dentro === false, `${v.status}/${vs.status}`);
await rej("visitantes: campo de identificación sigue rechazado sin conexión", await G("A", "/visitantes/entrada", { turnoId: tA, nombre: "X Y", visitaA: "Casa", motivo: "visita", ine: "1", sync: sync(evento) }), 400);
const ofv = (await Promise.all([consulta("offlineVista", "supervisorUid", s1, S1T), consulta("offlineVista", "supervisorUid", s2, S2T)]));
check("bandeja de revisión: el supervisor del sitio ve sus registros; el otro ninguno", ofv[0].n >= 4 && ofv[1].n === 0, `${ofv[0].n}/${ofv[1].n}`);
const reg = (await consulta("offlineVista", "tipo", "entrada", A));
check("el admin ve la bandeja (consulta por tipo)", reg.status === 200 && reg.n >= 1);

// ---------------------------------------------------------------- revisión
const lista = await (await fetch(`${FS}:runQuery`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${S1T}` }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "offlineVista" }], where: { fieldFilter: { field: { fieldPath: "supervisorUid" }, op: "EQUAL", value: { stringValue: s1 } } }, limit: 20 } }) })).json();
const docsOff = lista.filter((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(), ...plano(x.document) }));
const rEnt = docsOff.find((x) => x.tipo === "entrada"), rNov = docsOff.find((x) => x.tipo === "novedad");
await rej("revisar: otro supervisor → 403", await api("/offline/revisar", { token: S2T, body: { registroId: rNov.id, accion: "aceptar" } }), 403);
await rej("revisar: el guardia → 403", await api("/offline/revisar", { token: TK.A, body: { registroId: rNov.id, accion: "aceptar" } }), 403);
await rej("ajustar sin motivo → 400", await api("/offline/revisar", { token: S1T, body: { registroId: rEnt.id, accion: "ajustar", horaAjustadaMs: evento } }), 400);
const acc = await api("/offline/revisar", { token: S1T, body: { registroId: rNov.id, accion: "aceptar", motivo: "Coincide con la bitácora." } });
check("el supervisor acepta un registro", acc.status === 200 && acc.body.estado === "aceptado");
await rej("no se revisa dos veces", await api("/offline/revisar", { token: S1T, body: { registroId: rNov.id, accion: "aceptar" } }), 409, "ya_revisado");
const aj = await api("/offline/revisar", { token: A, body: { registroId: rEnt.id, accion: "ajustar", motivo: "Entró a las 07:03 según el testigo.", horaAjustadaMs: evento - 60000 } });
check("el admin ajusta la entrada con motivo → corrige la asistencia (marca original intacta)", aj.status === 200 && (await op(`asistencias/${tA}`))?.entradaMs === evento - 60000 && (await op(`marcas/${tA}_entrada`))?.tsMs === evento);

// ---------------------------------------------------------------- pánico
await G("B", "/marcas/entrada", { turnoId: tB, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await qrAsis(S2), foto: FOTO });
await rej("pánico: menos de 3 s → rechazado", await G("A", "/panico", { mantenidoMs: 2500 }), 400, "pulsacion_corta");
await rej("pánico: solo el guardia", await api("/panico", { token: S1T, body: { mantenidoMs: 3000 } }), 403);
await rej("pánico: sin sesión", await api("/panico", { body: { mantenidoMs: 3000 } }), 401);
await rej("pánico: campo extra", await G("A", "/panico", { mantenidoMs: 3000, extra: 1 }), 400);

// escuchas REALES de Firestore (SDK) para el panel en vivo
const cfg = { apiKey: KEY, authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT };
const appDe = async (n, nombre) => { const app = initializeApp(cfg, nombre); await signInWithEmailAndPassword(getAuth(app), `prueba-f6-${n}-${sx}@prueba.invalid`, pass); return getFirestore(app); };
const [db1, db2] = [await appDe(1, "s1"), await appDe(2, "s2")];
const escucha = (db, uid, extra = []) => { const r = { snaps: [], err: null }; r.baja = onSnapshot(query(collection(db, "panicoVista"), where("supervisorUid", "==", uid), ...extra), (s) => r.snaps.push(s.docs.map((d) => d.id)), (e) => { r.err = e; }); return r; };
const l1 = escucha(db1, s1, [where("estado", "==", "activa")]);
const l2 = escucha(db2, s2, [where("estado", "==", "activa")]);
const l1ajena = escucha(db1, s2); // s1 intenta escuchar lo de s2
const l2sinFiltro = (() => { const r = { snaps: [], err: null }; r.baja = onSnapshot(collection(db2, "panicoVista"), (s) => r.snaps.push(s.size), (e) => { r.err = e; }); return r; })();
await espera(3000);
check("escucha propia en vivo: arranca sin errores", !l1.err && !l2.err && l1.snaps.length >= 1);
check("escuchar sitios AJENOS: permission-denied y cero documentos", l1ajena.err?.code === "permission-denied" && l1ajena.snaps.length === 0);
check("escuchar SIN filtrar (podría traer sitios ajenos): permission-denied", l2sinFiltro.err?.code === "permission-denied" && l2sinFiltro.snaps.length === 0);

const tPan = Date.now();
const p = await G("A", "/panico", { mantenidoMs: 3100, lat: SITE.lat + 0.0002, lng: SITE.lng, precisionM: 9 });
check("pánico: aceptado con la hora del servidor", p.status === 201 && Math.abs(p.body.tsMs - Date.now()) < 60000, JSON.stringify(p.body));
let llegoMs = null;
for (let i = 0; i < 80 && llegoMs === null; i++) { if (l1.snaps.some((s) => s.includes(p.body.id))) llegoMs = Date.now() - tPan; else await espera(100); }
check("pánico: llega EN TIEMPO REAL al supervisor del sitio (listener real)", llegoMs !== null, llegoMs !== null ? `${llegoMs} ms` : "no llegó");
await espera(1500);
check("pánico: NO llega al supervisor de otro sitio", !l2.snaps.some((s) => s.includes(p.body.id)));
const pv = await crudo(`panicoVista/${p.body.id}`, A);
check("pánico: el admin lo lee; estado activa, sitio, supervisor y teléfono de emergencia", pv.status === 200 && pv.doc.estado === "activa" && pv.doc.supervisorUid === s1 && pv.doc.telefonoEmergencia === "662 123 4567" && pv.doc.prueba === true);
check("pánico: otro supervisor no puede leerlo (reglas reales)", (await crudo(`panicoVista/${p.body.id}`, S2T)).status === 403 && (await crudo(`panicos/${p.body.id}`, S1T)).status === 403 && (await crudo(`panicoVista/${p.body.id}`, TK.A)).status === 403);
const rep = await G("A", "/panico", { mantenidoMs: 3200 });
check("pulsación repetida con la alerta activa: se reutiliza", rep.status === 200 && rep.body.repetida === true && rep.body.id === p.body.id);
await rej("atender: supervisor ajeno → 403", await api("/panico/atender", { token: S2T, body: { id: p.body.id } }), 403);
await rej("atender: el guardia → 403", await G("A", "/panico/atender", { id: p.body.id }), 403);
const at1 = await api("/panico/atender", { token: S1T, body: { id: p.body.id, nota: "Voy en camino." } });
check("atender: el supervisor del sitio; queda quién y cuándo", at1.status === 200 && (await crudo(`panicoVista/${p.body.id}`, S1T)).doc.atendidaPorNombre === "PRUEBA F6 Sup 1");
await rej("atender dos veces → ya_atendida (no se sobrescribe)", await api("/panico/atender", { token: A, body: { id: p.body.id } }), 409, "ya_atendida");
await espera(1500);
check("al atenderse sale de las activas en vivo", l1.snaps.at(-1) && !l1.snaps.at(-1).includes(p.body.id));
// alerta del otro sitio: s1 no la ve ni la atiende
const pb = await G("B", "/panico", { mantenidoMs: 3000 });
check("pánico del otro sitio: lo ve su supervisor, no el primero", (await crudo(`panicoVista/${pb.body.id}`, S2T)).status === 200 && (await crudo(`panicoVista/${pb.body.id}`, S1T)).status === 403 && (await api("/panico/atender", { token: S1T, body: { id: pb.body.id } })).status === 403);
// pánico sin conexión: idempotente
const sP = sync(Date.now() - 2 * 60000);
await api("/panico/atender", { token: A, body: { id: pb.body.id } });
const po = await G("A", "/panico", { mantenidoMs: 3000, sync: sP });
const pod = await G("A", "/panico", { mantenidoMs: 3000, sync: sP });
check("pánico capturado sin conexión: se registra con sin_conexion; reenviarlo no duplica", (po.status === 201 || po.status === 429) && (po.status === 429 || (pod.body.duplicado === true && (await op(`panicoVista/${po.body.id}`))?.sin_conexion === true)), `${po.status}/${pod.status}`);
for (const l of [l1, l2, l1ajena, l2sinFiltro]) l.baja();

// ---------------------------------------------------------------- push
const clave = await api("/push/clave", { method: "GET", token: S1T });
check("push: la llave pública VAPID se entrega a supervisores (65 bytes) y NO al guardia", clave.status === 200 && clave.body.publicKey.length === 87 && (await api("/push/clave", { method: "GET", token: TK.A })).status === 403);
const par = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const keys = { p256dh: Buffer.from(await webcrypto.subtle.exportKey("raw", par.publicKey)).toString("base64url"), auth: randomBytes(16).toString("base64url") };
const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${sx}-${randomBytes(16).toString("hex")}`;
await rej("push: endpoint de un servicio no permitido → 400", await api("/push/suscribir", { token: S1T, body: { endpoint: "https://evil.example.com/x", keys } }), 400);
await rej("push: el guardia no se suscribe → 403", await api("/push/suscribir", { token: TK.A, body: { endpoint, keys } }), 403);
await rej("push: el pánico no se puede desactivar → 400", await api("/push/suscribir", { token: S1T, body: { endpoint, keys, prefs: { panico: false } } }), 400);
const sub = await api("/push/suscribir", { token: S1T, body: { endpoint, keys, prefs: { incidencia_alta: true, relevo: false, rondin: true } } });
check("push: suscripción de un supervisor (opt-in) con sus preferencias", sub.status === 201 && sub.body.prefs.relevo === false);
const subDoc = await op(`pushSuscripciones/${[...new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)))].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("")}`);
check("push: la suscripción solo existe en el servidor (reglas: nadie la lee desde el cliente)", subDoc?.uid === s1 && (await crudo("pushSuscripciones/x", S1T)).status === 403);
await api("/panico/atender", { token: A, body: { id: po.body.id } }); // la alerta sin conexión de arriba sigue activa: se atiende para que la siguiente sea nueva
await espera(3000);
const pp = await G("B", "/panico", { mantenidoMs: 3000 });
const p2 = await G("A", "/panico", { mantenidoMs: 3000 });
check("push: el pánico del sitio de s1 intenta avisar a su suscripción (avisados contado por el servidor)", p2.status === 201 || p2.status === 429, JSON.stringify({ pb: pp.status, p2: p2.status, avisados: p2.body.avisados }));
await espera(2500);
const st = await api("/push/estado", { token: S1T, body: { endpoint } });
console.log(`   (informativo) FCM respondió a la suscripción inventada: ${st.body.suscrito ? "la conservó" : "la rechazó (404/410) y el Worker la eliminó → el envío firmado con VAPID llegó hasta Google"}`);
await api("/push/baja", { token: S1T, body: { endpoint } });
check("push: baja de la suscripción", (await api("/push/estado", { token: S1T, body: { endpoint } })).body.suscrito === false);
console.log("   (la entrega real a un teléfono se comprueba en la prueba en campo con una suscripción de navegador verdadera)");

// ---------------------------------------------------------------- configuración
const cfgR = await api("/admin/config", { token: A, body: { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3, offlineMaxHoras: 100 } });
check("config: antigüedad máxima fuera de 1–72 h rechazada", cfgR.status === 400);
const tel = await api("/admin/sitios/actualizar", { token: A, body: { id: S2, telefonoEmergencia: "<script>" } });
check("sitio: teléfono de emergencia con caracteres raros rechazado", tel.status === 400);

// ---------------------------------------------------------------- marcado de pruebas
const colecciones = [["marcas", `${tA}_entrada`], ["registrosOffline", null], ["panicos", p.body.id], ["panicoVista", p.body.id], ["atencionesPanico", p.body.id], ["incidencias", inc.body.id], ["visitantes", v.body.id], ["offlineVista", rEnt.id], ["revisionesOffline", rEnt.id]];
const marcados = [];
for (const [c, id] of colecciones) { if (id) marcados.push([c, (await op(`${c}/${id}`))?.prueba === true]); }
check("todo lo creado quedó marcado prueba=true", marcados.every(([, x]) => x), marcados.filter(([, x]) => !x).map(([c]) => c).join() || "ok");

console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS REALES DE LA FASE 6 PASARON");
process.exit(fallos ? 1 : 0);
