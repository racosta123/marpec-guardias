// Personal (solo admin): altas, ediciones, bajas y PIN.
import { collection, getDocs } from "../vendor/firebase.js";
import { accion, campo, confirmar, h, limpiar, modal, toast, poner } from "../ui.js";
import { config } from "../config.js";

function claveAleatoria() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "x") + "aA1";
}

export async function vistaPersonal(raiz, { db, api }) {
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando personal…"));
  const snap = await getDocs(collection(db, "usuarios"));
  const personas = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((p) => p.rol !== "admin")
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
  const recargar = () => vistaPersonal(raiz, { db, api });

  const fila = (p) => h("li", { class: `item ${p.activo ? "" : "baja"}` },
    h("div", { class: "item-info" },
      h("strong", {}, p.nombre),
      h("span", { class: "sub" }, p.rol === "guardia" ? `Empleado ${p.numeroEmpleado}` : p.email),
      h("span", {},
        h("span", { class: `etq ${p.activo ? "ok" : "mal"}` }, p.activo ? "Activo" : "Baja"),
        p.prueba ? h("span", { class: "etq prueba" }, "PRUEBA") : null)),
    h("div", { class: "item-acc" },
      h("button", { class: "btn chico secundario", type: "button", onclick: () => formEditar(p) }, "Editar"),
      p.rol === "guardia" ? h("button", { class: "btn chico secundario", type: "button", onclick: () => formPin(p) }, "PIN") : null,
      p.activo
        ? h("button", { class: "btn chico peligro", type: "button", onclick: () => baja(p) }, "Dar de baja")
        : h("button", { class: "btn chico secundario", type: "button", onclick: (e) => reactivar(p, e.currentTarget) }, "Reactivar")));

  const lista = (titulo, items, vacio) => h("section", { class: "bloque" }, h("h3", {}, titulo),
    items.length ? h("ul", { class: "lista" }, items.map(fila)) : h("p", { class: "vacio" }, vacio));

  limpiar(raiz);
  poner(raiz, 
    h("div", { class: "barra" },
      h("h2", {}, "Personal"),
      h("div", { class: "barra-acc" },
        h("button", { class: "btn chico primario", type: "button", onclick: formGuardia }, "+ Guardia"),
        h("button", { class: "btn chico primario", type: "button", onclick: formSupervisor }, "+ Supervisor"))),
    lista("Guardias", personas.filter((p) => p.rol === "guardia"), "Aún no hay guardias."),
    lista("Supervisores", personas.filter((p) => p.rol === "supervisor"), "Aún no hay supervisores."));

  // ---- formularios ----
  function formGuardia() {
    const numero = h("input", { type: "text", maxlength: 12, autocapitalize: "characters", autocomplete: "off", required: true });
    const nombre = h("input", { type: "text", maxlength: 80, required: true });
    const pin = h("input", { type: "password", inputmode: "numeric", maxlength: 6, autocomplete: "new-password", required: true });
    const f = h("form", { class: "form", novalidate: true },
      campo("Número de empleado", numero, "3 a 12 letras o números."), campo("Nombre completo", nombre),
      campo("PIN inicial", pin, "4 a 6 dígitos. Entrégaselo al guardia en persona."),
      h("button", { class: "btn primario", type: "submit" }, "Dar de alta"));
    const m = modal("Nuevo guardia", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await accion(f.querySelector("button"), () => api("/admin/usuarios", { body: { rol: "guardia", nombre: nombre.value, numeroEmpleado: numero.value, pin: pin.value } }), "Guardia dado de alta.");
      if (r) { m.cerrar(); recargar(); }
    });
  }

  function formSupervisor() {
    const nombre = h("input", { type: "text", maxlength: 80, required: true });
    const email = h("input", { type: "email", autocomplete: "off", required: true });
    const f = h("form", { class: "form", novalidate: true },
      campo("Nombre completo", nombre), campo("Correo", email, "Se le enviará un enlace oficial de Firebase para que defina su propia contraseña."),
      h("button", { class: "btn primario", type: "submit" }, "Dar de alta y enviar enlace"));
    const m = modal("Nuevo supervisor", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await accion(f.querySelector("button"), () => api("/admin/usuarios", { body: { rol: "supervisor", nombre: nombre.value, email: email.value, password: claveAleatoria() } }));
      if (!r) return;
      // Contraseña temporal aleatoria que nadie ve: el supervisor la define desde el correo de Firebase.
      const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(config.firebase.apiKey)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestType: "PASSWORD_RESET", email: email.value.trim().toLowerCase() }) }).catch(() => null);
      toast(res && res.ok ? "Supervisor dado de alta. Se envió el enlace para definir su contraseña." : "Supervisor dado de alta, pero no se pudo enviar el correo; usa «Restablecer contraseña» desde la consola de Firebase.", res && res.ok ? "ok" : "error");
      m.cerrar();
      recargar();
    });
  }

  function formEditar(p) {
    const nombre = h("input", { type: "text", maxlength: 80, value: p.nombre, required: true });
    const email = h("input", { type: "email", value: p.email || "", required: true });
    const f = h("form", { class: "form", novalidate: true },
      campo("Nombre completo", nombre),
      p.rol === "supervisor" ? campo("Correo", email) : null,
      h("button", { class: "btn primario", type: "submit" }, "Guardar"));
    const m = modal(`Editar: ${p.nombre}`, f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { uid: p.uid, nombre: nombre.value };
      if (p.rol === "supervisor") body.email = email.value;
      const r = await accion(f.querySelector("button"), () => api("/admin/usuarios/actualizar", { body }), "Cambios guardados.");
      if (r) { m.cerrar(); recargar(); }
    });
  }

  function formPin(p) {
    const pin = h("input", { type: "password", inputmode: "numeric", maxlength: 6, autocomplete: "new-password" });
    const cont = h("div", { class: "form" },
      campo("Nuevo PIN", pin, "4 a 6 dígitos. También desbloquea el acceso."),
      h("button", { class: "btn primario", type: "button", onclick: async (e) => {
        const r = await accion(e.currentTarget, () => api("/admin/usuarios/restablecer-pin", { body: { numero: p.numeroEmpleado, pin: pin.value } }), "PIN restablecido.");
        if (r) m.cerrar();
      } }, "Restablecer PIN"),
      h("hr"),
      h("p", { class: "ayuda" }, "Tras 5 intentos fallidos el acceso se bloquea 15 minutos."),
      h("button", { class: "btn secundario", type: "button", onclick: async (e) => {
        const r = await accion(e.currentTarget, () => api("/admin/usuarios/desbloquear-pin", { body: { numero: p.numeroEmpleado } }), "PIN desbloqueado.");
        if (r) m.cerrar();
      } }, "Desbloquear sin cambiar el PIN"));
    const m = modal(`PIN de ${p.nombre}`, cont);
  }

  async function baja(p) {
    const ok = await confirmar("Dar de baja", `${p.nombre} perderá el acceso de inmediato, se cerrarán sus sesiones y sus turnos futuros quedarán sin cubrir.`, "Dar de baja", true);
    if (!ok) return;
    const r = await accion(null, () => api("/admin/usuarios/baja", { body: { uid: p.uid } }), "Baja registrada. Acceso revocado.");
    if (r) recargar();
  }

  async function reactivar(p, boton) {
    const r = await accion(boton, () => api("/admin/usuarios/reactivar", { body: { uid: p.uid } }), "Cuenta reactivada.");
    if (r) recargar();
  }
}
