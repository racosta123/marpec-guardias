// Zona horaria fija: America/Hermosillo (UTC-7 todo el año, sin horario de verano).
// Mismo cálculo que el Worker; para mostrar se usa Intl con la zona explícita.
export const TZ = "America/Hermosillo";
const OFF = -7 * 3600 * 1000;
const DIA = 86400000;

const fHora = new Intl.DateTimeFormat("es-MX", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fDia = new Intl.DateTimeFormat("es-MX", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const fDiaLargo = new Intl.DateTimeFormat("es-MX", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const fFechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export const hora = (ms) => fHora.format(ms);
export const diaCorto = (ms) => fDia.format(ms);
export const diaLargo = (ms) => fDiaLargo.format(ms);
export const fechaHora = (ms) => fFechaHora.format(ms);

export const fechaLocal = (ms) => new Date(ms + OFF).toISOString().slice(0, 10);
export const hoy = () => fechaLocal(Date.now());
export const localAMs = (fecha, h = "00:00") => {
  const [y, m, d] = fecha.split("-").map(Number);
  const [hh, mm] = h.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - OFF;
};
export const sumarDias = (fecha, n) => fechaLocal(localAMs(fecha) + n * DIA);
export const lunesDe = (fecha) => {
  const dow = new Date(localAMs(fecha) + OFF).getUTCDay(); // 0=domingo
  return sumarDias(fecha, -((dow + 6) % 7));
};
export const duracionH = (a, b) => `${Math.round(((b - a) / 3600000) * 10) / 10} h`;
