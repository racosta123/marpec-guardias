// Puntos de control y programación del rondín de un sitio (admin y supervisor de ese sitio).
import { collection, doc, getDoc, getDocs, query, where } from "../vendor/firebase.js";
import { accion, campo, confirmar, h, limpiar, modal, poner, toast } from "../ui.js";

export async function vistaPuntos(raiz, ctx, sitio, volver) {
  const { db, api } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando puntos…"));
  const [snap, prog] = await Promise.all([
    getDocs(query(collection(db, "puntos"), where("sitioId", "==", sitio.id))),
    getDoc(doc(db, "programasRondin", sitio.id)),
  ]);
  const puntos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, "es"));
  const programa = prog.exists() ? prog.data() : null;
  const recargar = () => vistaPuntos(raiz, ctx, sitio, volver);

  const fila = (p, i) => h("li", { class: `item ${p.activo === false ? "baja" : ""}` },
    h("div", { class: "item-info" },
      h("strong", {}, `${p.orden}. ${p.nombre}`),
      p.descripcion ? h("span", { class: "sub" }, p.descripcion) : null,
      h("span", { class: "sub" }, p.lat == null ? "Sin GPS (basta con escanear el QR)" : `GPS: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · radio ${p.radioM} m`),
      h("span", {}, p.activo === false ? h("span", { class: "etq mal" }, "Inactivo") : null, p.prueba ? h("span", { class: "etq prueba" }, "PRUEBA") : null)),
    h("div", { class: "item-acc" },
      h("button", { class: "btn chico secundario", type: "button", "aria-label": "Subir", disabled: i === 0, onclick: () => mover(i, -1) }, "▲"),
      h("button", { class: "btn chico secundario", type: "button", "aria-label": "Bajar", disabled: i === puntos.length - 1, onclick: () => mover(i, 1) }, "▼"),
      h("button", { class: "btn chico secundario", type: "button", onclick: () => window.open(`punto-qr.html?id=${encodeURIComponent(p.id)}`, "_blank", "noopener") }, "QR"),
      h("button", { class: "btn chico secundario", type: "button", onclick: () => formPunto(p) }, "Editar"),
      h("button", { class: "btn chico peligro", type: "button", onclick: () => regenerar(p) }, "Regenerar QR")));

  const resumenPrograma = programa
    ? `${programa.modo === "ordenada" ? "Ruta ordenada" : "Ruta libre"} · ${programa.frecuencia.tipo === "cada_horas" ? `cada ${programa.frecuencia.cadaHoras} h durante el turno` : `horarios fijos: ${programa.frecuencia.horarios.join(", ")}`} · empezar ±${programa.toleranciaInicioMin} min · terminar en ${programa.toleranciaFinMin} min${programa.activo === false ? " · DESACTIVADO" : ""}`
    : "Sin programar: aún no se generan rondines en este sitio.";

  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" },
      h("h2", {}, `Rondines · ${sitio.nombre}`),
      h("div", { class: "barra-acc" }, h("button", { class: "btn chico secundario", type: "button", onclick: volver }, "← Sitios"))),
    h("section", { class: "tarjeta" },
      h("h3", {}, "Programación"),
      h("p", {}, resumenPrograma),
      h("button", { class: "btn chico primario", type: "button", onclick: formPrograma }, programa ? "Cambiar programación" : "Programar rondín")),
    h("div", { class: "barra" }, h("h3", {}, `Puntos de control (${puntos.length})`),
      h("div", { class: "barra-acc" },
        h("button", { class: "btn chico secundario", type: "button", disabled: !puntos.some((p) => p.activo !== false), onclick: () => window.open(`punto-qr.html?sitio=${encodeURIComponent(sitio.id)}`, "_blank", "noopener") }, "🖨 Hoja de QR"),
        h("button", { class: "btn chico primario", type: "button", onclick: () => formPunto(null) }, "+ Punto"))),
    puntos.length ? h("ul", { class: "lista" }, puntos.map(fila)) : h("p", { class: "vacio" }, "Aún no hay puntos. Agrega los lugares que el guardia debe recorrer."),
    h("p", { class: "ayuda" }, "Cada punto tiene su propio QR firmado (distinto al QR de asistencia). Si regeneras un QR, el impreso deja de funcionar."));

  // Reordena y renumera 1..n (solo actualiza los puntos cuyo número cambia)
  async function mover(i, d) {
    const lista = [...puntos];
    const j = i + d;
    if (j < 0 || j >= lista.length) return;
    [lista[i], lista[j]] = [lista[j], lista[i]];
    for (let k = 0; k < lista.length; k++) {
      if (lista[k].orden === k + 1) continue;
      const r = await accion(null, () => api("/admin/puntos/actualizar", { body: { id: lista[k].id, orden: k + 1 } }));
      if (!r) break;
    }
    recargar();
  }

  async function regenerar(p) {
    if (!(await confirmar("Regenerar QR", `El QR impreso de «${p.nombre}» dejará de funcionar; tendrás que imprimir y colocar uno nuevo.`, "Regenerar", true))) return;
    const r = await accion(null, () => api("/admin/puntos/regenerar-qr", { body: { id: p.id } }), "QR regenerado. El anterior ya no es válido.");
    if (r) recargar();
  }

  function formPunto(p) {
    const edit = Boolean(p);
    const nombre = h("input", { type: "text", maxlength: 80, value: p?.nombre || "", required: true });
    const desc = h("input", { type: "text", maxlength: 300, value: p?.descripcion || "" });
    const lat = h("input", { type: "text", inputmode: "decimal", value: p?.lat ?? "", placeholder: "29.07290" });
    const lng = h("input", { type: "text", inputmode: "decimal", value: p?.lng ?? "", placeholder: "-110.95590" });
    const radio = h("input", { type: "number", min: 5, max: 200, step: 1, value: p?.radioM ?? 30, required: true });
    const activo = h("input", { type: "checkbox", checked: p ? p.activo !== false : true });
    let precision = p?.precisionM ?? null;
    const estadoGps = h("small", { class: "ayuda", role: "status" }, "Opcional: si capturas la ubicación, el guardia deberá estar dentro del radio al escanear.");
    const btnGps = h("button", { class: "btn secundario", type: "button" }, "📍 Usar mi ubicación actual");
    btnGps.addEventListener("click", () => {
      if (!navigator.geolocation) { estadoGps.textContent = "Este dispositivo no ofrece GPS."; return; }
      btnGps.disabled = true;
      estadoGps.textContent = "Obteniendo ubicación…";
      navigator.geolocation.getCurrentPosition((pos) => {
        lat.value = pos.coords.latitude.toFixed(6); lng.value = pos.coords.longitude.toFixed(6); precision = pos.coords.accuracy;
        estadoGps.textContent = `Capturada con precisión de ±${Math.round(precision)} m${precision > 25 ? " — mejor acércate a cielo abierto y repite" : ""}.`;
        btnGps.disabled = false;
      }, (err) => { estadoGps.textContent = err.code === 1 ? "Permiso de ubicación denegado." : "No se pudo obtener la ubicación."; btnGps.disabled = false; }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
    lat.addEventListener("input", () => { precision = null; });
    lng.addEventListener("input", () => { precision = null; });
    const quitarGps = h("button", { class: "btn chico secundario", type: "button", onclick: () => { lat.value = ""; lng.value = ""; precision = null; estadoGps.textContent = "Sin GPS: bastará escanear el QR."; } }, "Quitar GPS");
    const f = h("form", { class: "form", novalidate: true },
      campo("Nombre del punto", nombre), campo("Descripción (dónde está)", desc),
      h("fieldset", { class: "ubicacion" }, h("legend", {}, "GPS del punto (opcional)"), btnGps, quitarGps, estadoGps,
        h("div", { class: "dos" }, campo("Latitud", lat), campo("Longitud", lng)),
        campo("Radio (metros)", radio, "Por defecto 30 m (5 a 200).")),
      edit ? h("label", { class: "check" }, activo, " Punto activo") : null,
      h("button", { class: "btn primario", type: "submit" }, edit ? "Guardar" : "Agregar punto"));
    const m = modal(edit ? `Editar: ${p.nombre}` : "Nuevo punto", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { nombre: nombre.value, descripcion: desc.value, radioM: Number(radio.value) };
      const la = lat.value.trim(), lo = lng.value.trim();
      if (la || lo) {
        const a = Number(la.replace(",", ".")), b = Number(lo.replace(",", "."));
        if (!la || !lo || !Number.isFinite(a) || !Number.isFinite(b)) { toast("Captura latitud y longitud válidas, o deja ambas vacías.", "error"); return; }
        Object.assign(body, { lat: a, lng: b, precisionM: precision });
      } else if (edit) Object.assign(body, { lat: null, lng: null });
      if (edit) { body.id = p.id; body.activo = activo.checked; } else body.sitioId = sitio.id;
      const r = await accion(f.querySelector("button[type=submit]"), () => api(edit ? "/admin/puntos/actualizar" : "/admin/puntos", { body }), edit ? "Punto actualizado." : "Punto agregado.");
      if (r) { m.cerrar(); recargar(); }
    });
  }

  function formPrograma() {
    const p = programa || { modo: "libre", frecuencia: { tipo: "cada_horas", cadaHoras: 2 }, toleranciaInicioMin: 15, toleranciaFinMin: 45, activo: true };
    const modo = h("select", { value: p.modo }, h("option", { value: "libre" }, "Ruta libre (cualquier orden)"), h("option", { value: "ordenada" }, "Ruta ordenada (en el orden de la lista)"));
    const tipo = h("select", { value: p.frecuencia.tipo }, h("option", { value: "cada_horas" }, "Cada X horas durante el turno"), h("option", { value: "horarios" }, "Horarios fijos"));
    const horas = h("input", { type: "number", min: 0.5, max: 24, step: 0.5, value: p.frecuencia.cadaHoras ?? 2 });
    const horarios = h("input", { type: "text", value: (p.frecuencia.horarios || ["22:00", "02:00"]).join(", "), placeholder: "22:00, 02:00, 05:00" });
    const ti = h("input", { type: "number", min: 0, max: 120, step: 1, value: p.toleranciaInicioMin, required: true });
    const tf = h("input", { type: "number", min: 5, max: 480, step: 1, value: p.toleranciaFinMin, required: true });
    const activo = h("input", { type: "checkbox", checked: p.activo !== false });
    const cHoras = campo("Cada cuántas horas", horas, "El primero cae X horas después del inicio del turno.");
    const cHorarios = campo("Horarios (HH:MM, separados por coma; hora de Hermosillo)", horarios);
    const ajusta = () => { cHoras.hidden = tipo.value !== "cada_horas"; cHorarios.hidden = tipo.value !== "horarios"; };
    tipo.addEventListener("change", ajusta);
    const f = h("form", { class: "form", novalidate: true },
      campo("Modo", modo), campo("Frecuencia", tipo), cHoras, cHorarios,
      h("div", { class: "dos" }, campo("Tolerancia para empezar (min)", ti, "Puede iniciar desde X min antes hasta X min después de la hora."), campo("Plazo para terminar (min)", tf, "Debe quedar completo X min después de la hora programada.")),
      h("label", { class: "check" }, activo, " Programación activa"),
      h("button", { class: "btn primario", type: "submit" }, "Guardar programación"));
    ajusta();
    const m = modal("Programación del rondín", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const frecuencia = tipo.value === "cada_horas" ? { tipo: "cada_horas", cadaHoras: Number(horas.value) }
        : { tipo: "horarios", horarios: horarios.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) };
      const r = await accion(f.querySelector("button[type=submit]"), () => api("/rondines/programa", { body: { sitioId: sitio.id, modo: modo.value, frecuencia, toleranciaInicioMin: Number(ti.value), toleranciaFinMin: Number(tf.value), activo: activo.checked } }), "Programación guardada.");
      if (r) { m.cerrar(); recargar(); }
    });
  }
}
