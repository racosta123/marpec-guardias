// Pruebas de seguridad EN REAL contra Firebase y el Worker desplegados.
// Uso: node tools/e2e-real.mjs <uid-admin>
// - Obtiene un token de admin firmando un custom token con la cuenta de servicio vía IAM (gcloud),
//   sin conocer contraseñas y sin llaves en disco.
// - Crea usuarios de PRUEBA (marcados prueba=true) y guarda sus credenciales en .tools/ (ignorado por git).
import { execSync } from "node:child_process";
import { createSign, randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

async function customToIdToken(customToken) {
  const r = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }));
  if (!r.body.idToken) console.log("  signInWithCustomToken:", r.status, JSON.stringify(r.body.error?.message));
  return r.body.idToken;
}

// Custom token de admin: se crea una llave TEMPORAL de la cuenta de servicio, se firma en memoria y la
// llave se borra del disco y se revoca en Google de inmediato (nunca se imprime ni se guarda).
function adminCustomToken() {
  let cleanup = () => {};
  const f = join(tmpdir(), `k-${randomBytes(6).toString("hex")}.json`);
  let keyId;
  try {
    execSync(`gcloud iam service-accounts keys create "${f}" --iam-account=${SA} --project=${PROJECT}`, { stdio: "pipe" });
    const k = JSON.parse(readFileSync(f, "utf8"));
    keyId = k.private_key_id;
    const now = Math.floor(Date.now() / 1000);
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b({ alg: "RS256", typ: "JWT" })}.${b({
      iss: SA, sub: SA, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      iat: now, exp: now + 300, uid: adminUid, claims: { rol: "admin" } })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(k.private_key).toString("base64url");
    cleanup = () => execSync(`gcloud iam service-accounts keys delete ${keyId} --iam-account=${SA} --project=${PROJECT} --quiet`, { stdio: "pipe" });
    return { token: `${unsigned}.${sig}`, cleanup: () => cleanup() };
  } finally {
    rmSync(f, { force: true });
  }
}

const api = (path, { method = "GET", token, body, origin = ORIGIN } = {}) =>
  fetch(`${W}${path}`, { method, headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) }).then(j);
