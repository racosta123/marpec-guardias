// Utilidades compartidas de la Fase 5: turno activo del guardia y esquemas estrictos de entrada.
import { bad } from "../common.js";
import { HttpError, getDocument } from "../google.js";

// Guardia con turno propio, programado, con entrada marcada y sin salida (mismo criterio que los rondines).
export async function turnoActivoDelGuardia(env, actor, turnoId) {
  const turno = await getDocument(env, `turnos/${turnoId}`);
  if (!turno || turno.guardiaUid !== actor.uid) throw new HttpError(403, "forbidden", "Este turno no es tuyo.");
  if (turno.estado !== "programado") throw new HttpError(409, "sin_turno_activo", "Este turno ya no está activo.");
  if (!(await getDocument(env, `marcas/${turnoId}_entrada`))) throw new HttpError(409, "sin_entrada", "Primero debes marcar tu entrada.");
  if (await getDocument(env, `marcas/${turnoId}_salida`)) throw new HttpError(409, "sin_turno_activo", "Ya cerraste tu turno.");
  const sitio = await getDocument(env, `sitios/${turno.sitioId}`);
  if (!sitio || sitio.activo === false) throw new HttpError(409, "sin_turno_activo", "El sitio no está activo.");
  return { turno, sitio };
}

// Esquema estricto: cualquier campo no listado se rechaza (así no existe forma de enviar identificaciones u otros datos).
export function soloCampos(body, permitidos) {
  for (const k of Object.keys(body)) if (!permitidos.includes(k)) throw bad(`Campo no permitido: ${String(k).slice(0, 30)}.`);
}

export function enumerado(v, campo, valores) {
  if (typeof v !== "string" || !valores.includes(v)) throw bad(`${campo}: ${valores.join(", ")}.`);
  return v;
}

// Acceso de supervisor/admin a un sitio (supervisor actual del sitio).
export async function sitioParaGestion(env, actor, sitioId) {
  const s = await getDocument(env, `sitios/${sitioId}`);
  if (!s) throw new HttpError(404, "not_found");
  if (actor.rol === "supervisor" && s.supervisorUid !== actor.uid) throw new HttpError(403, "forbidden");
  return s;
}
