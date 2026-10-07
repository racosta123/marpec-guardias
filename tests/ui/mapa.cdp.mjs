// Prueba de «Elegir en el mapa» y del enlace/coordenadas pegadas (formularios de Sitio y de Punto) con Chrome real por CDP.
// Firebase y Worker simulados (tools/serve.mjs --fake). Los mosaicos de OpenStreetMap se interceptan y se responden con una imagen
// local (la prueba no depende de internet ni le pega al servidor de OSM); con CAPTURAS=real se piden de verdad solo para tomar las capturas.
// También verifica, con la política de seguridad REAL de index.html inyectada, que el mapa funciona sin violaciones.
// Uso: node tests/ui/mapa.cdp.mjs http://localhost:5182
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const base = process.argv[2];
if (!base) throw new Error("uso: node tests/ui/mapa.cdp.mjs <urlBase>");
const REAL = process.env.CAPTURAS === "real";
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9800 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✖"} ${n}${extra ? "  → " + extra : ""}`); if (!ok) fallos++; };

// PNG 256x256 (cuadrícula suave) generado aquí: sustituye a los mosaicos reales en la prueba
function pngMosaico() {
  const W = 256, filas = [];
  for (let y = 0; y < W; y++) {
    const fila = Buffer.alloc(1 + W * 3);
    for (let x = 0; x < W; x++) { const l = x % 64 === 0 || y % 64 === 0; fila.set(l ? [190, 205, 190] : [226, 232, 222], 1 + x * 3); }
    filas.push(fila);
  }
  const tabla = [];
  for (let k = 0; k < 256; k++) { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tabla[k] = c >>> 0; }
  const crc = (b) => { let r = 0xffffffff; for (const x of b) r = tabla[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (tipo, datos) => { const l = Buffer.alloc(4); l.writeUInt32BE(datos.length); const td = Buffer.concat([Buffer.from(tipo), datos]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(filas))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const MOSAICO = pngMosaico();
const csp = /Content-Security-Policy" content="([^"]+)"/.exec(readFileSync("index.html", "utf8"))[1];
const cspMeta = JSON.stringify(csp);

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
  const pedidos = []; // { url }
  const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errores.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Network.requestWillBeSent") pedidos.push({ url: m.params.request.url });
    if (m.method === "Fetch.requestPaused") {
      const u = m.params.request.url;
      if (!REAL && /^https:\/\/tile\.openstreetmap\.org\//.test(u)) cmd("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "image/png" }], body: MOSAICO });
      else cmd("Fetch.continueRequest", { requestId: m.params.requestId });
    }
  };
  const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cmd("Page.enable"); await cmd("Runtime.enable"); await cmd("Network.enable");
  await cmd("Fetch.enable", { patterns: [{ urlPattern: "https://tile.openstreetmap.org/*" }] });
  await cmd("Browser.grantPermissions", { permissions: ["geolocation"], origin: new URL(base).origin });
  const geo = (latitude, longitude, accuracy) => cmd("Emulation.setGeolocationOverride", { latitude, longitude, accuracy });
  await geo(29.0729, -110.9559, 8);
  // violaciones de la política de seguridad (se registran en la página)
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: "window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));" });
  const hasta = async (expr, ms = 10000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (await ev(expr)) return true; await espera(150); } return false; };
  const ir = async (u) => {
    await cmd("Page.navigate", { url: `${base}${u}` });
    const fin = Date.now() + 20000;
    while (Date.now() < fin) { await espera(250); if (await ev("(() => { const c = document.getElementById('cargando'); return Boolean(c) && c.hidden; })()")) break; }
    await espera(800);
  };
  const clic = (re, sel = "button") => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent) && !x.hidden && !x.disabled); if (b) b.click(); return Boolean(b); })()`);
  const caja = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.right, b: r.bottom }; })()`);
  const raton = async (tipo, x, y) => cmd("Input.dispatchMouseEvent", { type: tipo, x, y, button: "left", buttons: tipo === "mouseReleased" ? 0 : 1, clickCount: 1 });
  const tocar = async (x, y) => { await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await raton("mousePressed", x, y); await raton("mouseReleased", x, y); };
  const escribir = async (sel, texto) => { await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select?.(); })()`); await cmd("Input.insertText", { text: texto }); };
  const tecla = (key, code, vk) => cmd("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk }).then(() => cmd("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk }));
  const val = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).value`);
  const texto = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
  const llamadas = async (ruta) => JSON.parse(await ev(`JSON.stringify(window.__llamadas.filter((l) => l.ruta === ${JSON.stringify(ruta)}))`));
  const campoLat = ".modal:not(.modal-mapa) .ubicacion .dos label:nth-child(1) input";
  const campoLng = ".modal:not(.modal-mapa) .ubicacion .dos label:nth-child(2) input";
  const campoRadio = ".modal:not(.modal-mapa) .ubicacion > label.campo input[type=number]";
  const campoEnlace = ".ubicacion .enlace-fila input";
  const estado = ".ubicacion small[role=status]";
  const mpp = (lat, z) => 156543.03392 * Math.cos((lat * Math.PI) / 180) / 2 ** z; // metros por píxel (Web Mercator)
  const lienzo = ".mapa-lienzo";
  const inyectarCsp = () => ev(`(() => { const m = document.createElement('meta'); m.httpEquiv = 'Content-Security-Policy'; m.content = ${cspMeta}; document.head.append(m); })()`);
  const abrirMapa = async () => { await clic(/Elegir en el mapa/, ".ubicacion button"); return hasta("document.querySelectorAll('.mapa-lienzo .leaflet-tile-loaded').length > 0", 15000); };
  const lectura = async () => /Latitud (-?[\d.]+) · Longitud (-?[\d.]+)/.exec(await texto(".mapa-lectura"))?.slice(1).map(Number);
  const abrirNuevoSitio = async () => {
    await ir("/index.html?rol=admin");
    await ev("document.querySelector('[data-clave=sitios]').click()");
    await hasta("[...document.querySelectorAll('button')].some((b) => /\\+ Sitio/.test(b.textContent))");
    await clic(/\+ Sitio/);
    await hasta("!!document.querySelector('.ubicacion')");
  };

  // ================================================================ SITIO
  await abrirNuevoSitio();
  check("formulario de Sitio: botón «Elegir en el mapa» y campo para pegar enlace o coordenadas",
    (await ev("[...document.querySelectorAll('.ubicacion button')].some((b) => /Elegir en el mapa/.test(b.textContent))")) === true
    && /Pegar enlace de Google Maps o coordenadas/.test(await texto(".ubicacion")));
  check("carga perezosa: antes de abrir el mapa no se pidió Leaflet ni nada de OpenStreetMap",
    !pedidos.some((p) => /leaflet|openstreetmap/i.test(p.url)), pedidos.filter((p) => /leaflet|openstreetmap/i.test(p.url)).map((p) => p.url).join(" "));
  check("el service worker NO precarga Leaflet ni el mapa", !/leaflet|mapa\.js/.test(readFileSync("sw.js", "utf8").split("const SHELL")[1].split("];")[0]));

  // ---- enlace pegado (Enter y botón Usar; no se envía el formulario)
  await escribir(campoEnlace, "https://maps.app.goo.gl/AbCdEf");
  await tecla("Enter", "Enter", 13);
  await espera(150);
  check("enlace corto de Google: avisa que no se puede leer sin red y no llena nada", /cortos/.test(await texto(estado)) && (await val(campoLat)) === "");
  await escribir(campoEnlace, "hola");
  await tecla("Enter", "Enter", 13);
  await espera(150);
  check("texto sin coordenadas: mensaje claro", /No encontré coordenadas/.test(await texto(estado)));
  const enlace = "https://www.google.com/maps/place/Plaza+Norte/@29.1,-110.9,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d29.0729!4d-110.9559";
  await escribir(campoEnlace, enlace);
  await tecla("Enter", "Enter", 13);
  await espera(250);
  check("enlace de Google Maps (Enter): llena latitud y longitud con el pin del lugar", (await val(campoLat)) === "29.072900" && (await val(campoLng)) === "-110.955900", `${await val(campoLat)} / ${await val(campoLng)}`);
  check("Enter en el campo NO envía el formulario", (await llamadas("/admin/sitios")).length === 0 && (await ev("!!document.querySelector('.modal')")) === true);
  check("el campo se limpia y se informa el origen sin precisión de GPS", (await val(campoEnlace)) === "" && /sin precisión de GPS/.test(await texto(estado)));
  await escribir(campoEnlace, "29,0800 -110,9600");
  await clic(/^Usar$/, ".ubicacion button");
  await espera(150);
  check("coordenadas con coma decimal + botón «Usar»", (await val(campoLat)) === "29.080000" && (await val(campoLng)) === "-110.960000");
  await escribir(campoEnlace, enlace);
  await tecla("Enter", "Enter", 13);
  await espera(150);

  // ---- precisión del GPS
  await geo(29.0729, -110.9559, 150);
  await clic(/Usar mi ubicación actual/, ".ubicacion button");
  await hasta("/recisi/.test(document.querySelector('.ubicacion small[role=status]').textContent)");
  check("GPS con ±150 m: «Precisión baja (±150 m). Usa el celular al aire libre o elige en el mapa»",
    (await texto(estado)).trim() === "Precisión baja (±150 m). Usa el celular al aire libre o elige en el mapa", await texto(estado));
  await geo(29.0729, -110.9559, 12);
  await clic(/Usar mi ubicación actual/, ".ubicacion button");
  await hasta("/±12 m/.test(document.querySelector('.ubicacion small[role=status]').textContent)");
  check("GPS con ±12 m: sin aviso de precisión baja", /±12 m/.test(await texto(estado)) && !/Precisión baja/.test(await texto(estado)));
  await geo(29.0729, -110.9559, 8);
  await escribir(campoEnlace, enlace);
  await tecla("Enter", "Enter", 13);
  await espera(150);

  // ---- ventana del mapa (con la política de seguridad REAL aplicada)
  await inyectarCsp();
  const abrio = await abrirMapa();
  check("el mapa abre y carga mosaicos", abrio, abrio ? "" : JSON.stringify({ errores: errores.slice(0, 3), lienzo: await caja(lienzo), vp: await ev("[innerWidth, innerHeight]"), mapa: (await ev("(document.querySelector('.mapa-lienzo') || {}).className")) }));
  check("Leaflet se descargó recién al abrir (JS y CSS propios, sin CDN)", pedidos.some((p) => /\/js\/vendor\/leaflet\.js/.test(p.url)) && pedidos.some((p) => /\/css\/vendor\/leaflet\.css/.test(p.url)));
  const tiles = await ev("[...document.querySelectorAll('.mapa-lienzo img.leaflet-tile')].map((i) => ({ src: i.src, rp: i.referrerPolicy }))");
  check("los mosaicos vienen SOLO de https://tile.openstreetmap.org y con referrerpolicy=origin", tiles.length > 0 && tiles.every((t) => t.src.startsWith("https://tile.openstreetmap.org/") && t.rp === "origin"), `${tiles.length} mosaicos`);
  const externos = [...new Set(pedidos.map((p) => { try { return new URL(p.url).host; } catch { return ""; } }).filter((h) => h && h !== new URL(base).host))];
  check("no hay otras peticiones externas (ni buscadores ni geocodificadores)", externos.every((h) => h === "tile.openstreetmap.org"), externos.join(", "));
  check("la política de seguridad real no bloqueó nada (mosaicos, estilos ni scripts de Leaflet)", (await ev("window.__csp.length")) === 0, await ev("window.__csp.join(' | ')"));
  await ev("(() => { const i = new Image(); i.src = 'https://ejemplo-no-permitido.test/x.png'; })()");
  await espera(400);
  check("control: la política SÍ bloquea una imagen de otro host", (await ev("window.__csp.some((v) => /img-src/.test(v))")) === true);
  await ev("window.__csp.length = 0");
  const atrib = await caja(".mapa-lienzo .leaflet-control-attribution");
  check("atribución «© OpenStreetMap contributors» visible", /© OpenStreetMap contributors/.test(await texto(".leaflet-control-attribution")) && atrib && atrib.w > 0 && atrib.h > 0);
  check("sin buscador de direcciones en la ventana", (await ev("document.querySelectorAll('.modal-mapa input[type=search], .modal-mapa input[type=text]').length")) === 0);
  check("el pin está en las coordenadas actuales (29.072900, -110.955900) y el radio por defecto es 100 m", /Latitud 29\.072900 · Longitud -110\.955900/.test(await texto(".mapa-lectura")) && (await val(".modal-mapa input[type=number]")) === "100", await texto(".mapa-lectura"));
  const lc = await caja(lienzo);
  const pin = await caja(".pin-mapa");
  check("el pin queda al centro del mapa", pin && Math.abs(pin.cx - lc.cx) < 25 && pin.b > lc.cy - 10 && pin.b < lc.cy + 30, JSON.stringify({ pin: [pin?.cx, pin?.b], centro: [lc.cx, lc.cy] }));
  // círculo: ancho en pantalla = 2·radio / (m/px) para el zoom actual
  const zoom = await ev("(() => { const t = document.querySelector('.mapa-lienzo img.leaflet-tile'); return Number(t.src.split('/').slice(-3)[0]); })()");
  const ancho = () => ev("(() => { const p = document.querySelector('.mapa-lienzo svg path'); return p ? p.getBoundingClientRect().width : 0; })()");
  const a100 = await ancho();
  const esperado100 = (2 * 100) / mpp(29.0729, zoom);
  check("dibuja el círculo con el radio configurado (100 m)", Math.abs(a100 - esperado100) < 6 && a100 > 20, `${a100.toFixed(1)} px vs ${esperado100.toFixed(1)} px (zoom ${zoom})`);
  await escribir(".modal-mapa input[type=number]", "200");
  await espera(250);
  const a200 = await ancho();
  check("el círculo se actualiza al cambiar el radio (200 m → el doble)", Math.abs(a200 / a100 - 2) < 0.06, `${a200.toFixed(1)} px`);
  await escribir(".modal-mapa input[type=number]", "100");

  // tocar el mapa coloca el pin
  const px = 90, py = 60;
  await tocar(lc.cx + px, lc.cy + py);
  await espera(250);
  const lect = await lectura();
  const dLng = (px * mpp(29.0729, zoom)) / (111320 * Math.cos((29.0729 * Math.PI) / 180));
  const dLat = (py * mpp(29.0729, zoom)) / 110574;
  check("tocar el mapa coloca el pin donde se tocó", lect && Math.abs(lect[1] - (-110.9559 + dLng)) < 0.0004 && Math.abs(lect[0] - (29.0729 - dLat)) < 0.0004, String(lect));
  // arrastrar el pin
  const pin2 = await caja(".pin-mapa");
  await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: pin2.cx, y: pin2.cy });
  await raton("mousePressed", pin2.cx, pin2.cy);
  for (let i = 1; i <= 8; i++) { await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: pin2.cx - i * 10, y: pin2.cy - i * 5, button: "left", buttons: 1 }); await espera(30); }
  await raton("mouseReleased", pin2.cx - 80, pin2.cy - 40);
  await espera(250);
  const lect2 = await lectura();
  check("arrastrar el pin actualiza las coordenadas (hacia el oeste y el norte)", lect2[1] < lect[1] - 0.0003 && lect2[0] > lect[0] + 0.0001, `${lect} → ${lect2}`);
  const pinArr = await caja(".pin-mapa");
  const circuloX = await ev("(() => { const r = document.querySelector('.mapa-lienzo svg path').getBoundingClientRect(); return r.left + r.width / 2; })()");
  check("el círculo acompaña al pin", Math.abs(circuloX - pinArr.cx) < 8, `${circuloX.toFixed(0)} vs ${pinArr.cx.toFixed(0)}`);

  // Mi ubicación: centra el mapa sin mover el pin; aviso de precisión baja
  await geo(29.0900, -110.9300, 5000);
  const antesX = pinArr.cx;
  await clic(/Mi ubicación/, ".modal-mapa button");
  await hasta("/Precisión baja/.test(document.querySelector('.modal-mapa small[role=status]').textContent)");
  await espera(600);
  check("«Mi ubicación» avisa la precisión baja del GPS de la computadora", /Precisión baja \(±5000 m\)\. Usa el celular al aire libre o elige en el mapa/.test(await texto(".modal-mapa small[role=status]")), await texto(".modal-mapa small[role=status]"));
  const despues = await caja(".pin-mapa");
  const lect3 = await lectura();
  check("«Mi ubicación» centra el mapa (el pin se desplaza en pantalla) y no cambia las coordenadas elegidas", Math.abs(despues.cx - antesX) > 100 && lect3[0] === lect2[0] && lect3[1] === lect2[1], `${antesX.toFixed(0)} → ${despues.cx.toFixed(0)}`);
  await geo(29.0729, -110.9559, 8);

  // Esc cierra solo el mapa; Cancelar no cambia nada
  await tecla("Escape", "Escape", 27);
  await espera(250);
  check("Esc cierra solo la ventana del mapa (el formulario sigue abierto)", (await ev("document.querySelectorAll('.modal-mapa').length")) === 0 && (await ev("document.querySelectorAll('.modal').length")) === 1);
  check("al cancelar no cambian latitud ni longitud", (await val(campoLat)) === "29.072900" && (await val(campoLng)) === "-110.955900");
  await abrirMapa();
  await clic(/^Cancelar$/, ".modal-mapa button");
  await espera(200);
  check("botón Cancelar: cierra sin cambios", (await ev("document.querySelectorAll('.modal-mapa').length")) === 0 && (await val(campoLat)) === "29.072900");

  // Aceptar llena latitud, longitud y radio
  await abrirMapa();
  await escribir(".modal-mapa input[type=number]", "150");
  const lc2 = await caja(lienzo);
  await tocar(lc2.cx - 60, lc2.cy + 40);
  await espera(250);
  const elegida = await lectura();
  await clic(/^Aceptar$/, ".modal-mapa button");
  await espera(300);
  check("Aceptar llena latitud y longitud del formulario con lo elegido", (await val(campoLat)) === elegida[0].toFixed(6) && (await val(campoLng)) === elegida[1].toFixed(6), `${await val(campoLat)}, ${await val(campoLng)}`);
  check("Aceptar lleva también el radio (150 m)", (await val(campoRadio)) === "150");
  check("se informa que la ubicación se eligió en el mapa", /elegida en el mapa/.test(await texto(estado)));
  await ev("document.querySelector('.modal form').requestSubmit()");
  await hasta("window.__llamadas.some((l) => l.ruta === '/admin/sitios')");
  const env = (await llamadas("/admin/sitios"))[0]?.body;
  check("al guardar: el Worker recibe lat/lng elegidos, radio y precisión nula (no es de GPS)", env && env.lat === elegida[0] && env.lng === elegida[1] && env.radioM === 150 && env.precisionM === null, JSON.stringify(env)?.slice(0, 160));
  check("durante todo el uso del mapa no hubo violaciones de la política de seguridad", (await ev("window.__csp.length")) === 0, await ev("window.__csp.join(' | ')"));

  // ---- sitio sin coordenadas: centrado en Hermosillo, sin pin hasta tocar
  await abrirNuevoSitio();
  await inyectarCsp();
  await abrirMapa();
  const tilesH = await ev("[...document.querySelectorAll('.mapa-lienzo img.leaflet-tile')].map((i) => i.src)");
  const z = 12, tx = Math.floor(((-110.9559 + 180) / 360) * 2 ** z);
  const ty = Math.floor(((1 - Math.log(Math.tan((29.0729 * Math.PI) / 180) + 1 / Math.cos((29.0729 * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  check("sin coordenadas: el mapa se centra en Hermosillo", tilesH.some((s) => s.endsWith(`/${z}/${tx}/${ty}.png`)), `mosaico esperado ${z}/${tx}/${ty}`);
  const aceptarDeshabilitado = () => ev("[...document.querySelectorAll('.modal-mapa button')].find((b) => /^Aceptar$/.test(b.textContent)).disabled");
  check("sin coordenadas: no hay pin y «Aceptar» está deshabilitado", (await ev("document.querySelectorAll('.pin-mapa').length")) === 0 && (await aceptarDeshabilitado()) === true && /Aún no hay punto/.test(await texto(".mapa-lectura")));
  const lc3 = await caja(lienzo);
  await tocar(lc3.cx, lc3.cy);
  await espera(250);
  check("al tocar el mapa aparece el pin y se habilita «Aceptar»", (await ev("document.querySelectorAll('.pin-mapa').length")) === 1 && (await aceptarDeshabilitado()) === false);
  // celular
  await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await espera(600);
  const cel = await ev("(() => { const m = document.querySelector('.modal-mapa').getBoundingClientRect(); const l = document.querySelector('.mapa-lienzo').getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, iw: innerWidth, mr: m.right, ml: m.left, lh: l.height, lw: l.width }; })()");
  check("celular (390 px): sin desbordes horizontales y mapa de buen tamaño", cel.sw <= cel.iw && cel.mr <= cel.iw + 1 && cel.ml >= -1 && cel.lh >= 240 && cel.lw > 300, JSON.stringify(cel));
  const btnOk = await ev("(() => { const b = [...document.querySelectorAll('.modal-mapa button')].find((x) => /^Aceptar$/.test(x.textContent)); b.scrollIntoView(); const r = b.getBoundingClientRect(); return { b: r.bottom, h: r.height, w: r.width }; })()");
  check("celular: «Aceptar» alcanzable y con tamaño táctil", btnOk.b <= 800 && btnOk.h >= 44, JSON.stringify(btnOk));
  const out = ".tools/capturas-rediseno";
  mkdirSync(out, { recursive: true });
  const foto = async (nombre) => { await espera(REAL ? 2500 : 500); writeFileSync(`${out}/${nombre}.png`, Buffer.from((await cmd("Page.captureScreenshot", { format: "png" })).result.data, "base64")); };
  await ev("document.querySelector('.modal-mapa').scrollTo(0, 0)");
  await foto(REAL ? "mapa-celular-390" : "mapa-celular-390-prueba");
  await cmd("Emulation.clearDeviceMetricsOverride");

  // ================================================================ PUNTO DE RONDÍN
  await ir("/index.html?rol=admin");
  await ev("document.querySelector('[data-clave=sitios]').click()");
  await hasta("[...document.querySelectorAll('button')].some((b) => /Puntos y rondín/.test(b.textContent))");
  await clic(/Puntos y rondín/);
  await hasta("[...document.querySelectorAll('button')].some((b) => /\\+ Punto|Agregar punto|Nuevo punto/.test(b.textContent))");
  const abrioPunto = await clic(/\+ Punto|Agregar punto|Nuevo punto/);
  await hasta("!!document.querySelector('.ubicacion')");
  check("formulario de Punto: «Elegir en el mapa», enlace y «Quitar GPS»", abrioPunto
    && (await ev("[...document.querySelectorAll('.ubicacion button')].some((b) => /Elegir en el mapa/.test(b.textContent))")) === true
    && /Pegar enlace de Google Maps o coordenadas/.test(await texto(".ubicacion")) && (await ev("[...document.querySelectorAll('.ubicacion button')].some((b) => /Quitar GPS/.test(b.textContent))")) === true);
  await escribir(campoEnlace, "https://maps.google.com/?q=29.0731,-110.9561");
  await tecla("Enter", "Enter", 13);
  await espera(200);
  check("punto: el enlace llena latitud y longitud", (await val(campoLat)) === "29.073100" && (await val(campoLng)) === "-110.956100");
  await inyectarCsp();
  await abrirMapa();
  check("punto: el mapa respeta los límites de radio del campo (5 a 200 m) y arranca con 30 m", (await ev("document.querySelector('.modal-mapa input[type=number]').max")) === "200" && (await val(".modal-mapa input[type=number]")) === "30");
  await foto(REAL ? "mapa-punto-1200" : "mapa-punto-1200-prueba");
  await escribir(".modal-mapa input[type=number]", "500");
  await clic(/^Aceptar$/, ".modal-mapa button");
  await espera(300);
  check("radio fuera de rango en el mapa: no se acepta (mensaje) y la ventana sigue abierta", (await ev("document.querySelectorAll('.modal-mapa').length")) === 1 && /entre 5 y 200/.test(await texto("#toasts")));
  await escribir(".modal-mapa input[type=number]", "40");
  await clic(/^Aceptar$/, ".modal-mapa button");
  await espera(300);
  check("punto: Aceptar con radio válido (40 m)", (await ev("document.querySelectorAll('.modal-mapa').length")) === 0 && (await val(campoRadio)) === "40");
  check("después de usar el mapa no hubo violaciones de seguridad", (await ev("window.__csp.length")) === 0, await ev("window.__csp.join(' | ')"));
  check("sin excepciones de JavaScript durante toda la prueba", errores.length === 0, errores.slice(0, 2).join(" | "));
  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS DEL MAPA Y DEL ENLACE PEGADO PASARON");
  sock.close();
  process.exitCode = fallos ? 1 : 0;
} finally {
  try { spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ya terminó */ }
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
