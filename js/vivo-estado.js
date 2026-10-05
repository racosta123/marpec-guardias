// Estado en vivo de cada puesto (lógica pura, sin red ni DOM; se prueba en Node).
// Un puesto está: «panico» (alerta de pánico activa), «alerta» (relevo que no llegó, incidencia alta abierta, rondín no
// iniciado/incompleto reciente), «descubierto» (hay turno vigente y nadie en el puesto), «en_rondin», «cubierto» o
// «sin_turno». Todo se deduce de lo que el Worker ya calcula (asistencias, rondines, resúmenes) y llega por listeners.
const H = 3600e3;

export const ETIQUETA_ESTADO = { panico: "PÁNICO", alerta: "Alerta", descubierto: "Descubierto", en_rondin: "En rondín", cubierto: "Cubierto", sin_turno: "Sin turno ahora" };
const ORDEN = { panico: 0, alerta: 1, descubierto: 2, en_rondin: 3, cubierto: 4, sin_turno: 5 };

export function estadoPuestos({ sitios = [], turnos = [], asistencias = [], rondines = [], panicos = [], incidencias = [], offline = [], ahora }) {
  const asis = new Map(asistencias.map((a) => [a.turnoId ?? a.id, a]));
  const out = sitios.filter((s) => s.activo !== false).map((s) => {
    const deSitio = (x) => x.sitioId === s.id;
    const vigentes = turnos.filter((t) => deSitio(t) && t.estado !== "cancelado" && t.inicioMs <= ahora && (ahora < t.finMs || (asis.get(t.id)?.entradaMs && !asis.get(t.id)?.salidaMs)));
    const enTurno = vigentes.find((t) => asis.get(t.id)?.entradaMs && !asis.get(t.id)?.salidaMs) || null;
    const a = enTurno ? asis.get(enTurno.id) : null;
    const alertas = [];
    for (const p of panicos.filter((x) => deSitio(x) && x.estado === "activa")) alertas.push({ tipo: "panico", texto: `Pánico de ${p.guardiaNombre || "guardia"}`, desdeMs: p.tsMs });
    for (const x of asistencias.filter((y) => deSitio(y) && y.relevoAlerta === true && ahora - y.finMs < 12 * H)) alertas.push({ tipo: "relevo", texto: "El relevo no llegó", desdeMs: x.finMs });
    for (const i of incidencias.filter((y) => deSitio(y) && y.gravedad === "alta" && y.estado !== "cerrada" && ahora - y.creadoMs < 24 * H)) alertas.push({ tipo: "incidencia", texto: `Incidencia alta: ${i.tipoNombre || ""}`.trim(), desdeMs: i.creadoMs });
    for (const r of rondines.filter((y) => deSitio(y) && ["no_iniciado", "incompleto"].includes(y.estado) && ahora - y.venceMs < 2 * H)) alertas.push({ tipo: "rondin", texto: r.estado === "no_iniciado" ? "Rondín no iniciado" : "Rondín incompleto", desdeMs: r.venceMs });
    const enRondin = Boolean(enTurno && rondines.some((r) => r.turnoId === enTurno.id && r.estado === "en_curso"));
    let estado;
    if (alertas.some((x) => x.tipo === "panico")) estado = "panico";
    else if (alertas.length) estado = "alerta";
    else if (vigentes.length && !enTurno) estado = "descubierto";
    else if (enRondin) estado = "en_rondin";
    else if (enTurno) estado = "cubierto";
    else estado = "sin_turno";
    return {
      sitioId: s.id, nombre: s.nombre, estado, etiqueta: ETIQUETA_ESTADO[estado], alertas,
      guardia: a?.guardiaNombre || null, desdeMs: a?.entradaMs ?? null, turnoId: enTurno?.id ?? null,
      sinCubrirDesdeMs: estado === "descubierto" ? Math.min(...vigentes.map((t) => t.inicioMs)) : null,
      porRevisar: offline.filter((o) => deSitio(o) && o.estadoRevision === "pendiente").length,
    };
  });
  return out.sort((x, y) => ORDEN[x.estado] - ORDEN[y.estado] || (x.nombre || "").localeCompare(y.nombre || "", "es"));
}

// Resumen de números para la cabecera.
export function contar(puestos) {
  const n = (e) => puestos.filter((p) => p.estado === e).length;
  return { total: puestos.length, cubiertos: n("cubierto") + n("en_rondin"), descubiertos: n("descubierto"), enAlerta: n("alerta") + n("panico"), enRondin: n("en_rondin"), panicos: n("panico") };
}

// Últimos eventos mezclando todas las fuentes (más recientes primero).
export function eventosRecientes({ asistencias = [], incidencias = [], visitantes = [], panicos = [], rondines = [], ahora, horas = 24, max = 25 }) {
  const desde = ahora - horas * H;
  const ev = [];
  const add = (tsMs, tipo, texto, sitioNombre, extra = {}) => { if (tsMs && tsMs >= desde && tsMs <= ahora + 60000) ev.push({ tsMs, tipo, texto, sitioNombre: sitioNombre || "", ...extra }); };
  for (const a of asistencias) {
    add(a.entradaMs, "entrada", `${a.guardiaNombre} marcó entrada${a.retardo ? ` (retardo de ${a.retardoMin} min)` : ""}`, a.sitioNombre, { sin_conexion: a.entradaSinConexion === true });
    add(a.salidaMs, "salida", `${a.guardiaNombre} marcó salida`, a.sitioNombre, { sin_conexion: a.salidaSinConexion === true });
  }
  for (const i of incidencias) add(i.creadoMs, i.gravedad === "alta" ? "incidencia_alta" : "incidencia", `Incidencia ${i.gravedad}: ${i.tipoNombre}`, i.sitioNombre, { sin_conexion: i.sin_conexion === true });
  for (const v of visitantes) {
    add(v.entradaMs, "visitante", `Entra visitante: ${v.nombre}`, v.sitioNombre, { sin_conexion: v.sin_conexion === true });
    if (v.salidaMs) add(v.salidaMs, "visitante", `Sale visitante: ${v.nombre}`, v.sitioNombre);
  }
  for (const p of panicos) {
    add(p.tsMs, "panico", `Pánico de ${p.guardiaNombre}`, p.sitioNombre, { sin_conexion: p.sin_conexion === true });
    if (p.atendidaMs) add(p.atendidaMs, "panico_atendido", `Pánico atendido por ${p.atendidaPorNombre}`, p.sitioNombre);
  }
  for (const r of rondines) {
    if (r.estado === "completo" && r.finalizadoMs) add(r.finalizadoMs, "rondin", `Rondín completo (${r.hechos}/${r.total})`, r.sitioNombre);
    else if (["no_iniciado", "incompleto"].includes(r.estado)) add(r.venceMs, "rondin_mal", r.estado === "no_iniciado" ? "Rondín no iniciado" : `Rondín incompleto (${r.hechos}/${r.total})`, r.sitioNombre);
  }
  return ev.sort((x, y) => y.tsMs - x.tsMs).slice(0, max);
}
