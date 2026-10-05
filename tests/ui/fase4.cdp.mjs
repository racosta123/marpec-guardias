// Prueba de la interfaz de la Fase 4 (rondines) con Chrome real: cámara y GPS simulados por Chrome.
// Uso: node tests/ui/fase4.cdp.mjs http://localhost:5182   (servidor: node tools/serve.mjs 5182 --fake)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("uso: node tests/ui/fase4.cdp.mjs <urlBase>");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9700 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "about:blank"], { stdio: "ignore" });
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
  await cmd("Browser.grantPermissions", { permissions: ["geolocation", "videoCapture"], origin: new URL(base).origin });
  const ir = async (u, ms = 3500) => { await cmd("Page.navigate", { url: `${base}${u}` }); await espera(ms); };
  const texto = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
  // Espera (hasta ms) a que el texto de `sel` cumpla `re`; devuelve el último texto
  const conTexto = async (sel, re, ms = 8000) => { const fin = Date.now() + ms; let t = ""; do { t = await texto(sel); if (re.test(t)) return t; await espera(250); } while (Date.now() < fin); return t; };
  const clic = (re, sel = "button") => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent) && !x.hidden && !x.disabled); if (b) b.click(); return Boolean(b); })()`);

  // BarcodeDetector simulado: devuelve lo que ponga el test en window.__qr
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `window.__qr = null; window.BarcodeDetector = class { constructor() {} async detect() { return window.__qr ? [{ rawValue: window.__qr }] : []; } };` });
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 8 });

  // ---------------- GUARDIA ----------------
  await ir("/index.html?rol=guardia&entrada=1");
  const home = await texto("#contenido");
  check("guardia con entrada: ve la tarjeta de Rondines con su progreso", /Rondines/i.test(home) && /0 de 3 puntos/.test(home), home.replace(/\n+/g, " ").slice(0, 120));
  check("guardia: botón «INICIAR RONDÍN»", /INICIAR RONDÍN/i.test(home));
  await clic("/INICIAR RONDÍN/i");
  const esc = await conTexto(".marcar-caja", /Ruta ordenada/i);
  check("rondín: pantalla de escaneo con barra de progreso y lista de puntos", /Escanea los puntos/i.test(esc) && /Portón/.test(esc) && (await ev("!!document.querySelector('progress.progreso')")) === true);
  check("ruta ordenada: indica cuál es el siguiente punto", /escanea «Portón»/i.test(esc), esc.replace(/\n+/g, " ").slice(0, 160));
  await ev("window.__qr = 'MPC2.p3.1.CCCCCCCCCCCCCCCCCCCCCC'"); // fuera de orden (el 3.º)
  await espera(300);
  check("fuera de orden: avisa en pantalla y no abre el punto", /ruta es ordenada/i.test(await conTexto(".marcar-estado", /ruta es ordenada/i)) && !/Registrar punto/i.test(await texto(".marcar-caja")));
  await ev("window.__qr = 'MPC1.siteA.1.AAAAAAAAAAAAAAAAAAAAAA'"); // QR de asistencia
  check("QR de asistencia: «no es un punto de control MARPEC»", /no es un punto de control/i.test(await conTexto(".marcar-estado", /no es un punto de control/i)));
  await ev("window.__qr = 'MPC2.p1.1.AAAAAAAAAAAAAAAAAAAAAA'");
  const punto = await conTexto(".marcar-caja", /Ubicación capturada/i);
  check("punto en orden: pide GPS (el punto lo requiere), nota y foto opcionales", /Portón/i.test(punto) && /Ubicación capturada/i.test(punto) && /Nota/i.test(punto) && /foto \(opcional\)/i.test(punto), punto.replace(/\n+/g, " ").slice(0, 160));
  await ev("document.querySelector('.marcar-caja textarea').value = 'Candado flojo'");
  await clic("/Agregar foto/i");
  await conTexto(".marcar-caja", /Tomar foto/i);
  await espera(1200);
  await clic("/Tomar foto/i");
  await espera(1500);
  check("foto opcional: vista previa tomada con la cámara en vivo", (await ev("!!document.querySelector('.marcar-prev')")) === true);
  await ev("window.__llamadas.length = 0");
  await clic("/Registrar punto/i");
  await ev("window.__qr = null"); // el detector simulado deja de ver el QR
  await espera(2500);
  const env1 = JSON.parse(await ev("JSON.stringify(window.__llamadas.find((l) => l.ruta === '/rondines/escanear') || null)"));
  check("registro: POST /rondines/escanear con QR, GPS, nota y foto JPEG", Boolean(env1) && env1.body.qr === "MPC2.p1.1.AAAAAAAAAAAAAAAAAAAAAA" && Math.abs(env1.body.lat - 29.0729) < 0.001 && env1.body.nota === "Candado flojo" && Buffer.from(env1.body.foto, "base64")[0] === 0xff && typeof env1.body.horaDispositivoMs === "number");
  await espera(1500);
  const prog = await ev("(() => { const p = document.querySelector('.marcar-caja progress.progreso'); return p ? p.value + '/' + p.max : null; })()");
  check("barra de progreso: 1 de 3 y el siguiente es «Bodega»", prog === "1/3" && /Bodega/.test(await texto(".marcar-estado")), `${prog} ${(await texto(".marcar-estado")).slice(0, 60)}`);
  await ev("window.__qr = 'MPC2.p1.1.AAAAAAAAAAAAAAAAAAAAAA'");
  await ev("window.__qr = 'MPC2.p1.1.AAAAAAAAAAAAAAAAAAAAAA'");
  check("punto repetido: avisa «ya registraste»", /ya registraste/i.test(await conTexto(".marcar-estado", /ya registraste/i)));
  await ev("window.__qr = 'MPC2.p2.1.BBBBBBBBBBBBBBBBBBBBBB'");
  check("punto sin GPS: no pide ubicación", /no requiere GPS/i.test(await conTexto(".marcar-caja", /no requiere GPS/i)));
  await clic("/Registrar punto/i");
  await espera(1500);
  await ev("window.__qr = 'MPC2.p3.1.CCCCCCCCCCCCCCCCCCCCCC'");
  await conTexto(".marcar-caja", /Registrar punto/i);
  await clic("/Registrar punto/i");
  check("último punto: «¡Rondín completo!»", /Rondín completo/i.test(await conTexto(".marcar-caja", /Rondín completo/i)));
  await clic("/Listo/i");
  await espera(800);

  // ---------------- SUPERVISOR ----------------
  await ir("/index.html?rol=supervisor");
  const tabs = await ev("[...document.querySelectorAll('.tab-app')].map((b) => b.textContent).join(',')");
  check("supervisor: pestaña Rondines", /Rondines/.test(tabs), tabs);
  await ev("document.querySelector('[data-clave=rondines]').click()");
  await espera(1200);
  const panel = await texto("#contenido");
  check("panel: alertas de rondín no iniciado e incompleto con punto saltado", /Alertas de rondines/i.test(panel) && /no iniciado/i.test(panel) && /saltado/i.test(panel) && /Bodega/.test(panel));
  check("panel: cumplimiento del día en % por sitio", /Cumplimiento del día/i.test(panel) && /33.3%/.test(panel), panel.replace(/\n+/g, " ").match(/Cumplimiento del día.{0,80}/i)?.[0]);
  check("panel: detalle con la hora de cada punto y la nota", /Portón/.test(panel) && /\d{2}:\d{2}/.test(panel) && /Candado flojo/.test(panel));
  check("panel: botón de foto del punto", (await ev("[...document.querySelectorAll('button')].some((b) => /^Foto$/.test(b.textContent))")) === true);
  await clic("/^Marcar realizado$/");
  await espera(300);
  await ev("window.__llamadas.length = 0; document.querySelector('.modal textarea').value = 'QR dañado, verificado en sitio.'; document.querySelector('.modal form').requestSubmit()");
  await espera(700);
  const aj = JSON.parse(await ev("JSON.stringify(window.__llamadas.find((l) => l.ruta === '/rondines/ajuste') || null)"));
  check("ajuste de punto: envía rondín, punto y motivo", Boolean(aj) && aj.body.tipo === "marcar_punto" && aj.body.puntoId === "p2" && /dañado/.test(aj.body.motivo));
  const csv = await ev(`(async () => { const m = await import('/js/vistas/rondines.js'); return m.rondinesACsv([{ fecha: '2026-10-05', sitioNombre: '=cmd|"x"', guardiaNombre: 'Gael, "G"', programadoMs: 1790000000000, estado: 'incompleto', iniciadoMs: 1790000100000, finalizadoMs: null, hechos: 1, total: 3, porcentaje: 33, faltantes: [{ nombre: '@Bodega' }], detalle: [{ nombre: 'Portón', hecho: true, tsMs: 1790000100000 }, { nombre: '+Azotea', hecho: false }] }]); })()`);
  check("CSV de rondines: con BOM, escapa comas/comillas y neutraliza =, @ y +", csv.startsWith("\ufeff") && /'=cmd/.test(csv) && /"Gael, ""G"""/.test(csv) && /'@Bodega/.test(csv) && /faltó/.test(csv));

  // ---------------- ADMIN: puntos y programación ----------------
  await ir("/index.html?rol=admin");
  await ev("document.querySelector('[data-clave=sitios]').click()");
  await espera(800);
  await ev("[...document.querySelectorAll('.item')].filter((i) => /Plaza Norte/.test(i.innerText)).at(-1).querySelectorAll('button').forEach((b) => /Puntos y rondín/.test(b.textContent) && b.click())");
  const ptos = await conTexto("#contenido", /Programación/i);
  if (!/Programación/i.test(ptos)) console.log("  DBG errores:", JSON.stringify(errores.slice(-3)).slice(0, 400));
  check("sitio: lista de puntos con orden y programación", /Programación/i.test(ptos) && /1\. Portón/.test(ptos) && /2\. Bodega/.test(ptos) && /Ruta ordenada/i.test(ptos) && /cada 2 h/i.test(ptos), ptos.replace(/\n+/g, " ").slice(0, 160));
  check("sitio: botones de QR por punto, regenerar y hoja imprimible", (await ev("[...document.querySelectorAll('button')].some((b) => /Hoja de QR/.test(b.textContent)) && [...document.querySelectorAll('button')].filter((b) => /^QR$/.test(b.textContent)).length >= 2 && [...document.querySelectorAll('button')].some((b) => /Regenerar QR/.test(b.textContent))")) === true);
  check("punto inactivo marcado como tal", /Inactivo/.test(ptos));
  await clic("/\\+ Punto/");
  await espera(300);
  const formP = await texto(".modal");
  check("nuevo punto: GPS opcional con «Usar mi ubicación actual» y radio 30 m", /Usar mi ubicación actual/i.test(formP) && (await ev("document.querySelector('.modal input[type=number]').value")) === "30");
  await ev("window.__llamadas.length = 0; const f = document.querySelector('.modal form'); f.querySelector('input[type=text]').value = 'Estacionamiento'; f.requestSubmit()");
  await espera(700);
  const np = JSON.parse(await ev("JSON.stringify(window.__llamadas.find((l) => l.ruta === '/admin/puntos') || null)"));
  check("nuevo punto: se envía con sitio, nombre y radio 30", Boolean(np) && np.body.sitioId === "siteA" && np.body.nombre === "Estacionamiento" && np.body.radioM === 30);
  await clic("/Cambiar programación/");
  await espera(300);
  const formG = await texto(".modal");
  check("programación: modo, frecuencia (cada X h u horarios fijos) y tolerancias", /Modo/i.test(formG) && /Frecuencia/i.test(formG) && /Tolerancia para empezar/i.test(formG) && /Plazo para terminar/i.test(formG));
  await ev("window.__llamadas.length = 0; document.querySelector('.modal form').requestSubmit()");
  await espera(700);
  const pg = JSON.parse(await ev("JSON.stringify(window.__llamadas.find((l) => l.ruta === '/rondines/programa') || null)"));
  check("programación: se envía validable por el Worker", Boolean(pg) && pg.body.modo === "ordenada" && pg.body.frecuencia.tipo === "cada_horas" && pg.body.toleranciaInicioMin === 15 && pg.body.toleranciaFinMin === 45);

  // ---------------- Hoja imprimible de QR ----------------
  await ir("/punto-qr.html?sitio=siteA", 2500);
  const hoja = await ev("JSON.stringify({ tarjetas: document.querySelectorAll('.punto-tarjeta').length, svgs: document.querySelectorAll('.punto-qr svg').length, logos: document.querySelectorAll('.punto-logo').length, texto: document.getElementById('hoja').innerText })");
  const hj = JSON.parse(hoja);
  check("hoja imprimible: una tarjeta por punto con logo, nombre del punto y su QR", hj.tarjetas === 2 && hj.svgs === 2 && hj.logos === 2 && /Portón/i.test(hj.texto) && /Bodega/i.test(hj.texto) && /Plaza Norte/i.test(hj.texto), `${hj.tarjetas} tarjetas`);

  check("sin excepciones de JavaScript durante toda la prueba", errores.length === 0, errores.slice(0, 2).join(" | "));
  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS DE INTERFAZ (FASE 4) PASARON");
  sock.close();
  process.exitCode = fallos ? 1 : 0;
} finally {
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
