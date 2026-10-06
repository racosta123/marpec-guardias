// Prepara un sitio de PRUEBA con QR imprimible y un guardia de PRUEBA con un turno de hoy.
// Uso: node tools/preparar-demo.mjs <uid-admin>
// Todo queda marcado prueba=true (se borra con tools/borrar-pruebas.mjs --aplicar).
// Salidas locales (ignoradas por git): .tools/demo-acceso.txt y .tools/qr-demo.html
import "./_referer.mjs"; // la clave web está restringida por Referer
import { execSync } from "node:child_process";
import { createSign, randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qrMatriz } from "./qr-entry.js";

const PROJECT = "marpec-guardias";
const W = "https://marpec-guardias-proxy.acosta4770.workers.dev";
const APP = "https://racosta123.github.io/marpec-guardias";
const KEY = /apiKey:\s*"([^"]+)"/.exec(readFileSync("js/config.js", "utf8"))[1]; // apiKey web (pública)
const SA = `marpec-worker@${PROJECT}.iam.gserviceaccount.com`;
const adminUid = process.argv[2];
if (!adminUid) throw new Error("falta uid del admin");
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

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

const ac = adminCustomToken();
await new Promise((r) => setTimeout(r, 10000));
let A;
try {
  const r = await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ac.token, returnSecureToken: true }) }));
  A = r.body.idToken;
} finally { ac.cleanup(); }
if (!A) throw new Error("no se obtuvo token de admin");

const api = (path, { method = "POST", body } = {}) =>
  fetch(`${W}${path}`, { method, headers: { "content-type": "application/json", origin: "https://racosta123.github.io", authorization: `Bearer ${A}` }, body: body && JSON.stringify(body) }).then(j);

const sx = randomBytes(2).toString("hex");
const numero = `DEMO${sx}`.toUpperCase();
const pin = String(randomInt(100000, 999999)); // 6 dígitos
const hoy = new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10); // fecha local de Hermosillo

const g = await api("/admin/usuarios", { body: { rol: "guardia", nombre: "PRUEBA Guardia Demo", numeroEmpleado: numero, pin, prueba: true } });
const s = await api("/admin/sitios", { body: { nombre: "PRUEBA Sitio Demo", direccion: "Sitio de prueba (captura tu ubicación desde la app)", cliente: "PRUEBA",
  consignas: "1. Esto es una PRUEBA.\n2. Escanea el QR del puesto con la app.\n3. Verifica que el GPS marque dentro del perímetro.", radioM: 100, prueba: true } });
if (g.status !== 201 || s.status !== 201) throw new Error(`falló alta: guardia ${g.status} sitio ${s.status} ${JSON.stringify([g.body, s.body])}`);
const t = await api("/turnos/asignar-lote", { body: { sitioId: s.body.id, plantilla: "personalizada", desde: hoy, hasta: hoy, horaInicio: "00:00", horaFin: "23:59", guardiaUid: g.body.uid } });
if (t.status !== 201) throw new Error(`falló turno: ${t.status} ${JSON.stringify(t.body)}`);
const qr = await api(`/sitios/qr?id=${s.body.id}`, { method: "GET" });

// QR imprimible local (mismo contenido firmado que imprime la app)
const { n, oscuro } = qrMatriz(qr.body.payload);
const q = 4;
let d = "";
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (oscuro[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
const logo = readFileSync("marpec-logo.png").toString("base64");
const html = `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><title>QR · PRUEBA Sitio Demo</title><style>
body{font-family:system-ui,sans-serif;text-align:center;margin:0;padding:24px;color:#1B2A55}img{width:120px}h1{margin:6px 0}h2{font-size:2rem;margin:0;text-transform:uppercase}
svg{width:min(80vw,460px);height:auto;margin:14px auto;display:block}p{color:#5b6477}button{font-size:1.1rem;padding:12px 24px;border:0;border-radius:10px;background:#E8A33D;color:#14204a;font-weight:700;cursor:pointer}
@media print{button{display:none}}</style></head><body>
<img alt="MARPEC" src="data:image/png;base64,${logo}"><h1>MARPEC Seguridad Privada</h1><h2>PRUEBA Sitio Demo</h2><p>Sitio de PRUEBA</p>
<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><rect width="${n + 2 * q}" height="${n + 2 * q}" fill="#fff"/><path d="${d}"/></svg>
<p>Código de puesto v${qr.body.version} · Escanear solo con la app MARPEC Guardias</p><button onclick="print()">Imprimir</button></body></html>`;
mkdirSync(".tools", { recursive: true });
writeFileSync(".tools/qr-demo.html", html);
const acceso = `Guardia de PRUEBA\n  App: ${APP}/\n  Número de empleado: ${numero}\n  PIN: ${pin}\nSitio de PRUEBA: ${s.body.id}\n  QR imprimible (requiere iniciar sesión como admin): ${APP}/qr.html?id=${s.body.id}\n  QR local: .tools/qr-demo.html\n`;
writeFileSync(".tools/demo-acceso.txt", acceso);
console.log(acceso);
