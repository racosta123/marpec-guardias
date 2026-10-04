// Pruebas de seguridad de la FASE 2 EN REAL (Firebase + Worker desplegados).
// Uso: node tools/e2e-real-fase2.mjs <uid-admin>
// Crea datos de PRUEBA (prueba=true) que se borran con: node tools/borrar-pruebas.mjs --aplicar
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

let fallos = 0;
const check = (nombre, ok, extra = "") => {
  console.log(`${ok ? "✔" : "✖"} ${nombre}${extra ? "  → " + extra : ""}`);
  if (!ok) fallos++;
};
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const claims = (tok) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());

async function canjear(customToken) {
  const r = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }));
  return { idToken: r.body.idToken, refreshToken: r.body.refreshToken };
}

// Llave TEMPORAL de la cuenta de servicio solo para firmar el token del admin; se revoca al terminar.
function adminCustomToken() {
  const f = join(tmpdir(), `k-${randomBytes(6).toString("hex")}.json`);
  try {
    execSync(`gcloud iam service-accounts keys create "${f}" --iam-account=${SA} --project=${PROJECT}`, { stdio: "pipe" });
    const k = JSON.parse(readFileSync(f, "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b({ alg: "RS256", typ: "JWT" })}.${b({
      iss: SA, sub: SA, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      iat: now, exp: now + 300, uid: adminUid, claims: { rol: "admin" } })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(k.private_key).toString("base64url");
    return { token: `${unsigned}.${sig}`, cleanup: () => execSync(`gcloud iam service-accounts keys delete ${k.private_key_id} --iam-account=${SA} --project=${PROJECT} --quiet`, { stdio: "pipe" }) };
  } finally { rmSync(f, { force: true }); }
}

const api = (path, { method = "POST", token, body, origin = ORIGIN } = {}) =>
  fetch(`${W}${path}`, { method, headers: { "content-type": "application/json", origin, "x-prueba": "1", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) }).then(j);
