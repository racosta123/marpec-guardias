// Sitios: el admin los crea y edita; el supervisor solo ve los suyos.
import { collection, getDocs, query, where } from "../vendor/firebase.js";
import { vistaPuntos } from "./puntos.js";
import { accion, campo, confirmar, h, limpiar, modal, toast, poner } from "../ui.js";

export async function cargarSitios({ db, user }) {
  const col = collection(db, "sitios");
  const q = user.rol === "admin" ? col : query(col, where("supervisorUid", "==", user.uid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
}

export async function cargarSupervisores(db) {
  const snap = await getDocs(collection(db, "usuarios"));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((u) => u.rol === "supervisor" && u.activo);
}

export async function vistaSitios(raiz, ctx) {
  const { db, api, user } = ctx;
  const esAdmin = user.rol === "admin";
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando sitios…"));
  const [sitios, supervisores] = await Promise.all([cargarSitios(ctx), esAdmin ? cargarSupervisores(db) : []]);
  const nombreSup = (uid) => supervisores.find((s) => s.uid === uid)?.nombre || (uid ? "Supervisor asignado" : "Sin supervisor");
  const recargar = () => vistaSitios(raiz, ctx);
  const verQr = (s) => window.open(`qr.html?id=${encodeURIComponent(s.id)}`, "_blank", "noopener");

  const tarjeta = (s) => h("li", { class: `item sitio ${s.activo === false ? "baja" : ""}` },
    h("div", { class: "item-info" },
      h("strong", {}, s.nombre),
      h("span", { class: "sub" }, [s.cliente, s.direccion].filter(Boolean).join(" · ") || "Sin dirección"),
      esAdmin ? h("span", { class: "sub" }, `Supervisor: ${nombreSup(s.supervisorUid)}`) : null,
      h("span", { class: "sub" }, s.lat == null ? "Ubicación: sin capturar" : `Ubicación: ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}${s.precisionM != null ? ` (±${Math.round(s.precisionM)} m)` : ""} · Radio ${s.radioM} m`),
      s.consignas ? h("p", { class: "consignas" }, h("b", {}, "Consignas: "), s.consignas) : null,
      s.activo === false ? h("span", { class: "etq mal" }, "Inactivo") : null),
    h("div", { class: "item-acc" },
      h("button", { class: "btn chico secundario", type: "button", onclick: () => verQr(s) }, "QR de asistencia"),
      h("button", { class: "btn chico primario", type: "button", onclick: () => vistaPuntos(raiz, ctx, s, recargar) }, "Puntos y rondín"),
      esAdmin ? h("button", { class: "btn chico secundario", type: "button", onclick: () => formSitio(s) }, "Editar") : null,
      esAdmin ? h("button", { class: "btn chico peligro", type: "button", onclick: () => regenerar(s) }, "Regenerar QR") : null));

  limpiar(raiz);
  poner(raiz, 
    h("div", { class: "barra" }, h("h2", {}, esAdmin ? "Sitios" : "Mis sitios"),
      esAdmin ? h("div", { class: "barra-acc" }, h("button", { class: "btn chico primario", type: "button", onclick: () => formSitio(null) }, "+ Sitio")) : null),
    sitios.length ? h("ul", { class: "lista" }, sitios.map(tarjeta))
      : h("p", { class: "vacio" }, esAdmin ? "Aún no hay sitios." : "No tienes sitios asignados."));

  async function regenerar(s) {
    const ok = await confirmar("Regenerar QR", `El QR impreso de «${s.nombre}» dejará de funcionar y tendrás que imprimir y colocar uno nuevo.`, "Regenerar", true);
    if (!ok) return;
    const r = await accion(null, () => api("/admin/sitios/regenerar-qr", { body: { id: s.id } }), "QR regenerado. El anterior ya no es válido.");
    if (r) recargar();
  }

  function formSitio(s) {
    const edit = Boolean(s);
    const nombre = h("input", { type: "text", maxlength: 80, value: s?.nombre || "", required: true });
    const cliente = h("input", { type: "text", maxlength: 80, value: s?.cliente || "" });
    const direccion = h("input", { type: "text", maxlength: 200, value: s?.direccion || "" });
    const sup = h("select", { value: s?.supervisorUid || "" },
      h("option", { value: "" }, "— Sin supervisor —"),
      supervisores.map((x) => h("option", { value: x.uid }, x.nombre)));
    const consignas = h("textarea", { rows: 5, maxlength: 2000 }, s?.consignas || "");
    const lat = h("input", { type: "text", inputmode: "decimal", value: s?.lat ?? "", placeholder: "29.07290" });
    const lng = h("input", { type: "text", inputmode: "decimal", value: s?.lng ?? "", placeholder: "-110.95590" });
    const radio = h("input", { type: "number", min: 20, max: 1000, step: 1, value: s?.radioM ?? 100, required: true });
    const activo = h("input", { type: "checkbox", checked: s ? s.activo !== false : true });
    let precision = s?.precisionM ?? null;
    const estadoGps = h("small", { class: "ayuda", role: "status" }, precision != null ? `Última precisión capturada: ±${Math.round(precision)} m` : "Puedes capturarla con el GPS de este dispositivo o escribirla a mano.");

    const btnGps = h("button", { class: "btn secundario", type: "button" }, "📍 Usar mi ubicación actual");
    btnGps.addEventListener("click", () => {
      if (!navigator.geolocation) { estadoGps.textContent = "Este dispositivo no ofrece GPS."; return; }
      btnGps.disabled = true;
      estadoGps.textContent = "Obteniendo ubicación…";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lat.value = pos.coords.latitude.toFixed(6);
          lng.value = pos.coords.longitude.toFixed(6);
          precision = pos.coords.accuracy;
          const mala = precision > 50 ? " — precisión baja; acércate a cielo abierto y vuelve a intentar." : "";
          estadoGps.textContent = `Ubicación capturada con precisión de ±${Math.round(precision)} m${mala}`;
          btnGps.disabled = false;
        },
        (err) => {
          estadoGps.textContent = err.code === 1 ? "Permiso de ubicación denegado. Escribe las coordenadas a mano." : "No se pudo obtener la ubicación. Intenta de nuevo o escríbela a mano.";
          btnGps.disabled = false;
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
    lat.addEventListener("input", () => { precision = null; });
    lng.addEventListener("input", () => { precision = null; });

    const f = h("form", { class: "form", novalidate: true },
      campo("Nombre del sitio", nombre), campo("Cliente", cliente), campo("Dirección", direccion),
      campo("Supervisor asignado", sup), campo("Consignas del puesto", consignas, "Lo verá el guardia al iniciar su turno."),
      h("fieldset", { class: "ubicacion" }, h("legend", {}, "Ubicación y perímetro"),
        btnGps, estadoGps,
        h("div", { class: "dos" }, campo("Latitud", lat), campo("Longitud", lng)),
        campo("Radio del perímetro (metros)", radio, "Por defecto 100 m. Entre 20 y 1000.")),
      edit ? h("label", { class: "check" }, activo, " Sitio activo") : null,
      h("button", { class: "btn primario", type: "submit" }, edit ? "Guardar cambios" : "Crear sitio"));
    const m = modal(edit ? `Editar: ${s.nombre}` : "Nuevo sitio", f);

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { nombre: nombre.value, cliente: cliente.value, direccion: direccion.value, consignas: consignas.value, supervisorUid: sup.value || null, radioM: Number(radio.value) };
      const la = lat.value.trim(), lo = lng.value.trim();
      if (la || lo) {
        const nla = Number(la.replace(",", ".")), nlo = Number(lo.replace(",", "."));
        if (!la || !lo || !Number.isFinite(nla) || !Number.isFinite(nlo)) { toast("Captura latitud y longitud válidas, o deja ambas vacías.", "error"); return; }
        Object.assign(body, { lat: nla, lng: nlo, precisionM: precision });
      } else if (edit) Object.assign(body, { lat: null, lng: null });
      if (edit) { body.id = s.id; body.activo = activo.checked; }
      const r = await accion(f.querySelector("button[type=submit]"), () => api(edit ? "/admin/sitios/actualizar" : "/admin/sitios", { body }), edit ? "Sitio actualizado." : "Sitio creado.");
      if (r) { m.cerrar(); recargar(); }
    });
  }
}
