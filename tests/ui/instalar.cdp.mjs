// Prueba del botón de instalación con Chrome real (CDP, sin dependencias; Node >= 22).
// Uso: node tests/ui/instalar.cdp.mjs <urlLogin> <urlInicioSimulado>
//   <urlLogin>: la app (pantalla de login). <urlInicioSimulado>: servida con tools/serve.mjs --fake (?rol=guardia).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [urlLogin, urlInicio] = process.argv.slice(2);
if (!urlLogin || !urlInicio) throw new Error("uso: node tests/ui/instalar.cdp.mjs <urlLogin> <urlInicioSimulado>");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9800 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✖"} ${n}${extra ? "  → " + extra : ""}`); if (!ok) fallos++; };

async function ws() {
  for (let i = 0; i < 50; i++) {
    try { const p = (await (await fetch(`http://127.0.0.1:${puerto}/json`)).json()).find((x) => x.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch { /* arrancando */ }
    await espera(200);
  }
  throw new Error("Chrome no arrancó");
}

try {
  const sock = new WebSocket(await ws());
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const pend = new Map();
  sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cmd("Page.enable");
  const ir = async (url, ms = 7000) => { await cmd("Page.navigate", { url }); await espera(ms); };

  const inyectar = async (src) => (await cmd("Page.addScriptToEvaluateOnNewDocument", { source: src })).result.identifier;
  const quitar = (id) => cmd("Page.removeScriptToEvaluateOnNewDocument", { identifier: id });
  // Simula display-mode: standalone (la app ya instalada)
  const SIM_STANDALONE = "const mm = window.matchMedia.bind(window); window.matchMedia = (q) => /display-mode:\\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q);";
  // Safari iOS no dispara beforeinstallprompt: se bloquea el evento natural de Chrome
  const SIN_EVENTO = "window.addEventListener('beforeinstallprompt', (e) => e.stopImmediatePropagation(), true);";

  // Estado visible del bloque de instalación que corresponde a la vista activa
  const estado = `(() => {
    const vis = [...document.querySelectorAll('[data-instalar]')].filter((c) => !c.hidden && c.offsetParent !== null);
    return JSON.stringify({ visibles: vis.length, texto: vis.map((c) => c.innerText.trim()).join(' | '), boton: !!vis[0]?.querySelector('button.instalar-btn') });
  })()`;
  const dispararEvento = `(() => { window.__prompts = 0; const e = new Event('beforeinstallprompt'); e.prompt = async () => { window.__prompts++; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); return true; })()`;

  // A) Escritorio/Android: con evento → botón; al tocar → prompt nativo; aceptar → se oculta
  await ir(urlLogin);
  const sinEvento = JSON.parse(await ev(estado));
  await ev(dispararEvento);
  await espera(300);
  const conEvento = JSON.parse(await ev(estado));
  check("login: con beforeinstallprompt aparece el botón «Instalar app»", conEvento.visibles === 1 && conEvento.boton && /instalar app/i.test(conEvento.texto), JSON.stringify(conEvento) + " login.hidden=" + (await ev("document.getElementById('vista-login').hidden")) + " cargando.hidden=" + (await ev("document.getElementById('cargando').hidden")));
  console.log(`  (Chrome real ${sinEvento.boton ? "SÍ" : "no"} disparó beforeinstallprompt por sí mismo antes de simularlo)`);
  await ev("document.querySelector('[data-instalar] button.instalar-btn').click()");
  await espera(400);
  check("tocar el botón lanza el diálogo nativo (prompt() invocado una vez)", (await ev("window.__prompts")) === 1);
  check("al aceptar, el botón se oculta", JSON.parse(await ev(estado)).visibles === 0);

  // B) appinstalled oculta
  await ir(urlLogin);
  await ev(dispararEvento);
  await espera(200);
  await ev("window.dispatchEvent(new Event('appinstalled'))");
  await espera(200);
  check("evento appinstalled oculta el botón", JSON.parse(await ev(estado)).visibles === 0);

  // C) Ya instalada (display-mode: standalone): no se muestra aunque llegue el evento
  let idS = await inyectar(SIM_STANDALONE);
  await ir(urlLogin);
  await ev(dispararEvento);
  await espera(300);
  check("en modo standalone (app instalada) no se muestra el botón", JSON.parse(await ev(estado)).visibles === 0);
  await quitar(idS);

  // D) iPhone: instrucciones, sin botón; se pueden ocultar 24 h
  await cmd("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1" });
  const idNo = await inyectar(SIN_EVENTO);
  await ev("localStorage.clear()");
  await ir(urlLogin);
  const ios = JSON.parse(await ev(estado));
  check("iPhone: muestra instrucciones «Compartir → Agregar a pantalla de inicio»", ios.visibles === 1 && !ios.boton && /Compartir/.test(ios.texto) && /Agregar a pantalla de inicio/.test(ios.texto), ios.texto);
  await ev("document.querySelector('[data-instalar] .btn-icono').click()");
  await espera(200);
  check("iPhone: ✕ oculta las instrucciones", JSON.parse(await ev(estado)).visibles === 0);
  await ir(urlLogin);
  check("iPhone: sigue oculto tras recargar (24 h)", JSON.parse(await ev(estado)).visibles === 0);
  idS = await inyectar(SIM_STANDALONE);
  await ev("localStorage.clear()");
  await ir(urlLogin);
  check("iPhone en modo standalone (agregada a inicio): no muestra instrucciones", JSON.parse(await ev(estado)).visibles === 0);
  await quitar(idS);
  await quitar(idNo);
  await cmd("Emulation.setUserAgentOverride", { userAgent: "" });

  // E) Pantalla de inicio (con sesión simulada): también aparece
  await ir(urlInicio, 3000);
  const enInicio = await ev("!document.getElementById('vista-inicio').hidden");
  await ev(dispararEvento);
  await espera(300);
  const ini = JSON.parse(await ev(estado));
  check("inicio: con sesión se muestra el botón en la pantalla de inicio", enInicio === true && ini.visibles === 1 && ini.boton, ini.texto);

  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS DEL BOTÓN DE INSTALACIÓN PASARON");
  sock.close();
  process.exitCode = fallos ? 1 : 0;
} finally {
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
