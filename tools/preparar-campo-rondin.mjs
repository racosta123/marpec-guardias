// Prepara una PRUEBA EN CAMPO de rondines sobre un sitio de prueba existente:
// 3 puntos de control SIN GPS (ruta ordenada), guardia de prueba nuevo con turno que empieza en N minutos y un
// rondín programado a los M minutos del inicio. Genera una página local con los QR (asistencia + puntos).
// Uso: node tools/preparar-campo-rondin.mjs <uid-admin> <sitioId> [minInicio=10] [minRondin=20] [tolInicio=30] [tolFin=60]
// Salidas locales (ignoradas por git): .tools/campo-rondin-acceso.txt y .tools/qr-campo-completo.html
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
const [adminUid, sitioId, minIni = "10", minRondin = "20", tolIni = "30", tolFin = "60"] = process.argv.slice(2);
if (!adminUid || !sitioId) throw new Error("uso: node tools/preparar-campo-rondin.mjs <uid-admin> <sitioId> [minInicio] [minRondin] [tolInicio] [tolFin]");
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

// Tiempos (minuto exacto, hora de Hermosillo)
const ini = Math.ceil((Date.now() + Number(minIni) * 60000) / 60000) * 60000;
const fin = ini + 3 * 3600000;
const slot = ini + Number(minRondin) * 60000;
const hhmm = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(11, 16);
const fecha = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(0, 10);
if (fecha(ini) !== fecha(fin)) throw new Error("El turno cruzaría la medianoche; ejecuta más temprano.");

// 1) Tres puntos sin GPS (heredan prueba=true del sitio de prueba)
const nombres = [["Punto 1 · Portón", "Entrada principal"], ["Punto 2 · Bodega", "Puerta lateral"], ["Punto 3 · Azotea", "Escalera norte"]];
const puntos = [];
for (const [i, [nombre, descripcion]] of nombres.entries()) {
  const r = await api("/admin/puntos", { body: { sitioId, nombre, descripcion, orden: i + 1 } });
  if (r.status !== 201) throw new Error(`punto ${i + 1} falló: ${r.status} ${JSON.stringify(r.body)}`);
  puntos.push(r.body.id);
}
// 2) Programación: ruta ordenada, un rondín a la hora fija
const pr = await api("/rondines/programa", { body: { sitioId, modo: "ordenada", frecuencia: { tipo: "horarios", horarios: [hhmm(slot)] }, toleranciaInicioMin: Number(tolIni), toleranciaFinMin: Number(tolFin) } });
if (pr.status !== 200) throw new Error(`programa falló: ${pr.status} ${JSON.stringify(pr.body)}`);
// 3) Guardia y turno
const numero = `DEMO${randomInt(1000, 9999)}`;
const pin = String(randomInt(100000, 999999));
const g = await api("/admin/usuarios", { body: { rol: "guardia", nombre: "PRUEBA Guardia Rondín", numeroEmpleado: numero, pin, prueba: true } });
if (g.status !== 201) throw new Error(`alta de guardia falló: ${g.status} ${JSON.stringify(g.body)}`);
const t = await api("/turnos/asignar-lote", { body: { sitioId, plantilla: "personalizada", desde: fecha(ini), hasta: fecha(ini), horaInicio: hhmm(ini), horaFin: hhmm(fin), guardiaUid: g.body.uid } });
if (t.status !== 201) throw new Error(`turno falló: ${t.status} ${JSON.stringify(t.body)}`);
// 4) QR vigentes
const qa = await api(`/sitios/qr?id=${sitioId}`, { method: "GET" });
const qs = await api(`/puntos/qr-sitio?sitioId=${sitioId}`, { method: "GET" });
if (qa.status !== 200 || qs.status !== 200) throw new Error("no se pudieron obtener los QR");
const mios = qs.body.puntos.filter((p) => puntos.includes(p.id));

// Página local con todos los QR (para escanear desde la pantalla de la PC; no requiere sesión)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svg = (texto) => {
  const { n, oscuro } = qrMatriz(texto);
  const q = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (oscuro[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><rect width="${n + 2 * q}" height="${n + 2 * q}" fill="#fff"/><path d="${d}"/></svg>`;
};
const logo = readFileSync("marpec-logo.png").toString("base64");
const tarjeta = (titulo, sub, payload, pie) => `<section><img alt="MARPEC" src="data:image/png;base64,${logo}"><p class="s">${esc(qa.body.sitio.nombre)}</p><h2>${esc(titulo)}</h2><p>${esc(sub)}</p>${svg(payload)}<p class="s">${esc(pie)}</p></section>`;
const html = `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><title>QR de la prueba en campo</title><style>
body{font-family:system-ui,sans-serif;margin:0;padding:18px;color:#1B2A55;background:#fff}h1{text-align:center}section{border:2px solid #1B2A55;border-radius:14px;padding:12px;margin:14px auto;max-width:420px;text-align:center;break-inside:avoid}
img{width:54px}h2{margin:2px 0;text-transform:uppercase}svg{width:100%;max-width:300px;display:block;margin:6px auto}p{margin:2px 0;color:#5b6477}.s{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
button{display:block;margin:12px auto;font-size:1.1rem;padding:12px 24px;border:0;border-radius:10px;background:#E8A33D;color:#14204a;font-weight:700;cursor:pointer}@media print{button{display:none}}</style></head><body>
<h1>Prueba en campo · MARPEC</h1><button onclick="print()">Imprimir</button>
${tarjeta("QR de ASISTENCIA", "Para marcar entrada y salida", qa.body.payload, `Código de puesto v${qa.body.version}`)}
${mios.map((p) => tarjeta(p.nombre, p.descripcion, p.payload, `Punto de control v${p.version} · escanear solo con la app`)).join("\n")}
</body></html>`;
mkdirSync(".tools", { recursive: true });
writeFileSync(".tools/qr-campo-completo.html", html);
const acceso = `Guardia de PRUEBA (rondines)
  App: ${APP}/
  Número de empleado: ${numero}
  PIN: ${pin}
Sitio: ${qa.body.sitio.nombre} (${sitioId})
Turno de hoy: ${hhmm(ini)}–${hhmm(fin)} (hora de Hermosillo); la entrada se habilita desde las ${hhmm(ini - 30 * 60000)}
Rondín programado: ${hhmm(slot)}  · se puede iniciar de ${hhmm(slot - Number(tolIni) * 60000)} a ${hhmm(slot + Number(tolIni) * 60000)} · debe quedar completo a las ${hhmm(slot + Number(tolFin) * 60000)}
Puntos (ruta ORDENADA, sin GPS): ${mios.map((p) => p.nombre).join(" → ")}
Hoja de QR de los puntos (requiere sesión de admin): ${APP}/punto-qr.html?sitio=${sitioId}
QR de asistencia (requiere sesión de admin): ${APP}/qr.html?id=${sitioId}
Todos los QR en una página local (sin sesión): .tools/qr-campo-completo.html
`;
writeFileSync(".tools/campo-rondin-acceso.txt", acceso);
console.log(acceso);
