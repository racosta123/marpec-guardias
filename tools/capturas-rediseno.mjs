// Capturas de pantalla del rediseño (Chrome real por CDP, sin dependencias) contra la app con Firebase/Worker SIMULADOS.
// Uso: node tools/serve.mjs 5182 --fake   y luego   node tools/capturas-rediseno.mjs http://localhost:5182 [escena ...]
// Salida: .tools/capturas-rediseno/<escena>.png  (celular 360 px a 2x y escritorio 1440 px)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("uso: node tools/capturas-rediseno.mjs <urlBase> [escena ...]");
const CEL = { width: 360, height: 780, deviceScaleFactor: 2, mobile: true };
const PC = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
// escena → [archivo, url, vista, esperaMs, acciones(JS) opcional]
const ESCENAS = {
  "guardia-en-turno-360": ["/index.html?rol=guardia&entrada=1&hace=4.1", CEL],
  "guardia-sin-marcar-360": ["/index.html?rol=guardia", CEL],
  "guardia-320": ["/index.html?rol=guardia&entrada=1&hace=4.1", { ...CEL, width: 320 }],
  "vivo-escritorio-1440": ["/index.html?rol=admin&demo=vivo", PC],
  "vivo-escritorio-sin-panico-1440": ["/index.html?rol=admin&demo=vivo&sinpanico=1", PC],
  "vivo-celular-sin-panico-360": ["/index.html?rol=admin&demo=vivo&sinpanico=1", CEL],
  "vivo-celular-360":["/index.html?rol=admin&demo=vivo", CEL],
  "vivo-celular-menu-360": ["/index.html?rol=admin&demo=vivo", CEL, "document.getElementById('btn-menu').click()"],
  "vivo-tablet-768": ["/index.html?rol=supervisor&demo=vivo", { width: 768, height: 1024, deviceScaleFactor: 1, mobile: false }],
};
// Todas las secciones del admin (escritorio y celular): escena «sec-<clave>-1440» y «sec-<clave>-360»
const CLAVES = ["vivo", "asistencia", "rondines", "incidencias", "visitantes", "bitacoras", "offline", "alertas", "turnos", "sitios", "personal", "reportes", "empresa", "bitacora"];
for (const k of CLAVES) for (const [suf, vista] of [["1440", PC], ["360", CEL]]) ESCENAS[`sec-${k}-${suf}`] = ["/index.html?rol=admin", vista, `document.querySelector('[data-clave=${k}]').click()`];
const LIBRO = (re) => `[...document.querySelectorAll('.libro-btn')].find((b) => ${re}.test(b.textContent)).click()`;
// Otras pantallas (login, licencia, documentos y flujos del guardia)
Object.assign(ESCENAS, {
  "login-360": ["/index.html?rol=ninguno", CEL], "login-1440": ["/index.html?rol=ninguno", PC],
  "demo-vencida-360": ["/index.html?rol=guardia&lic=vencida", CEL], "demo-vencida-1440": ["/index.html?rol=admin&lic=vencida", PC],
  "banner-licencia-1440": ["/index.html?rol=admin&lic=d5", PC], "banner-licencia-360": ["/index.html?rol=supervisor&lic=d5", CEL],
  "aviso-visitantes-1440": ["/aviso-visitantes.html", PC],
  "privacidad-360":["/privacidad.html", CEL], "privacidad-1440": ["/privacidad.html", PC],
  "marcar-intro-360": ["/index.html?rol=guardia", CEL, "document.querySelector('.btn.grande').click()"],
  "libro-novedad-360": ["/index.html?rol=guardia&entrada=1&hace=4.1", CEL, LIBRO(/Novedad/)],
  "libro-incidencia-360": ["/index.html?rol=guardia&entrada=1&hace=4.1", CEL, LIBRO(/incidencia/i)],
  "libro-visitantes-360": ["/index.html?rol=guardia&entrada=1&hace=4.1", CEL, LIBRO(/Visitantes/)],
  "libro-bitacora-360": ["/index.html?rol=guardia&entrada=1&hace=4.1", CEL, LIBRO(/Bitácora/)],
  "rondin-360": ["/index.html?rol=guardia&entrada=1&hace=4.1", CEL, "[...document.querySelectorAll('button')].find((b) => /INICIAR RONDÍN/.test(b.textContent)).click()"],
  "sin-conexion-360": ["/index.html?rol=guardia&entrada=1&hace=4.1&offline=1", CEL],
});
const pedidas = process.argv.slice(3);
const lista = Object.entries(ESCENAS).filter(([n]) => !pedidas.length || pedidas.includes(n));

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cap-"));
const puerto = 9700 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const out = ".tools/capturas-rediseno";
mkdirSync(out, { recursive: true });

try {
  let url = null;
  for (let i = 0; i < 50 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${puerto}/json`)).json()).find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch { /* arrancando */ } await espera(200); }
  const sock = new WebSocket(url);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const pend = new Map();
  const errores = [];
  sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === "Runtime.exceptionThrown") errores.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cmd("Page.enable"); await cmd("Runtime.enable");
  // Reloj fijado a las 10:24 (Hermosillo) de HOY, como en la imagen de referencia
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const R = Date.now.bind(Date); const h = new Date(R() - 7 * 3600e3); const off = Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate(), 10, 24) + 7 * 3600e3 - R(); const D = Date; globalThis.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(R() + off); } static now() { return R() + off; } }; })();` });
  for (const [nombre, [ruta, vista, accion]] of lista) {
    await cmd("Emulation.setDeviceMetricsOverride", { ...vista, screenWidth: vista.width, screenHeight: vista.height });
    await cmd("Emulation.setTouchEmulationEnabled", { enabled: vista.mobile });
    await cmd("Page.navigate", { url: `${base}${ruta}` });
    for (let i = 0; i < 80; i++) { await espera(250); if (await ev("(() => { const c = document.getElementById('cargando'); return Boolean(c) && c.hidden; })()")) break; }
    await espera(2500);
    if (accion) { await ev(accion); await espera(1500); }
    const alto = await ev("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)");
    const completa = nombre.includes("menu") ? false : true;
    const r = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: completa, clip: completa ? { x: 0, y: 0, width: vista.width, height: Math.min(alto || vista.height, 3000), scale: 1 } : undefined });
    writeFileSync(join(out, `${nombre}.png`), Buffer.from(r.result.data, "base64"));
    const r2 = await cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${nombre}-pantalla.png`), Buffer.from(r2.result.data, "base64"));
    const desborde = await ev("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1");
    console.log(`${nombre}.png  (${vista.width}x${alto})${desborde ? "  ⚠ DESBORDE HORIZONTAL" : ""}`);
    if (desborde) {
      // quién se sale: elementos cuyo borde derecho pasa del ancho, ignorando los que viven dentro de un contenedor con scroll propio
      const quien = await ev(`[...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > ${vista.width} + 1; }).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).slice(0, 6).map((e) => e.tagName.toLowerCase() + '.' + String(e.className.baseVal ?? e.className).split(' ').join('.') + '#' + e.id + ' → ' + Math.round(e.getBoundingClientRect().right)).join(' | ')`);
      console.log(`    se sale: ${quien}`);
    }
  }
  if (errores.length) console.log("Excepciones de JavaScript:", errores.slice(0, 3).join(" | "));
  sock.close();
} finally {
  try { spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ya terminó */ }
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
