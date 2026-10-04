// Auditoría de instalabilidad con el MOTOR de Chrome (CDP: Page.getInstallabilityErrors + getAppManifest),
// sin dependencias: lanza Chrome headless y habla CDP por WebSocket (Node >= 22).
// Uso: node tools/auditar-instalabilidad.mjs <url>   (p. ej. https://racosta123.github.io/marpec-guardias/)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
if (!url) throw new Error("falta la URL");
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(existsSync);
if (!CHROME) throw new Error("no se encontró Chrome/Edge");

const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function conectar() {
  for (let i = 0; i < 50; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${puerto}/json`)).json();
      const pag = t.find((x) => x.type === "page");
      if (pag) return pag.webSocketDebuggerUrl;
    } catch { /* aún arrancando */ }
    await espera(200);
  }
  throw new Error("Chrome no arrancó");
}

try {
  const ws = new WebSocket(await conectar());
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

  await cmd("Page.enable");
  await cmd("Page.navigate", { url });
  await espera(10000); // carga + registro del service worker
  const m = await cmd("Page.getAppManifest");
  const errs = await cmd("Page.getInstallabilityErrors");
  const r = m.result || {};
  console.log(`URL: ${url}`);
  console.log(`Manifest: ${r.url}`);
  console.log("Errores del manifest:", (r.errors || []).map((e) => e.message));
  let man = {};
  try { man = JSON.parse(r.data || "{}"); } catch { /* sin manifest */ }
  console.log(`id=${man.id} start_url=${man.start_url} scope=${man.scope} display=${man.display}`);
  console.log("iconos:", (man.icons || []).map((i) => `${i.sizes} ${i.purpose || "any"} ${i.src}`));
  // Comprobaciones dentro de la página: service worker, scope/start_url resueltos e íconos (200 y tamaño real)
  const js = `(async () => {
    const m = await (await fetch(document.querySelector('link[rel=manifest]').href)).json();
    const base = new URL(document.querySelector('link[rel=manifest]').href);
    const start = new URL(m.start_url, base), scope = new URL(m.scope, base), id = new URL(m.id, start);
    await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 12000))]);
    const reg = (await navigator.serviceWorker.getRegistrations())[0];
    const claves = await caches.keys();
    const enCache = claves.length ? (await (await caches.open(claves[0])).keys()).length : 0;
    const iconos = [];
    for (const i of m.icons) {
      const r = await fetch(new URL(i.src, base));
      const bmp = await createImageBitmap(await r.blob());
      iconos.push({ src: i.src, http: r.status, real: bmp.width + 'x' + bmp.height, declarado: i.sizes, purpose: i.purpose });
    }
    return JSON.stringify({ start: start.href, scope: scope.href, id: id.href, dentroDelScope: start.href.startsWith(scope.href),
      sw: reg ? { scope: reg.scope, estado: (reg.active || reg.waiting || reg.installing)?.state, caches: claves, archivosEnCache: enCache } : null, iconos });
  })()`;
  const ev = await cmd("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
  const info = JSON.parse(ev.result?.result?.value || "{}");
  console.log("start_url resuelto:", info.start, "\
scope resuelto:", info.scope, "\
id resuelto:", info.id, "\
start_url dentro del scope:", info.dentroDelScope);
  console.log("service worker:", JSON.stringify(info.sw));
  for (const i of info.iconos || []) console.log(` icono ${i.src}: HTTP ${i.http}, real ${i.real}, declarado ${i.declarado}, ${i.purpose}`);
  const lista = (errs.result?.installabilityErrors || []);
  console.log(lista.length ? `INSTALABILIDAD: ${lista.length} problema(s)` : "INSTALABILIDAD: SIN PROBLEMAS (Chrome la considera instalable)");
  for (const e of lista) console.log(` ✖ ${e.errorId} ${JSON.stringify(e.errorArguments)}`);
  ws.close();
  process.exitCode = lista.length ? 1 : 0;
} finally {
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
