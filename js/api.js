// Cliente del Worker. Toda escritura pasa por aquí; el cliente nunca escribe en Firestore.
import { config } from "./config.js";

const MENSAJES = {
  unauthorized: "Tu sesión expiró. Vuelve a entrar.",
  forbidden: "No tienes permiso para esta acción.",
  not_found: "No se encontró el registro.",
  exists: "Ya existe un registro con esos datos.",
  empalme: "El guardia ya tiene un turno que se empalma.",
  turno_iniciado: "El turno ya inició o terminó.",
  turno_no_modificable: "El turno ya no se puede modificar.",
  qr_invalido: "Código QR no válido.",
  too_large: "La solicitud es demasiado grande.",
  internal: "Error del servidor. Intenta de nuevo.",
};

export function crearApi(auth) {
  return async function api(ruta, { method = "POST", body } = {}) {
    const user = auth.currentUser;
    if (!user) throw Object.assign(new Error(MENSAJES.unauthorized), { status: 401 });
    const token = await user.getIdToken();
    let res;
    try {
      res = await fetch(`${config.workerUrl}${ruta}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new Error("No fue posible conectar. Revisa tu conexión.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.mensaje || MENSAJES[data.error] || "No se pudo completar la acción."), { status: res.status, code: data.error });
    return data;
  };
}
