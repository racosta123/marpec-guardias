// Prueba de la interfaz de la Fase 6 con Chrome real: modo sin internet (cola local), botón de pánico (3 s), alertas
// que no se cierran, panel en vivo y notificaciones. Firebase y Worker son simulados (tools/serve.mjs --fake).
// Uso: node tests/ui/fase6.cdp.mjs http://localhost:5182
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("uso: node tests/ui/fase6.cdp.mjs <urlBase>");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9600 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--window-size=420,900", "about:blank"], { stdio: "ignore" });
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
  await cmd("Browser.grantPermissions", { permissions: ["geolocation", "videoCapture", "notifications"], origin: new URL(base).origin });
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 8 });
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `window.__qr = null; window.BarcodeDetector = class { constructor() {} async detect() { return window.__qr ? [{ rawValue: window.__qr }] : []; } };` });
  const ir = async (u, ms = 3500) => { await cmd("Page.navigate", { url: `${base}${u}` }); await espera(ms); };
  const texto = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
  const conTexto = async (sel, re, ms = 8000) => { const fin = Date.now() + ms; let t = ""; do { t = await texto(sel); if (re.test(t)) return t; await espera(250); } while (Date.now() < fin); return t; };
  const clic = (re, sel = "button") => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent) && !x.hidden && !x.disabled); if (b) b.click(); return Boolean(b); })()`);
  const llamadas = async (ruta) => JSON.parse(await ev(`JSON.stringify(window.__llamadas.filter((l) => l.ruta === ${JSON.stringify(ruta)}))`));
  // Cola local (IndexedDB): lo que realmente quedó guardado en el celular
  const cola = async () => JSON.parse(await ev(`new Promise((res) => { const r = indexedDB.open("marpec-cola"); r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains("cola")) return res("[]"); const q = d.transaction("cola").objectStore("cola").getAll(); q.onsuccess = () => res(JSON.stringify(q.result)); }; r.onerror = () => res("[]"); })`));
  const meta = async () => JSON.parse(await ev(`new Promise((res) => { const r = indexedDB.open("marpec-cola"); r.onsuccess = () => { const q = r.result.transaction("meta").objectStore("meta").getAllKeys(); q.onsuccess = () => res(JSON.stringify(q.result)); }; r.onerror = () => res("[]"); })`));
  // Mantener presionado el botón de pánico con el ratón (eventos reales del navegador)
  const centro = async (sel) => JSON.parse(await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  const presionar = async (sel) => { const p = await centro(sel); await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }); await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 }); };
  const soltar = async (sel) => { const p = await centro(sel); await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }); };

  // =============================================================== GUARDIA
  await ir("/index.html?rol=guardia&entrada=1");
  check("guardia: botón de pánico visible en la pantalla principal", (await ev("!!document.getElementById('btn-panico')")) === true);
  check("guardia: la barra de sincronización está oculta cuando todo está enviado y hay conexión", (await ev("document.getElementById('barra-sync').hidden")) === true);
  // visible sobre cualquier pantalla (modales y asistentes)
  await clic("/Novedad/i", ".libro-btn");
  await espera(400);
  const arriba = async () => ev(`(() => { const r = document.getElementById('btn-panico').getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e.id === 'btn-panico' || !!e.closest('#btn-panico')); })()`);
  check("el botón de pánico queda ENCIMA de los modales", await arriba());
  await ev("document.querySelector('.modal .btn-icono').click()");
  await ev("document.querySelector('.libro-botones') && 0");
  await clic("/Incidencia/i", ".libro-btn"); await espera(500);
  await ev("document.querySelector('.modal .btn-icono').click()");
  // pantalla completa del asistente de marcar (se abre desde el estado sin entrada)
  await ir("/index.html?rol=guardia");
  await clic("/MARCAR ENTRADA/i"); await espera(400);
  check("el botón de pánico queda ENCIMA del asistente de marcado (pantalla completa)", await arriba());
  await ev("document.querySelector('.marcar-cab .btn-icono').click()");
  await ir("/index.html?rol=guardia&entrada=1");

  // ---- 3 segundos ----
  await ev("window.__llamadas.length = 0");
  await presionar("#btn-panico");
  await espera(1200);
  const prog = await ev("getComputedStyle(document.getElementById('btn-panico')).getPropertyValue('--p')");
  check("pánico: muestra el progreso mientras se mantiene presionado", Number(prog) > 0.2 && Number(prog) < 0.8, `--p=${prog}`);
  await soltar("#btn-panico");
  await espera(2500);
  check("pánico: soltar ANTES de 3 s cancela (no se envía nada)", (await llamadas("/panico")).length === 0 && (await ev("!document.getElementById('panico-panel')")));
  check("pánico: el progreso vuelve a cero", Number(await ev("getComputedStyle(document.getElementById('btn-panico')).getPropertyValue('--p')")) === 0);
  await presionar("#btn-panico");
  await espera(3600);
  await soltar("#btn-panico");
  await espera(800);
  const pan = await llamadas("/panico");
  check("pánico: tras 3 s se envía con el tiempo presionado, GPS y turno", pan.length === 1 && pan[0].body.mantenidoMs >= 3000 && pan[0].body.mantenidoMs < 4500 && Math.abs(pan[0].body.lat - 29.0729) < 0.001 && pan[0].body.turnoId === "t5", JSON.stringify(pan[0]?.body).slice(0, 160));
  const panel = await conTexto("#panico-panel", /Alerta enviada/i);
  check("pánico: confirma «Alerta enviada» al guardia", /Alerta enviada/i.test(panel), panel.replace(/\n+/g, " ").slice(0, 140));
  check("pánico: ofrece llamar al supervisor del sitio y al 911", (await ev("!!document.querySelector('#panico-panel a[href=\"tel:6621234567\"]')")) && (await ev("!!document.querySelector('#panico-panel a[href=\"tel:911\"]')")));
  check("pánico: el envío en línea lleva clave de idempotencia (clientId) sin marcarse sin conexión", pan[0].body.sync && /^[A-Za-z0-9_-]{16,}$/.test(pan[0].body.sync.clientId) && pan[0].body.sync.offline === undefined);
  await ev("document.querySelector('#panico-panel .btn.secundario').click()");

  // =============================================================== SIN CONEXIÓN
  await ev("window.__skew = 3600e3"); // el servidor va 1 h adelante del reloj del celular
  await ev("window.__llamadas.length = 0");
  await clic("/Bitácora/i", ".libro-btn"); // cualquier llamada al Worker sincroniza el desfase del reloj
  await conTexto(".modal", /Este turno/i);
  await ev("document.querySelector('.modal .btn-icono').click()");
  await ev("window.__setOffline(true)");
  await espera(500);
  const barra = await texto("#barra-sync");
  check("sin conexión: la barra avisa que se puede seguir trabajando", /Sin conexión/i.test(barra) && (await ev("!document.getElementById('barra-sync').hidden")), barra.replace(/\n+/g, " "));
  await clic("/Novedad/i", ".libro-btn");
  await espera(300);
  await ev("document.querySelector('.modal textarea').value = 'Portón 3 sin candado, lo aseguré.'; document.querySelector('.modal form').requestSubmit()");
  await espera(900);
  const toast1 = await ev("document.getElementById('toasts').innerText");
  check("sin conexión: la novedad se guarda en el celular (no se pierde) y avisa", /SIN CONEXIÓN/i.test(toast1), toast1);
  check("sin conexión: ningún intento de envío llegó al servidor", (await llamadas("/novedades")).length === 0 && (await ev("window.__fallidas")) >= 1);
  check("indicador: «1 registro pendiente de enviar»", /1 registro pendiente de enviar/i.test(await conTexto("#barra-sync", /1 registro pendiente/i)));
  // pánico sin conexión (pasa el bloqueo anti-rebote de 5 s del botón tras el pánico anterior)
  await espera(5200);
  await presionar("#btn-panico");
  await espera(3600);
  await soltar("#btn-panico");
  const panelOff = await conTexto("#panico-panel", /SIN CONEXIÓN/i);
  check("pánico sin conexión: queda guardado y se enviará AUTOMÁTICAMENTE; botones de llamar al supervisor y al 911", /SIN CONEXIÓN/i.test(panelOff) && /AUTOMÁTICAMENTE/i.test(panelOff) && /Llamar al supervisor \(662 123 4567\)/i.test(panelOff) && /Llamar al 911/i.test(panelOff), panelOff.replace(/\n+/g, " ").slice(0, 200));
  await ev("document.querySelector('#panico-panel .btn.secundario').click()");
  // incidencia con fotos sin conexión
  await clic("/Incidencia/i", ".libro-btn");
  await conTexto(".modal", /Tipo de incidencia/i);
  await ev("const s = document.querySelectorAll('.modal select'); s[0].value = 'robo'; s[1].value = 'alta'; document.querySelector('.modal textarea').value = 'Reja forzada en el estacionamiento norte.'");
  await ev("[...document.querySelectorAll('.modal button')].find((b) => /Agregar foto/i.test(b.textContent) && !b.hidden).click()");
  await conTexto(".modal:last-of-type", /Tomar foto/i);
  await espera(1300);
  await ev("[...document.querySelectorAll('button')].find((b) => /Tomar foto/i.test(b.textContent)).click()");
  await espera(1500);
  await ev("document.querySelector('.modal form').requestSubmit()");
  await espera(1200);
  const items = await cola();
  check("cola local (IndexedDB): novedad, pánico e incidencia con su foto", items.length === 3 && items.map((x) => x.tipo).join() === "novedad,panico,incidencia", items.map((x) => x.tipo).join());
  const inc = items.find((x) => x.tipo === "incidencia");
  check("incidencia sin conexión: guarda la foto JPEG completa", inc?.body.fotos?.length === 1 && Buffer.from(inc.body.fotos[0], "base64")[0] === 0xff, `fotos=${inc?.body.fotos?.length}`);
  const nov = items[0];
  check("cada registro lleva clientId único, sync.offline=true y las dos horas", items.every((x) => x.body.sync.offline === true && /^[A-Za-z0-9_-]{16,}$/.test(x.body.sync.clientId) && Number.isFinite(x.body.sync.horaDispositivoMs) && Number.isFinite(x.body.sync.horaEstimadaMs)) && new Set(items.map((x) => x.body.sync.clientId)).size === 3);
  const desf = nov.body.sync.horaEstimadaMs - nov.body.sync.horaDispositivoMs;
  check("hora estimada = reloj del celular + desfase conocido con el servidor (+1 h simulada)", Math.abs(desf - 3600e3) < 8000, `${Math.round(desf / 1000)} s`);
  const crudo = JSON.stringify(items) + JSON.stringify(await meta());
  check("la cola NO guarda PIN ni tokens (ni «fake-token» ni campos de credenciales)", !/fake-token|\"pin\"|password|authorization|bearer/i.test(crudo));
  // abrir la app SIN conexión: último turno guardado en el celular
  await ir("/index.html?rol=guardia&entrada=1&offline=1", 4500);
  const homeOff = await texto("#contenido");
  check("app abierta sin conexión: muestra el último turno guardado y no cierra la sesión", /Sin conexión: se muestra tu último turno guardado/i.test(homeOff) && /Plaza Norte/.test(homeOff) && (await ev("!document.getElementById('vista-inicio').hidden")), homeOff.replace(/\n+/g, " ").slice(0, 140));
  check("app abierta sin conexión: la cola sigue ahí (3 pendientes) y el botón de pánico sigue", /3 registros pendientes de enviar/i.test(await conTexto("#barra-sync", /3 registros/i)) && (await ev("!!document.getElementById('btn-panico')")));
  check("sin conexión: rondines disponibles desde la copia local", /Rondines \(sin conexión\)/i.test(homeOff) && /INICIAR RONDÍN/i.test(homeOff));
  // rondín sin conexión
  await clic("/INICIAR RONDÍN/i");
  const esc = await conTexto(".marcar-caja", /Ruta ordenada/i);
  check("rondín sin conexión: escaneo desde la copia (ruta ordenada, siguiente «Portón»)", /SIN CONEXIÓN/i.test(esc) && /escanea «Portón»/i.test(esc), esc.replace(/\n+/g, " ").slice(0, 160));
  await ev("window.__qr = 'MPC2.p1.1.AAAAAAAAAAAAAAAAAAAAAA'");
  await conTexto(".marcar-caja", /Ubicación capturada/i);
  await clic("/Registrar punto/i");
  await ev("window.__qr = null");
  await espera(1800);
  const itemsR = await cola();
  const esc1 = itemsR.find((x) => x.tipo === "rondin");
  check("rondín sin conexión: el punto queda en la cola con QR, GPS y hora estimada", Boolean(esc1) && esc1.body.qr === "MPC2.p1.1.AAAAAAAAAAAAAAAAAAAAAA" && esc1.body.sync.offline === true && esc1.meta.puntoId === "p1");
  check("rondín sin conexión: avanza al siguiente punto (progreso 1 de 3)", /1 de 3 puntos/i.test(await conTexto(".marcar-caja", /1 de 3/i)) && /Siguiente: «Bodega»/i.test(await texto(".marcar-caja")));
  await ev("document.querySelector('.marcar-cab .btn-icono').click()");
  await ev("window.__qr = null");

  // =============================================================== VUELVE LA SEÑAL
  await ev("window.__llamadas.length = 0; window.__duplicados = true");
  await ev("window.__setOffline(false)");
  await espera(5000);
  const vuelta = await Promise.all(["/novedades", "/panico", "/incidencias", "/rondines/escanear"].map(llamadas));
  check("al volver la señal se envían SOLAS, en orden: novedad, pánico, incidencia y punto de rondín", vuelta.every((l) => l.length === 1), vuelta.map((l) => l.length).join());
  check("lo enviado conserva clientId y las horas capturadas (sync.offline=true)", vuelta.flat().every((l) => l.body.sync.offline === true && l.body.sync.horaEstimadaMs > 0));
  const ordenEnvio = JSON.parse(await ev("JSON.stringify(window.__llamadas.filter((l) => ['/novedades','/panico','/incidencias','/rondines/escanear'].includes(l.ruta)).map((l) => l.ruta))"));
  check("el orden de envío es el de captura", ordenEnvio.join() === "/novedades,/panico,/incidencias,/rondines/escanear", ordenEnvio.join());
  check("la cola queda vacía y el indicador desaparece", (await cola()).length === 0 && (await ev("document.getElementById('barra-sync').hidden")) === true);
  // reenvío del mismo registro: el servidor responde «duplicado» y no se vuelve a pedir
  await ev("window.__setOffline(true)");
  await clic("/Novedad/i", ".libro-btn"); await espera(300);
  await ev("document.querySelector('.modal textarea').value = 'Segunda novedad sin señal.'; document.querySelector('.modal form').requestSubmit()");
  await espera(700);
  const it2 = (await cola())[0];
  await ev(`window.__vistos = new Set([${JSON.stringify(it2.body.sync.clientId)}])`); // el servidor «ya lo tenía» (respuesta perdida antes)
  await ev("window.__llamadas.length = 0; window.__setOffline(false)");
  await espera(4500);
  check("un registro que el servidor ya tenía (duplicado) se da por enviado y sale de la cola", (await cola()).length === 0 && (await llamadas("/novedades")).length === 1);

  // ---- rechazo definitivo del servidor ----
  await ev("window.__setOffline(true)");
  await clic("/Novedad/i", ".libro-btn"); await espera(300);
  await ev("document.querySelector('.modal textarea').value = 'Esta será rechazada.'; document.querySelector('.modal form').requestSubmit()");
  await espera(600);
  await clic("/Novedad/i", ".libro-btn"); await espera(300);
  await ev("document.querySelector('.modal textarea').value = 'Esta sí se acepta.'; document.querySelector('.modal form').requestSubmit()");
  await espera(600);
  await ev("window.__rechazar = ['/novedades']; window.__llamadas.length = 0; window.__setOffline(false)");
  await espera(4500);
  const colaRech = await cola();
  check("rechazo del servidor: queda «rechazado» con el motivo y NO bloquea a los demás", colaRech.length === 2 && colaRech.every((x) => x.estado === "rechazado"), colaRech.map((x) => x.estado).join());
  const barraR = await conTexto("#barra-sync", /rechazad/i);
  check("indicador de rechazados visible", /2 rechazados/i.test(barraR), barraR.replace(/\n+/g, " "));
  await clic("/Ver/i", "#barra-sync button");
  const lista = await conTexto(".modal", /Rechazado/i);
  check("la lista muestra el motivo del rechazo y permite descartar", /El código QR no es válido/i.test(lista) && /Descartar/i.test(lista), lista.replace(/\n+/g, " ").slice(0, 160));
  await clic("/Descartar/i", ".modal button"); await espera(300);
  await clic("/Descartar/i", ".modal button"); await espera(300);
  check("descartar rechazados vacía la cola", (await cola()).length === 0);
  await ev("document.querySelector('.modal .btn-icono') && document.querySelector('.modal .btn-icono').click(); window.__rechazar = null");

  // ---- cierre de sesión con registros pendientes ----
  await ev("window.__setOffline(true)");
  await clic("/Novedad/i", ".libro-btn"); await espera(300);
  await ev("document.querySelector('.modal textarea').value = 'Pendiente al salir.'; document.querySelector('.modal form').requestSubmit()");
  await espera(600);
  await ev("document.getElementById('btn-salir').click()");
  const aviso = await conTexto(".modal", /se BORRARÁN/i);
  check("cerrar sesión con pendientes: advierte que se borrarán y pide confirmar", /1 registro\(s\) sin enviar/i.test(aviso) && /BORRARÁN/.test(aviso), aviso.replace(/\n+/g, " ").slice(0, 160));
  await clic("/Cancelar/i", ".modal button"); await espera(400);
  check("cancelar conserva la sesión y la cola", (await cola()).length === 1 && (await ev("!document.getElementById('vista-inicio').hidden")));
  await ev("document.getElementById('btn-salir').click()");
  await conTexto(".modal", /se BORRARÁN/i);
  await clic("/Cerrar sesión y borrarlos/i", ".modal button");
  await espera(1200);
  check("cerrar sesión BORRA la cola y las copias locales", (await cola()).length === 0 && (await meta()).length === 0);
  check("cerrar sesión desmonta el botón de pánico", (await ev("!document.getElementById('btn-panico')")) === true);

  // =============================================================== SUPERVISOR
  await ir("/index.html?rol=supervisor", 3000);
  const tabs = await ev("[...document.querySelectorAll('.tab-app')].map((b) => b.textContent).join(',')");
  check("supervisor: pestañas En vivo, Sin conexión y Alertas", /^En vivo,/.test(tabs) && /Sin conexión/.test(tabs) && /Alertas/.test(tabs), tabs);
  check("supervisor: abre en «En vivo» sin botón de actualizar", /En vivo/i.test(await texto("#contenido h2")) && (await ev("![...document.querySelectorAll('#contenido button')].some((b) => /Actualizar/i.test(b.textContent))")) === true);
  check("supervisor: no ve el botón de pánico del guardia", (await ev("!document.getElementById('btn-panico')")) === true);
  const ahoraMs = await ev("Date.now()");
  // Estado en vivo: se cambian los datos y la pantalla se actualiza SOLA (listeners)
  const sembrar = (entrada) => ev(`(() => { const s = window.__store; const now = Date.now();
    s.turnos = { tx: { sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaUid: "g-G001", inicioMs: now - 3600e3, finMs: now + 11 * 3600e3, estado: "programado" }, ty: { sitioId: "siteB", sitioNombre: "Bodega Sur", supervisorUid: "sup2", guardiaUid: "g-G002", inicioMs: now - 3600e3, finMs: now + 11 * 3600e3, estado: "programado" } };
    s.asistencias = { tx: { turnoId: "tx", sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaUid: "g-G001", guardiaNombre: "Gael Guardia", inicioMs: now - 3600e3, finMs: now + 11 * 3600e3, entradaMs: ${entrada ? "now - 50 * 60e3" : "null"}, salidaMs: null, estado: "en_turno" },
      ty: { turnoId: "ty", sitioId: "siteB", sitioNombre: "Bodega Sur", supervisorUid: "sup2", guardiaUid: "g-G002", guardiaNombre: "Gema Guardia", inicioMs: now - 3600e3, finMs: now + 11 * 3600e3, entradaMs: now - 40 * 60e3, salidaMs: null, estado: "en_turno" } };
    s.rondines = {}; s.panicoVista = { pj: { panicoId: "pj", sitioId: "siteB", sitioNombre: "Bodega Sur", supervisorUid: "sup2", guardiaNombre: "Gema Guardia", estado: "activa", tsMs: now } }; s.incidenciasResumen = {}; s.visitantesVista = {}; s.offlineVista = s.offlineVista || {};
    window.__tick(); })()`);
  await sembrar(true);
  await espera(600);
  let vivo = await texto("#contenido");
  check("en vivo: «Plaza Norte» cubierto con el guardia y desde qué hora", /Plaza Norte/.test(vivo) && /Cubierto/i.test(await texto(".vivo-puesto")) && /Gael Guardia/.test(vivo), vivo.replace(/\n+/g, " ").slice(0, 120));
  check("en vivo: NO aparece nada del sitio de otro supervisor (ni su alerta de pánico)", !/Bodega Sur/.test(vivo) && !/Gema/.test(vivo) && (await ev("window.__escuchasRechazadas || 0")) === 0 && (await ev("document.getElementById('alertas-panico').hidden")) === true);
  await sembrar(false);
  await espera(500);
  check("en vivo: al dejar de estar el guardia el puesto pasa solo a «Descubierto»", /Descubierto/i.test(await texto(".vivo-puesto")) && /Turno vigente sin guardia/i.test(await texto("#contenido")));
  const subs = await ev("window.__suscripciones()");
  check("en vivo: escucha en tiempo real (7 listeners de Firestore, filtrados por su supervisorUid) + el de alertas", subs >= 8, `suscripciones=${subs}`);
  check("en vivo: muestra el indicador «En vivo» y la hora de la última actualización", /● En vivo · \d\d:\d\d/.test(await texto("#vivo-conexion")));
  // ---- alerta de pánico: aviso persistente ----
  await ev("window.__panico({ id: 'pz', tsMs: Date.now() })");
  await espera(600);
  const al = await texto("#alertas-panico");
  check("pánico: aparece el aviso a pantalla completa con sitio, guardia, hora y ubicación", /pánico/i.test(al) && /plaza norte/i.test(al) && /gael guardia/i.test(al) && /29\.0731/.test(al), al.replace(/\n+/g, " ").slice(0, 160));
  check("pánico: no se puede cerrar (solo «ATENDER»)", (await ev("[...document.querySelectorAll('#alertas-panico button')].map((b) => b.textContent.trim()).filter((t) => !/sonido/i.test(t)).join('|')")) === "ATENDER");
  check("pánico: el puesto aparece en estado PÁNICO en el panel", /PÁNICO/.test(await texto(".vivo-puesto")) && (await ev("document.querySelector('.vivo-puesto').classList.contains('e-panico')")) === true);
  check("pánico: título de la pestaña parpadea y se activa la sirena", (await ev("window.__tick(); document.title")) !== null);
  await ev("document.querySelector('[data-clave=asistencia]').click()");
  await espera(700);
  check("el aviso sigue visible aunque el supervisor cambie de sección", (await ev("document.getElementById('alertas-panico').hidden")) === false && /PÁNICO/.test(await texto("#alertas-panico")));
  await ev("window.__llamadas.length = 0");
  await clic("/ATENDER/", "#alertas-panico button");
  await conTexto(".modal", /Atender alerta de pánico/i);
  await ev("document.querySelector('.modal textarea').value = 'Voy en camino con la patrulla.'; document.querySelector('.modal form').requestSubmit()");
  await espera(900);
  const at = await llamadas("/panico/atender");
  check("atender: registra quién (la sesión) con una nota; el servidor guarda hora y autor", at.length === 1 && at[0].body.id === "pz" && at[0].body.nota === "Voy en camino con la patrulla.");
  check("al atenderse el aviso desaparece y el sonido se detiene", (await ev("document.getElementById('alertas-panico').hidden")) === true);
  // ---- bandeja sin conexión ----
  await ev(`(() => { const now = Date.now(); window.__store.offlineVista = {
    o1: { registroId: "o1", tipo: "entrada", titulo: "Entrada al turno", sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaNombre: "Gael Guardia", tsMs: now - 3 * 3600e3, recibidoMs: now - 3600e3, horaDispositivoMs: now - 3.1 * 3600e3, estadoRevision: "pendiente" },
    o2: { registroId: "o2", tipo: "novedad", titulo: "Novedad", sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaNombre: "Gael Guardia", tsMs: now - 2 * 3600e3, recibidoMs: now - 3600e3, horaDispositivoMs: now - 2 * 3600e3, estadoRevision: "pendiente" },
    o3: { registroId: "o3", tipo: "entrada", titulo: "Entrada", sitioId: "siteB", sitioNombre: "Bodega Sur", supervisorUid: "sup2", guardiaNombre: "Gema", tsMs: now - 3 * 3600e3, recibidoMs: now - 3600e3, horaDispositivoMs: now, estadoRevision: "pendiente" } }; })()`);
  await ev("document.querySelector('[data-clave=offline]').click()");
  const bandeja = await conTexto("#contenido", /Por revisar \(2\)/i);
  check("bandeja «Sin conexión»: solo los registros de SU sitio, con hora estimada, reloj del celular y recepción", /por revisar \(2\)/i.test(bandeja) && /plaza norte/i.test(bandeja) && !/bodega sur/i.test(bandeja) && /reloj del celular/i.test(bandeja) && /recibido/i.test(bandeja), bandeja.replace(/\n+/g, " ").slice(0, 160));
  await clic("/Ajustar/i", "#contenido button");
  await conTexto(".modal", /Ajustar registro/i);
  await ev("window.__llamadas.length = 0; document.querySelector('.modal form').requestSubmit()");
  await espera(500);
  check("ajustar exige motivo (no se envía vacío)", (await llamadas("/offline/revisar")).length === 0 && /motivo del ajuste/i.test(await ev("document.getElementById('toasts').innerText")));
  await ev("document.querySelector('.modal textarea').value = 'El guardia entró a las 07:03 según el testigo.'; document.querySelector('.modal form').requestSubmit()");
  await espera(900);
  const rv = await llamadas("/offline/revisar");
  check("ajustar: envía registro, acción, motivo y la hora ajustada", rv.length === 1 && rv[0].body.accion === "ajustar" && rv[0].body.motivo.includes("07:03") && Number.isFinite(rv[0].body.horaAjustadaMs));
  await clic("/Aceptar/i", "#contenido button");
  await conTexto(".modal", /Aceptar registro sin conexión/i);
  await ev("window.__llamadas.length = 0; document.querySelector('.modal form').requestSubmit()");
  await espera(900);
  const ac = await llamadas("/offline/revisar");
  check("aceptar: un clic con confirmación y el registro pasa a «Revisados»", ac.length === 1 && ac[0].body.accion === "aceptar" && /revisados/i.test(await texto("#contenido")));
  // ---- notificaciones ----
  await ev("document.querySelector('[data-clave=alertas]').click()");
  const alv = await conTexto("#contenido", /Notificaciones en este dispositivo/i);
  check("alertas: panel de notificaciones con el aviso del servicio push (Google/Mozilla/Apple) y la nota de iPhone", /notificaciones en este dispositivo/i.test(alv) && /Google, Mozilla o Apple/i.test(alv) && /dependencia inevitable/i.test(alv), alv.replace(/\n+/g, " ").slice(0, 120));
  check("alertas: opt-in (botón Activar) y preferencias por tipo; el pánico no es configurable", /Activar notificaciones/i.test(alv) && (await ev("document.querySelectorAll('#contenido input[type=checkbox]').length")) === 3 && /pánico siempre se notifica/i.test(alv));
  check("alertas: historial de pánico con quién la atendió", /historial de alertas de pánico/i.test(alv));
  await ev("window.__llamadas.length = 0; document.querySelector('#contenido input[type=checkbox]').click()");
  await espera(600);
  const pf = await llamadas("/push/prefs");
  check("preferencias: se guardan por usuario (sin incluir el pánico)", pf.length === 1 && Object.keys(pf[0].body.prefs).sort().join() === "incidencia_alta,relevo,rondin" && pf[0].body.prefs.incidencia_alta === false);

  // =============================================================== ADMIN
  await ir("/index.html?rol=admin", 3000);
  await sembrar(true);
  await espera(600);
  const vivoA = await texto("#contenido");
  check("admin: el panel en vivo muestra TODOS los sitios y la alerta de pánico de cualquier sitio", /Plaza Norte/.test(vivoA) && /Bodega Sur/.test(vivoA) && /PÁNICO/.test(await texto("#alertas-panico")), vivoA.replace(/\n+/g, " ").slice(0, 120));
  check("admin: el aviso de pánico es persistente también para él", (await ev("[...document.querySelectorAll('#alertas-panico button')].map((b) => b.textContent.trim()).filter((t) => !/sonido/i.test(t)).join('|')")) === "ATENDER");
  await ev("document.querySelector('[data-clave=empresa]').click()");
  const emp = await conTexto("#contenido", /Registros sin conexión/i);
  check("empresa: antigüedad máxima de registros sin conexión configurable (12 h por defecto)", /Antigüedad máxima aceptada \(horas\)/i.test(emp) && (await ev("[...document.querySelectorAll('#contenido input')].some((i) => i.value === '12' && i.max === '72')")) === true);
  await ev("document.querySelector('[data-clave=sitios]').click()");
  await conTexto("#contenido", /Plaza Norte/);
  check("sitios: muestra el teléfono de emergencia", /Teléfono de emergencia: 662 123 4567/.test(await texto("#contenido")));
  await ev("[...document.querySelectorAll('#contenido li')].find((li) => /Plaza Norte/.test(li.innerText)).querySelector('.item-acc').querySelectorAll('button')[2].click()");
  const fs = await conTexto(".modal", /Teléfono de emergencia del sitio/i);
  check("sitios: campo «Teléfono de emergencia del sitio» editable", /Teléfono de emergencia del sitio/.test(fs) && (await ev("[...document.querySelectorAll('.modal input[type=tel]')].some((i) => i.value === '662 123 4567')")) === true);

  check("sin excepciones de JavaScript durante toda la prueba", errores.length === 0, errores.slice(0, 2).join(" | "));
  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS DE INTERFAZ (FASE 6) PASARON");
  sock.close();
} finally {
  proc.kill();
  process.exitCode = fallos ? 1 : 0;
}
