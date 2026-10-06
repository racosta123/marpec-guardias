// Prepara una PRUEBA EN CAMPO sobre un sitio de prueba existente: guardia de prueba nuevo con un turno
// que empieza en 15 minutos y el QR vigente imprimible.
// Uso: node tools/preparar-campo.mjs <uid-admin> <sitioId> [minutosParaInicio=15] [horasDuracion=3]
// Salidas locales (ignoradas por git): .tools/campo-acceso.txt y .tools/qr-campo.html
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
const [adminUid, sitioId, minIni = "15", horas = "3"] = process.argv.slice(2);
if (!adminUid || !sitioId) throw new Error("uso: node tools/preparar-campo.mjs <uid-admin> <sitioId> [min] [horas]");
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

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

const ac = adminCustomToken();
await new Promise((r) => setTimeout(r, 10000));
let A;
try {
  A = (await j(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ac.token, returnSecureToken: true }) }))).body.idToken;
} finally { ac.cleanup(); }
if (!A) throw new Error("no se obtuvo token de admin");
const api = (path, { method = "POST", body } = {}) =>
  fetch(`${W}${path}`, { method, headers: { "content-type": "application/json", origin: "https://racosta123.github.io", authorization: `Bearer ${A}` }, body: body && JSON.stringify(body) }).then(j);

// Inicio a un minuto exacto dentro de N minutos (hora de Hermosillo)
const t0 = Date.now();
const ini = Math.ceil((t0 + Number(minIni) * 60000) / 60000) * 60000;
const fin = ini + Number(horas) * 3600000;
const hhmm = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(11, 16);
const fecha = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(0, 10);
if (fecha(ini) !== fecha(fin)) throw new Error("El turno cruzaría la medianoche; reduce las horas.");

const numero = `DEMO${randomInt(1000, 9999)}`;
const pin = String(randomInt(100000, 999999));
const g = await api("/admin/usuarios", { body: { rol: "guardia", nombre: "PRUEBA Guardia Campo", numeroEmpleado: numero, pin, prueba: true } });
if (g.status !== 201) throw new Error(`alta de guardia falló: ${g.status} ${JSON.stringify(g.body)}`);
const t = await api("/turnos/asignar-lote", { body: { sitioId, plantilla: "personalizada", desde: fecha(ini), hasta: fecha(ini), horaInicio: hhmm(ini), horaFin: hhmm(fin), guardiaUid: g.body.uid } });
if (t.status !== 201) throw new Error(`turno falló: ${t.status} ${JSON.stringify(t.body)}`);
const qr = await api(`/sitios/qr?id=${sitioId}`, { method: "GET" });
if (qr.status !== 200) throw new Error(`QR falló: ${qr.status}`);

// QR imprimible local (mismo contenido firmado que imprime la app)
const { n, oscuro } = qrMatriz(qr.body.payload);
const q = 4;
let d = "";
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (oscuro[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
const logo = readFileSync("marpec-logo.png").toString("base64");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const html = `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><title>QR · ${esc(qr.body.sitio.nombre)}</title><style>
body{font-family:system-ui,sans-serif;text-align:center;margin:0;padding:24px;color:#1B2A55}img{width:120px}h1{margin:6px 0}h2{font-size:2rem;margin:0;text-transform:uppercase}
svg{width:min(80vw,460px);height:auto;margin:14px auto;display:block}p{color:#5b6477}button{font-size:1.1rem;padding:12px 24px;border:0;border-radius:10px;background:#E8A33D;color:#14204a;font-weight:700;cursor:pointer}
@media print{button{display:none}}</style></head><body>
<img alt="MARPEC" src="data:image/png;base64,${logo}"><h1>MARPEC Seguridad Privada</h1><h2>${esc(qr.body.sitio.nombre)}</h2><p>Sitio de PRUEBA</p>
<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><rect width="${n + 2 * q}" height="${n + 2 * q}" fill="#fff"/><path d="${d}"/></svg>
<p>Código de puesto v${qr.body.version} · Escanear solo con la app MARPEC Guardias</p><button onclick="print()">Imprimir</button></body></html>`;
mkdirSync(".tools", { recursive: true });
writeFileSync(".tools/qr-campo.html", html);
const acceso = `Guardia de PRUEBA (campo)\n  App: ${APP}/\n  Número de empleado: ${numero}\n  PIN: ${pin}\nSitio: ${qr.body.sitio.nombre} (${sitioId})\nTurno: hoy ${hhmm(ini)}–${hhmm(fin)} (hora de Hermosillo); entrada habilitada desde las ${hhmm(ini - 30 * 60000)}\nQR vigente v${qr.body.version}: .tools/qr-campo.html  |  en línea (admin): ${APP}/qr.html?id=${sitioId}\n`;
writeFileSync(".tools/campo-acceso.txt", acceso);
console.log(acceso);
