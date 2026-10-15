// Prueba de la interfaz del módulo Ayuda con Chrome real (Firebase y Worker simulados: tools/serve.mjs --fake).
// Uso: node tests/ui/ayuda.cdp.mjs http://127.0.0.1:5185
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("uso: node tests/ui/ayuda.cdp.mjs <urlBase>");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9700 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "--window-size=390,844", "about:blank"], { stdio: "ignore" });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✖"} ${n}${extra ? "  → " + extra : ""}`); if (!ok) fallos++; };

try {
  let url = null;
  for (let i = 0; i < 50 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${puerto}/json`)).json()).find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch { /* arrancando */ }
    await espera(200);
  }
  const sock = new WebSocket(url);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const pend = new Map();
  const errores = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errores.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cmd("Page.enable");
  await cmd("Runtime.enable");
  // Reloj fijo a las 12:00 de Hermosillo de hoy (igual que las demás pruebas de interfaz)
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const R = Date.now.bind(Date); const h = new Date(R() - 7 * 3600e3); const off = Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate(), 12, 0) + 7 * 3600e3 - R(); const D = Date; globalThis.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(R() + off); } static now() { return R() + off; } }; })();` });
  const ir = async (u, ms = 1500) => {
    await cmd("Page.navigate", { url: `${base}${u}` });
    const fin = Date.now() + 20000;
    while (Date.now() < fin) { await espera(250); if (await ev("(() => { const c = document.getElementById('cargando'); return Boolean(c) && c.hidden; })()")) break; }
    await espera(ms);
  };
  const texto = (sel = "#contenido") => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
  const conTexto = async (re, sel = "#contenido", ms = 10000) => { const fin = Date.now() + ms; let t = ""; do { t = await texto(sel); if (re.test(t)) return t; await espera(250); } while (Date.now() < fin); return t; };
  const clic = (re, sel = "button") => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent) && !x.hidden && !x.disabled); if (b) b.click(); return Boolean(b); })()`);
  const buscarTexto = (q) => ev(`(() => { const i = document.querySelector('.ayuda-buscar'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return true; })()`);
  const preguntas = () => ev(`[...document.querySelectorAll('.ayuda-q summary')].map((s) => s.textContent)`);

  // =============================================================== ADMIN
  await ir("/index.html?rol=admin");
  const menu = await ev(`[...document.querySelectorAll('#tabs-app .tab-app')].map((b) => b.textContent.trim())`);
  check("admin: «Ayuda» es la última opción del menú lateral", menu.at(-1) === "Ayuda", menu.join(", "));
  await ev(`document.querySelector('#tabs-app [data-clave="ayuda"]').click()`);
  await conTexto(/Preguntas/);
  const qa = await preguntas();
  check("admin: ve preguntas de oficina, incluidas las exclusivas", qa.some((q) => /alta un guardia/.test(q)) && qa.some((q) => /saco un reporte/.test(q)) && !qa.some((q) => /marco mi entrada/.test(q)), `${qa.length} preguntas`);
  check("admin: las tres partes (preguntas, revisión y diagnóstico)", (await ev(`document.querySelectorAll('.ayuda-tab').length`)) === 3);
  await buscarTexto("pin bloqueado");
  const filtradas = await preguntas();
  check("búsqueda local: «pin bloqueado» filtra sin servidor", filtradas.length >= 1 && filtradas.every((q) => /PIN/i.test(q)), filtradas.join(" | "));
  await buscarTexto("desbloqueo");
  await ev(`document.querySelector('.ayuda-q summary').click()`);
  const pasos = await ev(`document.querySelectorAll('.ayuda-q[open] .ayuda-pasos li').length`);
  check("la pregunta se abre con pasos numerados", pasos >= 3, `${pasos} pasos`);
  await clic("/Ir a ese módulo/", ".ayuda-q[open] button");
  check("«Ir a ese módulo» abre Personal", /Personal/.test(await conTexto(/\+ Guardia/)) && (await ev(`document.querySelector('#tabs-app [aria-current="true"]')?.dataset.clave`)) === "personal");

  // Parte 2
  await ev(`document.querySelector('#tabs-app [data-clave="ayuda"]').click()`);
  await conTexto(/Preguntas/);
  await clic("/Ya hiciste esto/", ".ayuda-tab");
  const rev = await conTexto(/Notificaciones en este dispositivo/, "#contenido", 15000);
  const filasRev = await ev(`document.querySelectorAll('.ayuda-checks > li').length`);
  check("¿Ya hiciste esto?: las 8 verificaciones", filasRev === 8, String(filasRev));
  check("detecta el sitio SIN ubicación (Bodega Sur)", /Sin ubicación: Bodega Sur/.test(rev));
  check("el QR impreso queda como recordatorio manual", /La app no puede saberlo/.test(rev));
  check("reglas de la empresa guardadas → ✅", /✅ Reglas de la empresa/.test(rev));
  check("cada ⚠️ trae botón «Ir»", await ev(`[...document.querySelectorAll('.ayuda-check.mal')].every((li) => li.querySelector('button'))`));
  await ev("window.__offline = true");
  await clic("/Revisar de nuevo/");
  check("sin conexión: «Sin conexión: datos no actuales»", /Sin conexión: datos no actuales/.test(await conTexto(/Sin conexión: datos no actuales/)));
  await ev("window.__offline = false");

  // Parte 3
  await clic("/Por qué no puede marcar/", ".ayuda-tab");
  await conTexto(/Elige al guardia/);
  const opciones = await ev(`[...document.querySelectorAll('.ayuda-diag')].length + ':' + [...document.querySelector('#contenido select').options].map((o) => o.textContent).join('|')`);
  check("lista de guardias (incluye bajas) sin PIN ni hashes", /Beto Baja/.test(opciones) && !/pin|hash/i.test(opciones), opciones);
  const elegir = (uid) => ev(`(() => { const s = document.querySelector('#contenido select'); s.value = ${JSON.stringify(uid)}; s.dispatchEvent(new Event('change')); return true; })()`);
  await elegir("g-G003");
  check("guardia de baja → «Causa probable: Está dado de baja»", /Causa probable: Está dado de baja/.test(await conTexto(/Causa probable|No encontramos/)));
  await elegir("g-G001");
  const g1 = await conTexto(/Tiene turno|Sin turno hoy/);
  check("guardia con turno hoy: revisa turno, ventana y sitio", /Tiene turno/.test(g1) && /ventana de entrada/i.test(g1) && /Sitio con ubicación/.test(g1), g1.slice(0, 200));
  check("el PIN bloqueado se explica, no se consulta", /PIN bloqueado\?/.test(g1) && /No se puede ver desde aquí/.test(g1));
  const html = await ev(`document.getElementById('contenido').innerHTML`);
  check("nada de PIN, hash ni secretos en pantalla", !/pinHash|hash|secreto/i.test(html.replace(/hashes/g, "")));

  // =============================================================== SUPERVISOR
  await ir("/index.html?rol=supervisor");
  const menuS = await ev(`[...document.querySelectorAll('#tabs-app .tab-app')].map((b) => b.textContent.trim())`);
  check("supervisor: «Ayuda» al final de su menú", menuS.at(-1) === "Ayuda");
  await ev(`document.querySelector('#tabs-app [data-clave="ayuda"]').click()`);
  await conTexto(/Preguntas/);
  const qs = await preguntas();
  check("supervisor: NO ve las exclusivas de administrador", !qs.some((q) => /alta un guardia|alta un supervisor|saco un reporte|desbloqueo el PIN/.test(q)) && qs.some((q) => /asigno el turno/.test(q)), `${qs.length} preguntas`);
  await buscarTexto("PIN bloqueado");
  await ev(`document.querySelector('.ayuda-q summary').click()`);
  check("supervisor: sin botón a Personal (no es su módulo)", (await ev(`document.querySelectorAll('.ayuda-q[open] button').length`)) === 0);
  await clic("/Ya hiciste esto/", ".ayuda-tab");
  const revS = await conTexto(/Notificaciones en este dispositivo/, "#contenido", 15000);
  check("supervisor: solo sus sitios (no ve Bodega Sur, de otro supervisor)", !/Bodega Sur/.test(revS) && /en tus sitios/.test(revS));
  check("supervisor: reglas de la empresa como información (no las lee)", /ℹ️ Reglas de la empresa/.test(revS));
  check("supervisor: «¿Ya hiciste esto?» no muestra guardias de otro supervisor (Gema, de Bodega Sur)", !/Gema/.test(revS));
  await clic("/Por qué no puede marcar/", ".ayuda-tab");
  await conTexto(/Elige al guardia/);
  const opS = await ev(`[...document.querySelector("#contenido select").options].map((o) => o.textContent).join("|")`);
  check("supervisor: «¿Por qué no puede marcar?» solo lista guardias con turnos en SUS sitios", /Gael/.test(opS) && !/Gema|Beto/.test(opS), opS);
  // Respuestas fuera de orden: el último guardia elegido es el que se ve
  await ev(`(() => { const s = document.querySelector("#contenido select"); s.value = "g-G001"; s.dispatchEvent(new Event("change")); s.value = ""; s.dispatchEvent(new Event("change")); return true; })()`);
  await espera(1500);
  check("elegir otro guardia descarta el diagnóstico anterior (sin pintarlo encima)", !/Tiene turno|Causa probable|No encontramos/.test(await texto(".ayuda-diag")));
  const htmlS = await ev("document.getElementById(\"contenido\").innerHTML");
  check("supervisor: nada de Bodega Sur ni de sus guardias en pantalla", !/Bodega Sur|Gema/.test(htmlS));

  // =============================================================== GUARDIA
  await ir("/index.html?rol=guardia");
  check("guardia: botón «Ayuda» en su barra", (await ev(`!document.getElementById('btn-ayuda').hidden`)) === true);
  await ev(`document.getElementById('btn-ayuda').click()`);
  await conTexto(/Mi turno/);
  const qg = await preguntas();
  check("guardia: solo preguntas de guardia", qg.some((q) => /marco mi entrada/.test(q)) && !qg.some((q) => /alta un guardia|asigno el turno/.test(q)), `${qg.length} preguntas`);
  check("guardia: sin las partes de revisión ni diagnóstico", (await ev(`document.querySelectorAll('.ayuda-tab').length`)) === 0);
  check("guardia: el botón de pánico sigue visible en la Ayuda", (await ev(`!!document.getElementById('btn-panico')`)) === true);
  await ev(`document.querySelector('.ayuda-q summary').click()`);
  await clic("/Ir a ese módulo/", ".ayuda-q[open] button");
  check("guardia: «Ir a ese módulo» regresa a su turno", /MARCAR ENTRADA|Turno actual|No tienes turnos/.test(await conTexto(/MARCAR ENTRADA|Turno actual|No tienes turnos/)));

  check("sin errores de JavaScript", errores.length === 0, errores.slice(0, 3).join(" | "));
} catch (e) {
  fallos++;
  console.log("✖ excepción:", e.message);
} finally {
  proc.kill();
  spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
}
console.log(fallos ? `\n${fallos} FALLO(S)` : "\nAyuda: todo OK");
process.exit(fallos ? 1 : 0);
