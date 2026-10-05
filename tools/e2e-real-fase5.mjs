// Pruebas de seguridad y de negocio de la FASE 5 EN REAL (incidencias, visitantes, bitácora, retención).
// Uso: node tools/e2e-real-fase5.mjs <uid-admin>     (tarda ~8 min: espera al cron de retención, que corre cada 5 min)
// Crea datos de PRUEBA (prueba=true): node tools/borrar-pruebas.mjs --aplicar
import { execSync } from "node:child_process";
import { createSign, randomBytes, randomInt } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
const crudo = (path, token) => fetch(`${FS}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, raw: r.status === 200 ? await r.json() : null }));
const fsGet = async (path, token) => { const r = await crudo(path, token); return { status: r.status, doc: r.raw ? plano(r.raw) : null }; };
const fsQuery = (coleccion, filtros, token) => fetch(`${FS}:runQuery`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coleccion }], where: filtros.length === 1 ? { fieldFilter: { field: { fieldPath: filtros[0][0] }, op: "EQUAL", value: filtros[0][1] } } : { compositeFilter: { op: "AND", filters: filtros.map(([c, v]) => ({ fieldFilter: { field: { fieldPath: c }, op: "EQUAL", value: v } })) } }, limit: 100 } }) }).then(async (r) => ({ status: r.status, docs: (await r.json().catch(() => [])).filter?.((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(), ...plano(x.document) })) || [] }));
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
if ((nowLocal.getUTCHours() === 23 && nowLocal.getUTCMinutes() > 30) || (nowLocal.getUTCHours() === 0 && nowLocal.getUTCMinutes() < 20)) throw new Error("Ejecuta la prueba lejos de la medianoche.");
const hhmm = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(11, 16);
const fechaHoy = new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10);
const sx = randomBytes(3).toString("hex");
const pins = { A: String(randomInt(1000, 9999)), B: String(randomInt(1000, 9999)), C: String(randomInt(1000, 9999)) };
const nums = Object.fromEntries(Object.keys(pins).map((k) => [k, `F5${sx}${k}`.toUpperCase()]));
const pass = randomBytes(18).toString("base64url") + "aA1";
const mk = (b) => api("/admin/usuarios", { token: A, body: { ...b, prueba: true } });
const g = {};
for (const k of Object.keys(pins)) g[k] = (await mk({ rol: "guardia", nombre: `PRUEBA F5 Guardia ${k}`, numeroEmpleado: nums[k], pin: pins[k] })).body.uid;
const s1 = (await mk({ rol: "supervisor", nombre: "PRUEBA F5 Sup 1", email: `prueba-f5-1-${sx}@prueba.invalid`, password: pass })).body.uid;
const s2 = (await mk({ rol: "supervisor", nombre: "PRUEBA F5 Sup 2", email: `prueba-f5-2-${sx}@prueba.invalid`, password: pass })).body.uid;
const sitio = async (n, sup) => (await api("/admin/sitios", { token: A, body: { nombre: n, supervisorUid: sup, ...SITE, precisionM: 6, radioM: 100, prueba: true } })).body.id;
const S1 = await sitio("PRUEBA F5 Sitio 1", s1), S2 = await sitio("PRUEBA F5 Sitio 2", s2);
const t0 = Date.now();
const ini = Math.ceil((t0 - 8 * 60000) / 60000) * 60000, fin = Math.ceil((t0 + 3 * 3600e3) / 60000) * 60000;
const lote = (sitioId, guardiaUid) => api("/turnos/asignar-lote", { token: A, body: { sitioId, plantilla: "personalizada", desde: fechaHoy, hasta: fechaHoy, horaInicio: hhmm(ini), horaFin: hhmm(fin), guardiaUid } });
check("turnos de prueba: A→S1, B→S2, C→S1 (sin entrada)", (await Promise.all([lote(S1, g.A), lote(S2, g.B)])).every((r) => r.status === 201));
const turnosQ = async () => (await fetch(`${FS}:runQuery`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "turnos" }], limit: 500 } }) })).json();
let turnos = (await turnosQ()).filter((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(), ...plano(x.document) }));
const T = (sitioId, guardia) => turnos.find((t) => t.sitioId === sitioId && t.guardiaUid === guardia && t.inicioMs === ini).id;
const tA = T(S1, g.A), tB = T(S2, g.B);
// C: turno en OTRO horario del mismo sitio S1 (mañana) para no empalmar; nunca marca entrada
const manana = new Date(Date.now() - 7 * 3600e3 + 86400e3).toISOString().slice(0, 10);
check("turno de C (mañana)", (await api("/turnos/asignar-lote", { token: A, body: { sitioId: S1, plantilla: "diurno", desde: manana, hasta: manana, guardiaUid: g.C } })).status === 201);
turnos = (await turnosQ()).filter((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(), ...plano(x.document) }));
const tC = turnos.find((t) => t.guardiaUid === g.C).id;
const login = async (k) => { const l = await api("/auth/guardia", { body: { numero: nums[k], pin: pins[k] } }); return l.body.token ? canjear(l.body.token) : null; };
const TK = { A: await login("A"), B: await login("B"), C: await login("C") };
const sl = (n) => fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `prueba-f5-${n}-${sx}@prueba.invalid`, password: pass, returnSecureToken: true }) }).then(j).then((r) => r.body.idToken);
const [S1T, S2T] = [await sl(1), await sl(2)];
check("sesiones de 3 guardias y 2 supervisores", Object.values(TK).every(Boolean) && Boolean(S1T && S2T));
const qrAsis = async (s) => (await api(`/sitios/qr?id=${s}`, { method: "GET", token: A })).body.payload;
const entrar = async (k, turnoId, sitioId) => api("/marcas/entrada", { token: TK[k], body: { turnoId, lat: SITE.lat, lng: SITE.lng, precisionM: 10, qr: await qrAsis(sitioId), foto: FOTO } });

// ---------------------------------------------------------------- guardia sin turno activo
const G = (k, ruta, body, method = "POST") => api(ruta, { method, token: TK[k], body });
const incBody = (turnoId, o = {}) => ({ turnoId, tipoId: "robo", gravedad: "media", descripcion: "Se detectó un candado forzado en el portón.", ...o });
const visBody = (turnoId, o = {}) => ({ turnoId, nombre: "Luis Pérez", visitaA: "Casa 12", motivo: "visita", ...o });
await rej("sin entrada: no puede reportar incidencia", await G("A", "/incidencias", incBody(tA)), 409, "sin_entrada");
await rej("sin entrada: no puede registrar visitantes", await G("A", "/visitantes/entrada", visBody(tA)), 409, "sin_entrada");
await rej("sin entrada: no puede agregar novedades", await G("A", "/novedades", { turnoId: tA, texto: "hola mundo" }), 409, "sin_entrada");
await rej("sin entrada: no ve «dentro ahora»", await G("A", `/visitantes/dentro?turnoId=${tA}`, undefined, "GET"), 409, "sin_entrada");
await rej("turno de otro guardia / sin turno: 403", await G("B", "/incidencias", incBody(tA)), 403);
check("entradas de A y B (asistencia)", (await entrar("A", tA, S1)).status === 201 && (await entrar("B", tB, S2)).status === 201);
await rej("guardia C (turno de mañana, sin entrada) tampoco puede", await G("C", "/incidencias", incBody(tC)), 409);
for (const ruta of ["/incidencias", "/visitantes/entrada", "/novedades"]) {
  check(`supervisor/admin/anónimo no pueden POST ${ruta}`, (await api(ruta, { token: S1T, body: { turnoId: tA } })).status === 403 && (await api(ruta, { token: A, body: { turnoId: tA } })).status === 403 && (await api(ruta, { body: { turnoId: tA } })).status === 401);
}

// ---------------------------------------------------------------- catálogo
const cat = await G("A", "/catalogo/incidencias", undefined, "GET");
check("catálogo inicial de tipos para el guardia", cat.status === 200 && cat.body.tipos.some((t) => t.id === "acceso_no_autorizado") && cat.body.tipos.length >= 7);
await rej("catálogo: el supervisor no lo edita", await api("/admin/catalogo-incidencias", { token: S1T, body: { tipos: cat.body.tipos } }), 403);
await rej("catálogo: no se pueden eliminar tipos", await api("/admin/catalogo-incidencias", { token: A, body: { tipos: cat.body.tipos.slice(1) } }), 400);

// ---------------------------------------------------------------- incidencias
for (const [n, mal] of Object.entries({ "campo de identificación": { ine: "123" }, "gravedad inválida": { gravedad: "x" }, "4 fotos": { fotos: [FOTO, FOTO, FOTO, FOTO] }, "foto inválida": { fotos: [Buffer.from("a".repeat(3000)).toString("base64")] } }))
  check(`incidencia rechazada: ${n}`, (await G("A", "/incidencias", incBody(tA, mal))).status === 400);
const antes = Date.now();
const i1 = await G("A", "/incidencias", incBody(tA, { gravedad: "alta", tipoId: "acceso_no_autorizado", fotos: [jpeg(3000, 1).toString("base64"), jpeg(3500, 2).toString("base64"), jpeg(4000, 3).toString("base64")], lat: SITE.lat + 0.0002, lng: SITE.lng, precisionM: 12, horaDispositivoMs: Date.UTC(2001, 0, 1) }));
check("incidencia de gravedad ALTA con 3 fotos y GPS", i1.status === 201 && i1.body.nFotos === 3, JSON.stringify(i1.body));
const incId = i1.body.id;
const incDoc = await crudo(`incidencias/${incId}`, A);
const inc = plano(incDoc.raw);
check("hora del SERVIDOR (celular decía 2001); GPS, tipo y fotos guardados", Math.abs(inc.creadoMs - Date.now()) < 120000 && inc.creadoMs >= antes - 5000 && inc.horaDispositivoMs === Date.UTC(2001, 0, 1) && inc.fotoKeys.length === 3 && inc.distanciaM > 20 && inc.tipoNombre === "Acceso no autorizado");
const res = (await fsGet(`incidenciasResumen/${incId}`, S1T)).doc;
check("el supervisor del sitio ve el resumen (estado abierta, alta destacada)", res && res.estado === "abierta" && res.alta === true && res.nFotos === 3 && res.guardiaNombre === "PRUEBA F5 Guardia A");
check("alerta de gravedad ALTA consultable por el supervisor (sus sitios)", (await fsQuery("incidenciasResumen", [["supervisorUid", { stringValue: s1 }], ["gravedad", { stringValue: "alta" }]], S1T)).docs.some((d) => d.incidenciaId === incId));
check("el guardia autor lee SU resumen; otro guardia y otro supervisor NO", (await fsGet(`incidenciasResumen/${incId}`, TK.A)).status === 200 && (await fsGet(`incidenciasResumen/${incId}`, TK.B)).status === 403 && (await fsGet(`incidenciasResumen/${incId}`, S2T)).status === 403);
check("el registro ORIGINAL solo lo lee el admin (no guardia ni supervisor)", (await fsGet(`incidencias/${incId}`, A)).status === 200 && (await fsGet(`incidencias/${incId}`, TK.A)).status === 403 && (await fsGet(`incidencias/${incId}`, S1T)).status === 403);
check("sin sesión no lee incidencias, visitantes ni bitácora", (await Promise.all(["incidencias", "incidenciasResumen", "visitantes", "visitantesVista", "novedades", "seguimientosIncidencia"].map((c) => fsGet(`${c}/x`)))).every((r) => r.status === 403));
const fi = (token, n = 0) => api(`/incidencias/foto?incidencia=${incId}&n=${n}`, { method: "GET", token });
const f0 = await fi(A, 1);
check("foto de incidencia: el admin la ve (JPEG íntegro desde R2)", f0.status === 200 && f0.ct === "image/jpeg" && new Uint8Array(await f0.raw.arrayBuffer()).length === 3500);
check("foto de incidencia: supervisor del sitio sí; otro supervisor, guardias y anónimos no", (await fi(S1T)).status === 200 && (await fi(S2T)).status === 403 && (await fi(TK.A)).status === 403 && (await fi(TK.B)).status === 403 && (await fi(null)).status === 401 && (await fi("abc.def.ghi")).status === 401);

// ---------------------------------------------------------------- seguimiento (registros nuevos)
const seg = (token, b) => api("/incidencias/seguimiento", { token, body: { incidenciaId: incId, ...b } });
await rej("seguimiento: otro supervisor no", await seg(S2T, { tipo: "comentario", texto: "no es mi sitio" }), 403);
await rej("seguimiento: el guardia autor no", await seg(TK.A, { tipo: "comentario", texto: "soy el autor" }), 403);
await rej("seguimiento: comentario del supervisor del sitio", await seg(S1T, { tipo: "comentario", texto: "Se llamó a la policía." }), 201);
await rej("seguimiento: abierta → en atención", await seg(S1T, { tipo: "estado", estadoNuevo: "en_atencion", texto: "Policía en camino." }), 201);
await rej("seguimiento: no se puede volver a «abierta»", await seg(S1T, { tipo: "estado", estadoNuevo: "abierta" }), 409);
await rej("seguimiento: en atención → cerrada (admin)", await seg(A, { tipo: "estado", estadoNuevo: "cerrada", texto: "Resuelto." }), 201);
const incDespues = await crudo(`incidencias/${incId}`, A);
check("el registro ORIGINAL no cambió (updateTime = createTime y mismo contenido)", JSON.stringify(plano(incDespues.raw), Object.keys(plano(incDoc.raw)).sort()) === JSON.stringify(plano(incDoc.raw), Object.keys(plano(incDoc.raw)).sort()) && incDespues.raw.updateTime === incDespues.raw.createTime);
const resFinal = (await fsGet(`incidenciasResumen/${incId}`, S1T)).doc;
check("resumen: estado cerrada y 3 registros de seguimiento con nombre y hora", resFinal.estado === "cerrada" && resFinal.seguimientos.length === 3 && resFinal.seguimientos.every((s) => s.autorNombre && s.tsMs), resFinal.seguimientos.map((s) => s.autorNombre).join(","));

// ---------------------------------------------------------------- visitantes
for (const campo of ["ine", "identificacion", "licencia", "pasaporte", "curp", "numeroIdentificacion", "fotoIdentificacion"])
  check(`visitante: el campo «${campo}» no existe (400)`, (await G("A", "/visitantes/entrada", visBody(tA, { [campo]: "ABC123456" }))).status === 400);
check("visitante: motivo, placas y foto inválidos rechazados", (await G("A", "/visitantes/entrada", visBody(tA, { motivo: "turismo" }))).status === 400 && (await G("A", "/visitantes/entrada", visBody(tA, { placas: "!!!" }))).status === 400 && (await G("A", "/visitantes/entrada", visBody(tA, { foto: Buffer.from("a".repeat(3000)).toString("base64") }))).status === 400);
const v1 = await G("A", "/visitantes/entrada", visBody(tA, { motivo: "proveedor", empresa: "Agua Pura SA", placas: "abc-123", foto: jpeg(3000, 5).toString("base64") }));
const v2 = await G("A", "/visitantes/entrada", visBody(tA, { nombre: "Ana Visita" }));
check("visitantes: entrada con vehículo/placa y foto opcional", v1.status === 201 && v2.status === 201, JSON.stringify(v1.body));
const vDoc = plano((await crudo(`visitantes/${v1.body.id}`, A)).raw);
const permitidos = ["sitioId", "turnoId", "guardiaUid", "guardiaNombre", "nombre", "visitaA", "motivo", "empresa", "placas", "fotoKey", "entradaMs", "expiraMs", "ts", "prueba"];
check("el registro del visitante no tiene NINGÚN campo de identificación (solo el esquema permitido)", Object.keys(vDoc).every((k) => permitidos.includes(k)) && vDoc.placas === "ABC-123" && vDoc.expiraMs === vDoc.entradaMs + 90 * 86400000, Object.keys(vDoc).join(","));
const dentro = (token, q) => api(`/visitantes/dentro?${q}`, { method: "GET", token });
check("«dentro ahora»: el guardia en turno ve a los 2", (await dentro(TK.A, `turnoId=${tA}`)).body.dentro?.length === 2);
check("«dentro ahora»: el supervisor del sitio sí; otro supervisor no; el guardia de otro sitio no ve los ajenos", (await dentro(S1T, `sitioId=${S1}`)).body.dentro?.length === 2 && (await dentro(S2T, `sitioId=${S1}`)).status === 403 && (await dentro(TK.B, `turnoId=${tB}`)).body.dentro?.length === 0);
check("visitantesVista: el supervisor la lee; otro supervisor y guardias no", (await fsGet(`visitantesVista/${v1.body.id}`, S1T)).status === 200 && (await fsGet(`visitantesVista/${v1.body.id}`, S2T)).status === 403 && (await fsGet(`visitantesVista/${v1.body.id}`, TK.A)).status === 403 && (await fsGet(`visitantes/${v1.body.id}`, S1T)).status === 403);
await rej("visitante: otro sitio no puede sacar al visitante ajeno", await G("B", "/visitantes/salida", { turnoId: tB, visitanteId: v1.body.id }), 404);
await rej("visitante: registrar salida", await G("A", "/visitantes/salida", { turnoId: tA, visitanteId: v2.body.id }), 201);
await rej("visitante: salida duplicada rechazada", await G("A", "/visitantes/salida", { turnoId: tA, visitanteId: v2.body.id }), 409, "ya_salio");
check("«dentro ahora» solo muestra a quien sigue dentro", (await dentro(TK.A, `turnoId=${tA}`)).body.dentro?.length === 1);
const fv = (token) => api(`/visitantes/foto?id=${v1.body.id}`, { method: "GET", token });
check("foto del vehículo: admin y supervisor del sitio sí; otro supervisor, guardias y anónimos no", (await fv(A)).status === 200 && (await fv(S1T)).status === 200 && (await fv(S2T)).status === 403 && (await fv(TK.A)).status === 403 && (await fv(null)).status === 401);

// ---------------------------------------------------------------- novedades y bitácora
await rej("novedad válida", await G("A", "/novedades", { turnoId: tA, texto: "Se cambió la bombilla del pasillo." }), 201);
check("novedad: validaciones (vacía, larga, campo extra)", (await G("A", "/novedades", { turnoId: tA, texto: "" })).status === 400 && (await G("A", "/novedades", { turnoId: tA, texto: "x".repeat(1001) })).status === 400 && (await G("A", "/novedades", { turnoId: tA, texto: "ok ok", otro: 1 })).status === 400);
const bit = await api(`/bitacora/turno?turnoId=${tA}`, { method: "GET", token: TK.A });
const tipos = bit.body.items?.map((x) => x.tipo) || [];
check("bitácora consolidada: entrada, novedad, incidencia y visitantes en orden cronológico", ["entrada", "incidencia", "novedad"].every((t) => tipos.includes(t)) && tipos.includes("visitante_entrada") && tipos.includes("visitante_salida") && bit.body.items.every((x, i, a) => i === 0 || a[i - 1].tsMs <= x.tsMs), tipos.join(","));
check("bitácora: el supervisor del sitio y el admin sí; otro supervisor, otro guardia y anónimo no", (await api(`/bitacora/turno?turnoId=${tA}`, { method: "GET", token: S1T })).status === 200 && (await api(`/bitacora/turno?turnoId=${tA}`, { method: "GET", token: A })).status === 200 && (await api(`/bitacora/turno?turnoId=${tA}`, { method: "GET", token: S2T })).status === 403 && (await api(`/bitacora/turno?turnoId=${tA}`, { method: "GET", token: TK.B })).status === 403 && (await api(`/bitacora/turno?turnoId=${tA}`, { method: "GET" })).status === 401);
check("bitácora: «turno anterior» solo para guardias con turno propio", (await api(`/bitacora/anterior?turnoId=${tA}`, { method: "GET", token: TK.B })).status === 403 && (await api(`/bitacora/anterior?turnoId=${tA}`, { method: "GET", token: S1T })).status === 403);

// ---------------------------------------------------------------- inmutabilidad desde el cliente
const toca = async (path, campo) => [(await fetch(`${FS}/${path}?updateMask.fieldPaths=${campo}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ fields: { [campo]: { stringValue: "hack" } } }) })).status, (await fetch(`${FS}/${path}`, { method: "DELETE", headers: { authorization: `Bearer ${A}` } })).status];
const novs = (await fsQuery("novedades", [["turnoId", { stringValue: tA }]], A)).docs;
const segs = (await fsQuery("seguimientosIncidencia", [["incidenciaId", { stringValue: incId }]], A)).docs;
check("incidencias, novedades, visitantes y seguimientos son inmutables: ni el admin los edita ni borra desde el cliente",
  (await Promise.all([toca(`incidencias/${incId}`, "descripcion"), toca(`novedades/${novs[0].id}`, "texto"), toca(`visitantes/${v1.body.id}`, "nombre"), toca(`seguimientosIncidencia/${segs[0].id}`, "texto"), toca(`incidenciasResumen/${incId}`, "estado")])).flat().every((s) => s === 403));