const fsReq = (path, { method = "GET", token, body } = {}) =>
  fetch(`${FS}/${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) }).then(j);

// ---------------------------------------------------------------- admin + usuarios de prueba
const ac = adminCustomToken();
await new Promise((r) => setTimeout(r, 10000)); // propagación de la llave nueva en Google
let adminTok;
try { adminTok = await customToIdToken(ac.token); } finally { ac.cleanup(); console.log("llave temporal revocada"); }
check("token de admin obtenido", Boolean(adminTok));
const me = await api("/me", { token: adminTok });
check("/me admin", me.status === 200 && me.body.rol === "admin", `${me.body.nombre}`);

const sufijo = randomBytes(3).toString("hex");
const pinA = String(randomInt(1000, 9999)); // guardia principal
const pinB = String(randomInt(1000, 9999)); // guardia para prueba de bloqueo
const supPass = randomBytes(18).toString("base64url") + "aA1";
const numA = `PRB${sufijo}A`.toUpperCase();
const numB = `PRB${sufijo}B`.toUpperCase();
const supEmail = `prueba-sup-${sufijo}@prueba.invalid`;

const mk = (b) => api("/admin/usuarios", { method: "POST", token: adminTok, body: { ...b, prueba: true } });
check("crear guardia de prueba A", (await mk({ rol: "guardia", nombre: "PRUEBA Guardia A", numeroEmpleado: numA, pin: pinA })).status === 201);
check("crear guardia de prueba B", (await mk({ rol: "guardia", nombre: "PRUEBA Guardia B", numeroEmpleado: numB, pin: pinB })).status === 201);
check("crear supervisor de prueba", (await mk({ rol: "supervisor", nombre: "PRUEBA Supervisor", email: supEmail, password: supPass })).status === 201);

mkdirSync(".tools", { recursive: true });
writeFileSync(".tools/test-creds.json", JSON.stringify({ guardiaA: { numero: numA, pin: pinA }, guardiaB: { numero: numB, pin: pinB }, supervisor: { email: supEmail, password: supPass } }, null, 2));

// ---------------------------------------------------------------- sin sesión
const anonR = await fsReq("usuarios/g-" + numA);
check("sin sesión: Firestore lectura denegada", anonR.status === 403, `HTTP ${anonR.status}`);
const anonW = await fsReq("usuarios/hack", { method: "PATCH", body: { fields: { rol: { stringValue: "admin" } } } });
check("sin sesión: Firestore escritura denegada", anonW.status === 403, `HTTP ${anonW.status}`);
check("sin sesión: Worker /me → 401", (await api("/me")).status === 401);
check("sin sesión: Worker /admin/usuarios → 401", (await api("/admin/usuarios", { method: "POST", body: { rol: "guardia" } })).status === 401);

// ---------------------------------------------------------------- guardia A
const lg = await api("/auth/guardia", { method: "POST", body: { numero: numA, pin: pinA } });
check("guardia: login con PIN correcto", lg.status === 200 && Boolean(lg.body.token));
const gTok = await customToIdToken(lg.body.token);
check("guardia: custom token canjeado por ID token", Boolean(gTok));
const gClaims = JSON.parse(Buffer.from(gTok.split(".")[1], "base64url").toString());
check("guardia: claim rol=guardia", gClaims.rol === "guardia", gClaims.sub);
const gMe = await api("/me", { token: gTok });
check("guardia: /me devuelve su nombre y rol", gMe.status === 200 && gMe.body.rol === "guardia" && /PRUEBA Guardia A/.test(gMe.body.nombre));
check("guardia: lee SU perfil en Firestore", (await fsReq(`usuarios/g-${numA}`, { token: gTok })).status === 200);
check("guardia: NO lee perfil de otro guardia", (await fsReq(`usuarios/g-${numB}`, { token: gTok })).status === 403);
check("guardia: NO lee perfil del admin", (await fsReq(`usuarios/${adminUid}`, { token: gTok })).status === 403);
check("guardia: NO lista usuarios", (await fsReq("usuarios", { token: gTok })).status === 403);
check("guardia: NO lee credenciales", (await fsReq(`credenciales/${numA}`, { token: gTok })).status === 403);
check("guardia: NO lee ajustes/sistema", (await fsReq("ajustes/sistema", { token: gTok })).status === 403);
const selfUp = await fsReq(`usuarios/g-${numA}?updateMask.fieldPaths=rol`, { method: "PATCH", token: gTok, body: { fields: { rol: { stringValue: "admin" } } } });
check("guardia: NO puede cambiarse el rol (Firestore)", selfUp.status === 403, `HTTP ${selfUp.status}`);
const selfNew = await fsReq("usuarios/g-INTRUSO", { method: "PATCH", token: gTok, body: { fields: { rol: { stringValue: "admin" } } } });
check("guardia: NO puede crear documentos", selfNew.status === 403);
check("guardia: NO puede borrar su perfil", (await fsReq(`usuarios/g-${numA}`, { method: "DELETE", token: gTok })).status === 403);
const esc = await api("/admin/usuarios", { method: "POST", token: gTok, body: { rol: "supervisor", nombre: "X", email: `x-${sufijo}@prueba.invalid`, password: "una-clave-muy-larga-1" } });
check("guardia: NO puede crear usuarios/roles vía Worker", esc.status === 403, `HTTP ${esc.status}`);

// ---------------------------------------------------------------- supervisor (correo + contraseña)
const sl = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: supEmail, password: supPass, returnSecureToken: true }) }));
const sTok = sl.body.idToken;
check("supervisor: login correo+contraseña", Boolean(sTok));
const sClaims = sTok ? JSON.parse(Buffer.from(sTok.split(".")[1], "base64url").toString()) : {};
check("supervisor: claim rol=supervisor", sClaims.rol === "supervisor");
check("supervisor: lee SU perfil", (await fsReq(`usuarios/${sClaims.user_id}`, { token: sTok })).status === 200);
check("supervisor: NO lee perfil de un guardia", (await fsReq(`usuarios/g-${numA}`, { token: sTok })).status === 403);
check("supervisor: NO crea usuarios vía Worker", (await api("/admin/usuarios", { method: "POST", token: sTok, body: { rol: "guardia" } })).status === 403);
const badLogin = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: supEmail, password: "incorrecta-123", returnSecureToken: true }) }));
check("supervisor: contraseña incorrecta rechazada", badLogin.status === 400);

// ---------------------------------------------------------------- bloqueo de PIN (guardia B)
const wrong = pinB === "1111" ? "2222" : "1111";
const msgs = [];
for (let i = 1; i <= 5; i++) { const r = await api("/auth/guardia", { method: "POST", body: { numero: numB, pin: wrong } }); msgs.push(r.status); }
check("bloqueo: 5 PIN incorrectos → 401", msgs.every((s) => s === 401), msgs.join(","));
const afterLock = await api("/auth/guardia", { method: "POST", body: { numero: numB, pin: pinB } });
check("bloqueo: con PIN CORRECTO sigue bloqueado (15 min)", afterLock.status === 401 && !afterLock.body.token, JSON.stringify(afterLock.body.error));
const unknown = await api("/auth/guardia", { method: "POST", body: { numero: "NOEXISTE9", pin: "1234" } });
check("error genérico: inexistente = incorrecto", unknown.status === 401 && unknown.body.mensaje === afterLock.body.mensaje);

// ---------------------------------------------------------------- CORS
const evil = await api("/me", { token: adminTok, origin: "https://evil.example" });
check("CORS: origen ajeno rechazado aun con token válido", evil.status === 403);

console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS EN REAL PASARON");
process.exit(fallos ? 1 : 0);
