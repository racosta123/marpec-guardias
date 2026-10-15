// Prueba de ACTUALIZACIÓN de la app instalada (service worker) con Chrome real y Firebase/Worker simulados.
// Parte siempre de la versión anterior ya instalada (service worker activo y en caché) y pasa a:
//   1) la versión nueva completa (actualización normal),
//   2) la página index.html ANTERIOR con el código NUEVO (mezcla en la caché del navegador),
//   3) el código ANTERIOR con la página index.html NUEVA.
// En los tres casos la app debe llegar al acceso (y, con sesión, a su pantalla) sin errores de JavaScript.
// Uso: node tests/ui/actualizacion.cdp.mjs [ref-anterior]   (por omisión restore-pre-ayuda = v14). Requiere git.
import { execSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REF = process.argv[2] || "restore-pre-ayuda";
const REPO = resolve("."); // se ejecuta desde la raíz del repo
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const PUERTO = 5300 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PUERTO}`;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✖"} ${n}${extra ? "  → " + extra : ""}`); if (!ok) fallos++; };

// ---------- versiones de prueba (en una carpeta temporal; el repo no se toca) ----------
const tmp = mkdtempSync(join(tmpdir(), "marpec-act-"));
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temporal del sistema */ } }); // también si falla al preparar
const vieja = join(tmp, "vieja"), nueva = join(tmp, "nueva"), mezcla1 = join(tmp, "pagina-vieja-codigo-nuevo"), mezcla2 = join(tmp, "codigo-viejo-pagina-nueva");
mkdirSync(vieja);
execSync(`git archive ${REF} | tar -x -C "${vieja.replace(/\\/g, "/")}"`, { cwd: REPO, stdio: "pipe", shell: true });
mkdirSync(nueva);
for (const d of ["css", "js", "fonts", "icons", "tests", "tools", "worker/src"]) cpSync(join(REPO, d), join(nueva, d), { recursive: true }); // worker/src: lo usa el Worker simulado
for (const f of readdirSync(REPO).filter((x) => /\.(html|js|webmanifest|png)$/.test(x))) copyFileSync(join(REPO, f), join(nueva, f));
cpSync(nueva, mezcla1, { recursive: true }); copyFileSync(join(vieja, "index.html"), join(mezcla1, "index.html"));
cpSync(vieja, mezcla2, { recursive: true }); copyFileSync(join(nueva, "index.html"), join(mezcla2, "index.html"));
const versionDe = (dir) => /const VERSION = "([^"]+)"/.exec(execSync(`node -e "process.stdout.write(require('fs').readFileSync('sw.js','utf8'))"`, { cwd: dir }).toString())[1];
console.log(`anterior: ${REF} (${versionDe(vieja)}) · nueva: copia de trabajo (${versionDe(nueva)})`);

let servidor = null;
async function servir(dir) {
  if (servidor) { servidor.kill(); await espera(600); }
  servidor = spawn(process.execPath, ["tools/serve.mjs", String(PUERTO), "--fake"], { cwd: dir, stdio: "ignore" });
  for (let i = 0; i < 30; i++) { try { await fetch(`${BASE}/sw.js`); return; } catch { await espera(150); } }
}

async function caso(titulo, destino) {
  const perfil = mkdtempSync(join(tmpdir(), "cdp-act-"));
  const pc = 9400 + Math.floor(Math.random() * 300);
  const proc = spawn(CHROME, [`--remote-debugging-port=${pc}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  try {
    let url = null;
    for (let i = 0; i < 100 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${pc}/json`)).json()).find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch { /* arrancando */ } await espera(200); }
    if (!url) throw new Error(`Chrome no respondió en el puerto ${pc}`);
    const sock = new WebSocket(url); await new Promise((r) => (sock.onopen = r));
    let n = 0; const pend = new Map(); const excepciones = [];
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === "Runtime.exceptionThrown") excepciones.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
    const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await cmd("Page.enable"); await cmd("Runtime.enable");
    // Errores dentro de la página (incluye promesas rechazadas sin atender, como el arranque que fallaba)
    await cmd("Page.addScriptToEvaluateOnNewDocument", { source: "window.__errs=[];addEventListener('error',(e)=>__errs.push(String(e.message||e.target?.src||'')),true);addEventListener('unhandledrejection',(e)=>__errs.push('rechazo: '+(e.reason?.message||e.reason)));" });
    const leerEstado = async () => JSON.parse(await ev(`(async () => JSON.stringify({ cargando: !document.getElementById('cargando').hidden, login: !document.getElementById('vista-login').hidden, inicio: !document.getElementById('vista-inicio').hidden, aviso: document.getElementById('login-error').hidden ? '' : document.getElementById('login-error').textContent, errs: window.__errs, cache: await caches.keys() }))()`));
    // Durante una recarga la evaluación puede fallar: se reintenta hasta tener la página nueva.
    const estado = async () => { for (let i = 0; i < 40; i++) { try { const e = await leerEstado(); if (e && typeof e === "object") return e; } catch { /* página recargando */ } await espera(250); } throw new Error("la página no respondió"); };
    const esperarArranque = async () => { const fin = Date.now() + 12000; let e; do { await espera(300); e = await estado(); } while (e.cargando && Date.now() < fin); await espera(500); return estado(); };
    const ir = async (u) => { await cmd("Page.navigate", { url: BASE + u }); return esperarArranque(); };

    // Versión anterior instalada: dos visitas (registra el service worker y queda controlando la página)
    await servir(vieja);
    await ir("/index.html?anon=1");
    await ev("navigator.serviceWorker.ready.then(() => true)");
    const previa = await ir("/index.html?anon=1");
    const vAnt = versionDe(vieja);
    check(`${titulo} · versión anterior instalada (${vAnt})`, previa.login && previa.cache.includes(vAnt) && !previa.errs.length, JSON.stringify(previa));

    // Se publica la versión del caso
    await servir(destino);
    for (const [paso, accion] of [["abrir con recarga normal", () => { cmd("Page.reload", {}); return esperarArranque(); }],
      ["recarga forzada (Ctrl+Shift+R)", () => { cmd("Page.reload", { ignoreCache: true }); return esperarArranque(); }],
      ["cerrar y abrir de nuevo", () => ir("/index.html?anon=1")]]) {
      excepciones.length = 0;
      const e = await accion();
      check(`${titulo} · ${paso}: llega al acceso sin errores`, !e.cargando && e.login && !e.errs.length && !excepciones.length && !e.aviso, JSON.stringify({ ...e, excepciones }));
    }
    // Con sesión iniciada (administrador y guardia) también arranca hasta su pantalla
    for (const rol of ["admin", "guardia"]) {
      excepciones.length = 0;
      const e = await ir(`/index.html?rol=${rol}`);
      check(`${titulo} · con sesión de ${rol}: llega a su pantalla sin errores`, !e.cargando && e.inicio && !e.errs.length && !excepciones.length, JSON.stringify({ ...e, excepciones }));
    }
  } finally {
    proc.kill(); spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    try { rmSync(perfil, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome tarda en soltarlo */ }
  }
}

try {
  await caso("1) actualización normal", nueva);
  await caso("2) página anterior + código nuevo", mezcla1);
  await caso("3) código anterior + página nueva", mezcla2);
} catch (e) { fallos++; console.log("✖ excepción:", e.message); }
finally {
  servidor?.kill();
  await espera(500);
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temporal del sistema */ }
}
console.log(fallos ? `\n${fallos} FALLO(S)` : "\nActualización: todo OK (los tres casos llegan al acceso sin errores)");
process.exit(fallos ? 1 : 0);
