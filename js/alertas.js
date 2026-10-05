// Alertas de pánico para supervisor y admin: sonido y aviso que NO se cierra hasta que alguien la atienda.
// Escucha en tiempo real las alertas activas (reglas: el supervisor solo recibe las de SUS sitios; el admin todas).
// Queda registrado quién la atendió y cuándo (en el Worker, inmutable).
import { collection, onSnapshot, query, where } from "./vendor/firebase.js";
import { h, limpiar, modal, poner, toast } from "./ui.js";
import { hora } from "./tz.js";

let baja = null;
let audio = null;
let sirena = null;
let titulo0 = null;
let parpadeo = null;

function sonar(on) {
  if (!on) {
    if (sirena) { clearInterval(sirena); sirena = null; }
    if (parpadeo) { clearInterval(parpadeo); parpadeo = null; if (titulo0 !== null) document.title = titulo0; }
    return;
  }
  if (!sirena) {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
    let alto = false;
    const tono = () => {
      if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
      if (!audio || audio.state !== "running") return;
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "square"; o.frequency.value = alto ? 880 : 660; alto = !alto;
      g.gain.value = 0.25;
      o.connect(g).connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.45);
    };
    audio?.resume?.().catch(() => {});
    tono();
    sirena = setInterval(tono, 600);
  }
  if (!parpadeo) {
    titulo0 = document.title;
    let on2 = false;
    parpadeo = setInterval(() => { document.title = (on2 = !on2) ? "🚨 ¡PÁNICO!" : titulo0; }, 800);
  }
}

export function iniciarAlertasPanico({ db, api, user }) {
  detenerAlertasPanico();
  const col = collection(db, "panicoVista");
  const q = user.rol === "admin" ? query(col, where("estado", "==", "activa")) : query(col, where("supervisorUid", "==", user.uid), where("estado", "==", "activa"));
  const cont = h("div", { id: "alertas-panico", class: "alertas-panico", role: "alert", "aria-live": "assertive" });
  document.body.append(cont);
  let avisoError = false;
  let ultimas = [];
  const atendidas = new Set(); // atendidas por esta sesión: se ocultan y callan al instante, sin esperar al listener

  const pintar = (todas) => {
    ultimas = todas;
    const alertas = todas.filter((x) => !atendidas.has(x.id));
    limpiar(cont);
    cont.hidden = !alertas.length;
    sonar(alertas.length > 0);
    if (!alertas.length) return;
    const sinSonido = audio && audio.state !== "running";
    poner(cont,
      sinSonido ? h("button", { class: "btn secundario", type: "button", onclick: () => { audio.resume().then(() => pintar(alertas)); } }, "🔊 Toca para activar el sonido de la alerta") : null,
      alertas.sort((a, b) => a.tsMs - b.tsMs).map((a) => h("section", { class: "alerta-panico" },
        h("h2", {}, `🚨 PÁNICO${a.prueba ? " (PRUEBA)" : ""} · ${a.sitioNombre || "Sitio sin identificar"}`),
        h("p", {}, h("b", {}, a.guardiaNombre || "Guardia"), ` · ${hora(a.tsMs)}${a.sin_conexion ? ` · capturada sin conexión, recibida ${hora(a.recibidoMs)}` : ""}`),
        a.lat != null ? h("p", { class: "sub" }, `Ubicación: ${a.lat.toFixed(5)}, ${a.lng.toFixed(5)} (±${Math.round(a.precisionM ?? 0)} m)${a.distanciaM != null ? ` · a ${Math.round(a.distanciaM)} m del puesto` : ""}`) : h("p", { class: "sub" }, "Sin ubicación (el GPS no respondió)."),
        a.sinSitio ? h("p", { class: "sub" }, "El guardia no tiene un turno vigente: la ve solo la administración.") : null,
        h("button", { class: "btn grande atender", type: "button", onclick: () => atender(a) }, "ATENDER"))));
  };

  function atender(a) {
    const nota = h("textarea", { rows: 3, maxlength: 300, placeholder: "Qué haces (opcional): voy en camino, se avisó a la patrulla…" });
    const f = h("form", { class: "form" }, h("p", {}, `Al atenderla quedará registrado que fuiste tú, con la hora. Guardia: ${a.guardiaNombre}.`), nota,
      h("button", { class: "btn primario", type: "submit" }, "Confirmar: atiendo esta alerta"));
    const m = modal("Atender alerta de pánico", f);
    document.body.lastElementChild.classList.add("sobre-alerta");
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      f.querySelector("button").disabled = true;
      try { await api("/panico/atender", { body: { id: a.id, nota: nota.value } }); toast("Alerta atendida. Quedó registrado."); m.cerrar(); atendidas.add(a.id); pintar(ultimas); }
      catch (err) { toast(err.message, "error"); if (err.code === "ya_atendida") { m.cerrar(); atendidas.add(a.id); pintar(ultimas); } else f.querySelector("button").disabled = false; }
    });
  }

  baja = onSnapshot(q, (snap) => pintar(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), () => {
    if (!avisoError) { avisoError = true; toast("No se pudo escuchar las alertas de pánico en vivo. Recarga la app.", "error"); }
  });
}

export function detenerAlertasPanico() {
  if (baja) { baja(); baja = null; }
  sonar(false);
  document.getElementById("alertas-panico")?.remove();
}
