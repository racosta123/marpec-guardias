// Lógica pura de turnos (sin red): plantillas, generación y empalmes. Hora de Hermosillo (UTC-7 fijo).
import { bad, localAMs, RE_FECHA, RE_HORA } from "./common.js";

const H = 3600 * 1000;
const DIA = 24 * H;

export const PLANTILLAS = {
  diurno: { etiqueta: "Diurno 07:00–19:00" },
  nocturno: { etiqueta: "Nocturno 19:00–07:00" },
  "12x24": { etiqueta: "12x24 (12 h de trabajo, 24 h de descanso)" },
  "24x24": { etiqueta: "24x24 (24 h de trabajo, 24 h de descanso)" },
  personalizada: { etiqueta: "Personalizada" },
};

export const MAX_DIAS = 62;
export const MAX_TURNOS = 100;

// Devuelve [{ inicioMs, finMs }] para el rango de fechas locales [desde, hasta].
export function generarTurnos({ plantilla, desde, hasta, horaInicio, horaFin }) {
  if (!PLANTILLAS[plantilla]) throw bad("Plantilla inválida.");
  if (!RE_FECHA.test(desde || "") || !RE_FECHA.test(hasta || "")) throw bad("Fechas inválidas (AAAA-MM-DD).");
  const d0 = localAMs(desde, "00:00");
  const d1 = localAMs(hasta, "00:00");
  if (d1 < d0) throw bad("La fecha final es anterior a la inicial.");
  const dias = Math.round((d1 - d0) / DIA) + 1;
  if (dias > MAX_DIAS) throw bad(`El rango máximo es de ${MAX_DIAS} días.`);

  const out = [];
  if (plantilla === "12x24" || plantilla === "24x24") {
    const hi = horaInicio === undefined ? "07:00" : horaInicio;
    if (!RE_HORA.test(hi)) throw bad("Hora de inicio inválida (HH:MM).");
    const dur = plantilla === "12x24" ? 12 * H : 24 * H;
    const ciclo = plantilla === "12x24" ? 36 * H : 48 * H;
    for (let ini = localAMs(desde, hi); ini < d1 + DIA; ini += ciclo) out.push({ inicioMs: ini, finMs: ini + dur });
  } else {
    let hi, hf;
    if (plantilla === "diurno") [hi, hf] = ["07:00", "19:00"];
    else if (plantilla === "nocturno") [hi, hf] = ["19:00", "07:00"];
    else {
      hi = horaInicio;
      hf = horaFin;
      if (!RE_HORA.test(hi || "") || !RE_HORA.test(hf || "")) throw bad("Horas inválidas (HH:MM).");
      if (hi === hf) throw bad("La hora de inicio y fin no pueden ser iguales.");
    }
    for (let i = 0; i < dias; i++) {
      const dia = d0 + i * DIA;
      const ini = dia + Number(hi.slice(0, 2)) * H + Number(hi.slice(3)) * 60000;
      let fin = dia + Number(hf.slice(0, 2)) * H + Number(hf.slice(3)) * 60000;
      if (fin <= ini) fin += DIA; // cruza medianoche
      out.push({ inicioMs: ini, finMs: fin });
    }
  }
  if (out.length > MAX_TURNOS) throw bad(`Máximo ${MAX_TURNOS} turnos por operación.`);
  if (out.length === 0) throw bad("El rango no genera turnos.");
  return out;
}

// Dos intervalos [inicio, fin) se empalman si cada uno empieza antes de que el otro termine.
export const seEmpalman = (a, b) => a.inicioMs < b.finMs && b.inicioMs < a.finMs;

// Busca empalmes de `nuevos` contra `existentes` y entre sí. Devuelve el primero encontrado o null.
export function primerEmpalme(nuevos, existentes) {
  for (let i = 0; i < nuevos.length; i++) {
    for (const e of existentes) if (seEmpalman(nuevos[i], e)) return { nuevo: nuevos[i], con: e };
    for (let j = i + 1; j < nuevos.length; j++) if (seEmpalman(nuevos[i], nuevos[j])) return { nuevo: nuevos[i], con: nuevos[j] };
  }
  return null;
}