const fsGet = (path, token) => fetch(`${FS}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(j);
// Consulta REST con las MISMAS reglas que el cliente (token de usuario).
const fsQuery = (coleccion, campo, valor, token) => fetch(`${FS}:runQuery`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coleccion }], where: { fieldFilter: { field: { fieldPath: campo }, op: "EQUAL", value: { stringValue: valor } } }, limit: 50 } }) }).then(j);
const fsList = (coleccion, token) => fsGet(coleccion, token);
const hay = (r) => Array.isArray(r.body) && r.body.some((x) => x.document);

// ---------------------------------------------------------------- preparación
const ac = adminCustomToken();
await espera(10000);
let A;
try { A = (await canjear(ac.token)).idToken; } finally { ac.cleanup(); console.log("llave temporal revocada"); }
check("token de admin", Boolean(A));

const sx = randomBytes(3).toString("hex");
const pinA = String(randomInt(1000, 9999)), pinB = String(randomInt(1000, 9999)), pass = randomBytes(18).toString("base64url") + "aA1";
const numA = `PF${sx}A`.toUpperCase(), numB = `PF${sx}B`.toUpperCase();
const mk = (b) => api("/admin/usuarios", { token: A, body: { ...b, prueba: true } });
const gA = (await mk({ rol: "guardia", nombre: "PRUEBA F2 Guardia A", numeroEmpleado: numA, pin: pinA })).body.uid;
const gB = (await mk({ rol: "guardia", nombre: "PRUEBA F2 Guardia B", numeroEmpleado: numB, pin: pinB })).body.uid;
const s1 = await mk({ rol: "supervisor", nombre: "PRUEBA F2 Sup 1", email: `prueba-f2-1-${sx}@prueba.invalid`, password: pass });
const s2 = await mk({ rol: "supervisor", nombre: "PRUEBA F2 Sup 2", email: `prueba-f2-2-${sx}@prueba.invalid`, password: pass });
check("personal de prueba creado", Boolean(gA && gB && s1.body.uid && s2.body.uid));
const sit = (nombre, sup) => api("/admin/sitios", { token: A, body: { nombre, direccion: "Calle Prueba", cliente: "PRUEBA", consignas: `Consigna secreta de ${nombre}`, supervisorUid: sup, lat: 29.07, lng: -110.95, precisionM: 9, radioM: 100, prueba: true } });
const sA = (await sit("PRUEBA F2 Sitio A", s1.body.uid)).body.id;
const sB = (await sit("PRUEBA F2 Sitio B", s2.body.uid)).body.id;
check("sitios de prueba creados", Boolean(sA && sB));

const fecha = (n) => new Date(Date.now() - 7 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const lote = (token, b) => api("/turnos/asignar-lote", { token, body: { plantilla: "diurno", desde: fecha(10), hasta: fecha(11), prueba: true, ...b } });
check("turnos de A para guardia A", (await lote(A, { sitioId: sA, guardiaUid: gA })).status === 201);
check("turnos de B para guardia B", (await lote(A, { sitioId: sB, guardiaUid: gB })).status === 201);
const vac = await lote(A, { sitioId: sA, plantilla: "nocturno", desde: fecha(12), hasta: fecha(12) });
check("turno vacante (sin guardia)", vac.status === 201);

const tok = async (num, pin) => { const l = await api("/auth/guardia", { body: { numero: num, pin } }); return { l, ...(l.body.token ? await canjear(l.body.token) : {}) }; };
const TA = await tok(numA, pinA);
const gTokA = TA.idToken;
const sl = (email) => fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: pass, returnSecureToken: true }) }).then(j);
const S1 = (await sl(`prueba-f2-1-${sx}@prueba.invalid`)).body.idToken;
check("login de guardia A y supervisor 1", Boolean(gTokA && S1));

// ---------------------------------------------------------------- sin sesión
check("sin sesión: no lee sitios/turnos/usuarios/auditoría", (await Promise.all(["sitios/" + sA, "turnos", "usuarios", "auditoria", "configuracion/empresa"].map((p) => fsGet(p)))).every((r) => r.status === 403));
check("sin sesión: Worker rechaza", (await api("/turnos/asignar-lote", { body: {} })).status === 401);

// ---------------------------------------------------------------- guardia A: aislamiento
const idsB = (await fsQuery("turnos", "guardiaUid", gB, A)).body;
const turnoB = idsB.find((x) => x.document)?.document.name.split("/").pop();
check("guardia: lee SU sitio y sus turnos", (await fsGet(`sitios/${sA}`, gTokA)).status === 200 && hay(await fsQuery("turnos", "guardiaUid", gA, gTokA)));
check("guardia: NO lee el sitio de otro (ni su consigna)", (await fsGet(`sitios/${sB}`, gTokA)).status === 403);
check("guardia: NO lee turnos de otro guardia (consulta)", !hay(await fsQuery("turnos", "guardiaUid", gB, gTokA)));
check("guardia: NO lee un turno ajeno por id", turnoB ? (await fsGet(`turnos/${turnoB}`, gTokA)).status === 403 : false);
check("guardia: NO lista sitios ni turnos ni usuarios ni auditoría", (await Promise.all(["sitios", "turnos", "usuarios", "auditoria"].map((c) => fsList(c, gTokA)))).every((r) => r.status === 403));
check("guardia: NO lee perfil de otro ni credenciales", (await fsGet(`usuarios/${gB}`, gTokA)).status === 403 && (await fsGet(`credenciales/${numA}`, gTokA)).status === 403);
check("guardia: NO crea sitios/personal/turnos/config por el Worker",
  (await Promise.all([api("/admin/sitios", { token: gTokA, body: { nombre: "X" } }), api("/admin/usuarios", { token: gTokA, body: { rol: "guardia" } }),
    api("/turnos/asignar-lote", { token: gTokA, body: { sitioId: sA, plantilla: "diurno", desde: fecha(20), hasta: fecha(20) } }), api("/admin/config", { token: gTokA, body: {} })])).every((r) => r.status === 403));
check("guardia: NO escribe directo en Firestore", (await fetch(`${FS}/turnos/${turnoB}?updateMask.fieldPaths=guardiaUid`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${gTokA}` }, body: JSON.stringify({ fields: { guardiaUid: { stringValue: gA } } }) })).status === 403);

// ---------------------------------------------------------------- supervisor 1
check("supervisor: ve turnos de SU sitio", hay(await fsQuery("turnos", "supervisorUid", s1.body.uid, S1)));
check("supervisor: NO ve turnos de otro supervisor", !hay(await fsQuery("turnos", "supervisorUid", s2.body.uid, S1)));
check("supervisor: NO lee el sitio de otro", (await fsGet(`sitios/${sB}`, S1)).status === 403);
check("supervisor: NO crea sitios ni personal ni config", (await Promise.all([
  api("/admin/sitios", { token: S1, body: { nombre: "X" } }), api("/admin/usuarios", { token: S1, body: { rol: "guardia" } }), api("/admin/config", { token: S1, body: {} })])).every((r) => r.status === 403));
check("supervisor: gestiona turnos de SU sitio", (await lote(S1, { sitioId: sA, guardiaUid: null, desde: fecha(14), hasta: fecha(14) })).status === 201);
check("supervisor: NO toca turnos de otro sitio", (await lote(S1, { sitioId: sB, guardiaUid: null, desde: fecha(14), hasta: fecha(14) })).status === 403);

// ---------------------------------------------------------------- empalmes
const emp = await lote(A, { sitioId: sB, guardiaUid: gA }); // mismas fechas que ya tiene en A
check("empalme: un guardia no puede estar en dos sitios a la vez", emp.status === 409 && emp.body.error === "empalme");
check("empalme: mismo sitio y horario rechazado", (await lote(A, { sitioId: sA, guardiaUid: gA })).status === 409);

