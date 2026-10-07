// Revisión de contraste sobre las PANTALLAS REALES (Chrome por CDP, app con datos simulados): para cada texto visible calcula el
// contraste entre su color y el fondo efectivo y marca los que no llegan a WCAG AA (4.5:1; 3:1 en texto grande ≥ 24 px o ≥ 18.66 px en negritas).
// Se omiten los controles deshabilitados (exentos en WCAG) y los textos sin contenido. Uso: node tools/serve.mjs 5182 --fake  y luego
//   node tools/contraste-pantallas.mjs http://localhost:5182
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("uso: node tools/contraste-pantallas.mjs <urlBase>");
const CEL = { width: 360, height: 780, deviceScaleFactor: 2, mobile: true };
const PC = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const CLAVES = ["vivo", "asistencia", "rondines", "incidencias", "visitantes", "bitacoras", "offline", "alertas", "turnos", "sitios", "personal", "reportes", "empresa", "bitacora"];
const LIBRO = (re) => `[...document.querySelectorAll('.libro-btn')].find((b) => ${re}.test(b.textContent)).click()`;
const G = "/index.html?rol=guardia&entrada=1&hace=4.1";
const FORM_SITIO = (extra = "") => `(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); document.querySelector('[data-clave=sitios]').click(); await w(800); [...document.querySelectorAll('button')].find((b) => b.textContent.includes('+ Sitio')).click(); await w(300); const i = document.querySelector('.ubicacion .enlace-fila input'); i.value = '29.0729, -110.9559'; document.querySelector('.ubicacion .enlace-fila button').click(); ${extra} })()`;
const ESCENAS = [
  ["guardia en turno", G, CEL], ["guardia sin marcar", "/index.html?rol=guardia", CEL], ["guardia sin conexión", `${G}&offline=1`, CEL],
  ["marcar (intro)", "/index.html?rol=guardia", CEL, "document.querySelector('.btn.grande').click()"],
  ["libro: novedad", G, CEL, LIBRO(/Novedad/)], ["libro: incidencia", G, CEL, LIBRO(/incidencia/i)], ["libro: visitantes", G, CEL, LIBRO(/Visitantes/)], ["libro: bitácora", G, CEL, LIBRO(/Bitácora/)],
  ["rondín", G, CEL, "[...document.querySelectorAll('button')].find((b) => /INICIAR RONDÍN/.test(b.textContent)).click()"],
  ["vivo con pánico", "/index.html?rol=admin&demo=vivo", PC], ["vivo sin pánico", "/index.html?rol=admin&demo=vivo&sinpanico=1", PC], ["vivo celular", "/index.html?rol=admin&demo=vivo&sinpanico=1", CEL],
  ["login", "/index.html?rol=ninguno", CEL], ["demo concluida", "/index.html?rol=guardia&lic=vencida", CEL], ["banner de licencia", "/index.html?rol=admin&lic=d5", PC], ["privacidad", "/privacidad.html", CEL],
  ...[["PC", PC], ["celular", CEL]].flatMap(([t, v]) => [
    [`formulario de sitio con ubicación (${t})`, "/index.html?rol=admin", v, FORM_SITIO()],
    [`ventana «Elegir en el mapa» (${t})`, "/index.html?rol=admin", v, FORM_SITIO("await w(300); [...document.querySelectorAll('.ubicacion button')].find((b) => /Elegir en el mapa/.test(b.textContent)).click(); await w(2500);")],
  ]),
  ...CLAVES.map((k) => [`sección ${k}`, "/index.html?rol=admin", PC, `document.querySelector('[data-clave=${k}]').click()`]),
];

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "con-"));
const puerto = 9800 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const MIDE = `(() => {
  const num = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const mezcla = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) });
  const fondo = (el) => { let capas = []; for (let e = el; e; e = e.parentElement) { const c = num(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { capas.push(c); if (c.a >= 0.99) break; } } let base = { r: 255, g: 255, b: 255 }; for (const c of capas.reverse()) base = mezcla(c, base); return base; };
  const out = [];
  const vistos = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') || el.disabled || el.closest('[disabled]')) continue;
    const tieneTexto = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!tieneTexto) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity); if (op < 0.5) continue;
    const c = num(cs.color); if (!c) continue;
    const bg = fondo(el);
    const fg = mezcla({ ...c, a: c.a * op }, bg);
    const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p);
    const ratio = (x + 0.05) / (y + 0.05);
    const px = parseFloat(cs.fontSize), neg = Number(cs.fontWeight) >= 700;
    const grande = px >= 24 || (px >= 18.66 && neg);
    const min = grande ? 3 : 4.5;
    if (ratio < min) { const k = el.tagName + '.' + String(el.className).split(' ').join('.') + '|' + el.textContent.trim().slice(0, 30); if (!vistos.has(k)) { vistos.add(k); out.push({ el: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : ''), texto: el.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, min, color: cs.color, fondo: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + ')' }); } }
  }
  return JSON.stringify(out);
})()`;

try {
  let url = null;
  for (let i = 0; i < 50 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${puerto}/json`)).json()).find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch { /* arrancando */ } await espera(200); }
  const sock = new WebSocket(url);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const pend = new Map();
  sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cmd("Page.enable"); await cmd("Runtime.enable");
  let total = 0, falla = 0;
  for (const [nombre, ruta, vista, accion] of ESCENAS) {
    await cmd("Emulation.setDeviceMetricsOverride", { ...vista, screenWidth: vista.width, screenHeight: vista.height });
    await cmd("Page.navigate", { url: `${base}${ruta}` });
    for (let i = 0; i < 80; i++) { await espera(250); if (await ev("(() => { const c = document.getElementById('cargando'); return Boolean(c) && c.hidden; })()")) break; }
    await espera(2200);
    if (accion) { await ev(accion); await espera(1500); }
    const malos = JSON.parse((await ev(MIDE)) || "[]");
    total++;
    if (malos.length) falla++;
    console.log(`${malos.length ? "✖" : "✔"} ${nombre}${malos.length ? `  (${malos.length})` : ""}`);
    for (const m of malos.slice(0, 8)) console.log(`     ${m.ratio}:1 < ${m.min}  ${m.el}  «${m.texto}»  ${m.color} sobre ${m.fondo}`);
  }
  console.log(`\n${falla ? `${falla} de ${total} pantallas con textos bajo AA` : `Todas las pantallas (${total}) cumplen AA en sus textos.`}`);
  sock.close();
  process.exitCode = falla ? 1 : 0;
} finally {
  try { spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ya terminó */ }
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