// ---------------------------------------------------------------- retención (borrado automático por cron)
// Se inyectan registros VENCIDOS (100 días) de prueba y señuelos que NO deben tocarse; luego se espera al cron (cada 5 min).
const writeFs = (path, fields) => fetch(`${FS}/${path}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ fields }) }).then((r) => r.status);
// El admin del cliente NO puede escribir (reglas); se usa la sesión de gcloud (propietario) solo para preparar estos datos de prueba.
const tokG = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const putFs = (path, obj) => fetch(`${FS}/${path}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${tokG}`, "x-goog-user-project": PROJECT }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : v === null ? { nullValue: null } : { integerValue: String(v) }])) }) }).then((r) => r.status);
const putR2 = (key) => { const f = join(tmpdir(), `r2-${randomBytes(4).toString("hex")}.jpg`); writeFileSync(f, jpeg(2000, 9)); try { execSync(`wrangler r2 object put marpec-guardias-selfies/${key} --file "${f}" --content-type image/jpeg --remote`, { cwd: "worker", stdio: "pipe" }); return true; } catch { return false; } finally { rmSync(f, { force: true }); } };
const existeR2 = (key) => { const f = join(tmpdir(), `r2g-${randomBytes(4).toString("hex")}.bin`); try { execSync(`wrangler r2 object get marpec-guardias-selfies/${key} --file "${f}" --remote`, { cwd: "worker", stdio: "pipe" }); return true; } catch { return false; } finally { rmSync(f, { force: true }); } };
const viejo = Date.now() - 100 * 86400000;
const kViejo = `visitantes/${S1}/viejo-${sx}.jpg`, kSenuelo = `incidencias/${S1}/viejo-${sx}/0-x.jpg`;
const okR2 = putR2(kViejo) && putR2(kSenuelo);
const base = { sitioId: S1, nombre: "PRUEBA Visitante vencido", visitaA: "X", motivo: "visita", empresa: "", placas: "", guardiaUid: g.A, turnoId: "t-viejo", entradaMs: viejo, prueba: true };
const sts = await Promise.all([
  putFs(`visitantes/viejo-${sx}`, { ...base, fotoKey: kViejo, expiraMs: viejo + 90 * 86400000 }),
  putFs(`visitantesVista/viejo-${sx}`, { ...base, visitanteId: `viejo-${sx}`, dentro: false, supervisorUid: s1 }),
  putFs(`salidasVisitante/viejo-${sx}`, { visitanteId: `viejo-${sx}`, sitioId: S1, salidaMs: viejo + 3600000, prueba: true }),
  putFs(`incidencias/viejo-${sx}`, { sitioId: S1, guardiaUid: g.A, descripcion: "Incidencia ANTIGUA de prueba (señuelo: no debe borrarse)", creadoMs: viejo - 100 * 86400000, tipoId: "robo", gravedad: "baja", prueba: true }),
  putFs(`novedades/viejo-${sx}`, { turnoId: "t-viejo", sitioId: S1, guardiaUid: g.A, texto: "Novedad ANTIGUA de prueba (señuelo)", tsMs: viejo - 100 * 86400000, prueba: true }),
  putFs(`marcas/t-viejo-${sx}_entrada`, { turnoId: "t-viejo", guardiaUid: g.A, tipo: "entrada", tsMs: viejo - 100 * 86400000, prueba: true }),
]);
check("registros vencidos y señuelos inyectados (datos de prueba)", okR2 && sts.every((s) => s === 200), sts.join(","));
const recienteAntes = (await fsGet(`visitantes/${v1.body.id}`, A)).status === 200;
console.log("  (esperando al cron de retención, hasta 7 min…)");
let borrado = false;
for (let i = 0; i < 28 && !borrado; i++) { await espera(15000); borrado = (await fsGet(`visitantes/viejo-${sx}`, A)).status === 404; }
check("retención: el cron BORRÓ el registro vencido de visitante (entrada, salida, vista)", borrado && (await fsGet(`visitantesVista/viejo-${sx}`, A)).status === 404 && (await fsGet(`salidasVisitante/viejo-${sx}`, A)).status === 404);
check("retención: borró la FOTO vencida del visitante en R2", borrado && !existeR2(kViejo));
check("retención: NO tocó señuelos (incidencia y novedad antiguas, marca antigua, su foto en R2)", (await fsGet(`incidencias/viejo-${sx}`, A)).status === 200 && (await fsGet(`novedades/viejo-${sx}`, A)).status === 200 && (await fsGet(`marcas/t-viejo-${sx}_entrada`, A)).status === 200 && existeR2(kSenuelo));
check("retención: conserva los visitantes recientes (y su foto)", recienteAntes && (await fsGet(`visitantes/${v1.body.id}`, A)).status === 200 && (await fsGet(`visitantesVista/${v1.body.id}`, A)).status === 200 && (await fv(A)).status === 200);
const lista = await (await fetch(`${FS}/auditoria?pageSize=300`, { headers: { authorization: `Bearer ${A}` } })).json();
check("retención: queda registro de la purga en la bitácora", (lista.documents || []).some((d) => d.fields.accion?.stringValue === "visitantes.purga" && d.createTime >= inicioCorrida));
try { execSync(`wrangler r2 object delete marpec-guardias-selfies/${kSenuelo} --remote`, { cwd: "worker", stdio: "pipe" }); } catch { /* limpieza del señuelo */ }

// ---------------------------------------------------------------- bitácora de prueba
const nuevas = (lista.documents || []).filter((d) => d.createTime >= inicioCorrida && d.fields.accion?.stringValue !== "visitantes.purga");
check("bitácora: TODAS las entradas de esta corrida llevan prueba=true", nuevas.length > 8 && nuevas.every((d) => d.fields.prueba?.booleanValue === true), `${nuevas.filter((d) => d.fields.prueba?.booleanValue === true).length}/${nuevas.length}`);
void writeFs;

console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS EN REAL (FASE 5) PASARON");
process.exit(fallos ? 1 : 0);