// ---------------------------------------------------------------- QR
const qa = await api(`/sitios/qr?id=${sA}`, { method: "GET", token: A });
const ver = (payload, sitioId) => api("/qr/verificar", { token: gTokA, body: { payload, ...(sitioId ? { sitioId } : {}) } });
check("QR: válido se acepta", qa.status === 200 && (await ver(qa.body.payload, sA)).status === 200);
const p = qa.body.payload.split(".");
check("QR: alterado se rechaza", (await ver([p[0], p[1], p[2], (p[3][0] === "A" ? "B" : "A") + p[3].slice(1)].join("."))).status === 400);
check("QR: de otro sitio se rechaza", (await ver(qa.body.payload, sB)).status === 400 && (await ver([p[0], sB, p[2], p[3]].join("."))).status === 400);
check("QR: el supervisor ajeno no obtiene el QR", (await api(`/sitios/qr?id=${sA}`, { method: "GET", token: (await sl(`prueba-f2-2-${sx}@prueba.invalid`)).body.idToken })).status === 403);
check("QR: regenerar invalida el viejo", (await api("/admin/sitios/regenerar-qr", { token: A, body: { id: sA } })).status === 200 && (await ver(qa.body.payload)).status === 400);
const qn = await api(`/sitios/qr?id=${sA}`, { method: "GET", token: A });
check("QR: el nuevo funciona", (await ver(qn.body.payload)).status === 200);

// ---------------------------------------------------------------- PIN
const mal = pinB === "1111" ? "2222" : "1111";
for (let i = 0; i < 5; i++) await api("/auth/guardia", { body: { numero: numB, pin: mal } });
check("PIN: bloqueado tras 5 fallos (incluso con PIN correcto)", (await api("/auth/guardia", { body: { numero: numB, pin: pinB } })).status === 401);
check("PIN: el admin desbloquea", (await api("/admin/usuarios/desbloquear-pin", { token: A, body: { numero: numB } })).status === 200 && (await api("/auth/guardia", { body: { numero: numB, pin: pinB } })).status === 200);
const nuevoPin = String(randomInt(1000, 9999));
check("PIN: el admin lo restablece", (await api("/admin/usuarios/restablecer-pin", { token: A, body: { numero: numB, pin: nuevoPin } })).status === 200 && (await api("/auth/guardia", { body: { numero: numB, pin: nuevoPin } })).status === 200);

// ---------------------------------------------------------------- baja: acceso cortado de inmediato
check("baja: antes de la baja el guardia A SÍ tiene acceso", (await fsGet(`sitios/${sA}`, gTokA)).status === 200 && (await api("/me", { method: "GET", token: gTokA })).status === 200);
const baja = await api("/admin/usuarios/baja", { token: A, body: { uid: gA } });
check("baja: registrada y turnos liberados", baja.status === 200 && baja.body.turnosLiberados >= 1, JSON.stringify(baja.body));
check("baja: el ID token aún vigente YA NO lee Firestore", (await fsGet(`sitios/${sA}`, gTokA)).status === 403 && (await fsGet(`usuarios/${gA}`, gTokA)).status === 403);
check("baja: el Worker rechaza el token", (await api("/me", { method: "GET", token: gTokA })).status === 403);
check("baja: no puede volver a entrar con PIN correcto", (await api("/auth/guardia", { body: { numero: numA, pin: pinA } })).status === 401);
const ref = await fetch(`https://securetoken.googleapis.com/v1/token?key=${KEY}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(TA.refreshToken)}` }).then(j);
check("baja: el refresh token fue REVOCADO (no obtiene tokens nuevos)", ref.status >= 400 && !ref.body.id_token, ref.body.error?.message);

// ---------------------------------------------------------------- config y bitácora
check("config: admin guarda", (await api("/admin/config", { token: A, body: { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3 } })).status === 200);
check("config: valores inválidos rechazados", (await api("/admin/config", { token: A, body: { toleranciaRetardoMin: 50, limiteFaltaMin: 10, retardosPorFalta: 3 } })).status === 400);
check("bitácora: el admin la lee; el supervisor no", (await fsList("auditoria?pageSize=3", A)).status === 200 && (await fsList("auditoria", S1)).status === 403);
check("bitácora: nadie la escribe desde el cliente", (await fetch(`${FS}/auditoria/falso`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${A}` }, body: JSON.stringify({ fields: { accion: { stringValue: "x" } } }) })).status === 403);

console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS EN REAL (FASE 2) PASARON");
writeFileSync(".tools/ultima-corrida-fase2.txt", new Date().toISOString());
process.exit(fallos ? 1 : 0);
