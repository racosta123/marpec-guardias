// Estado del rondín calculado EN EL CELULAR cuando no hay conexión: usa la última copia del servidor y lo capturado
// sin enviar. Es solo una guía para el guardia; el servidor valida y decide todo al recibir los registros.

// copia: respuesta guardada de /rondines/proximo (+ plantilla de puntos). escaneos: registros en cola (tipo "rondin").
export function rondinLocal(copia, escaneos, ahoraMs) {
  const slots = copia.rondines || [];
  const plantilla = copia.plantilla || copia.actual?.puntos || null;
  if (!plantilla) return { hay: false, motivo: "sin_programa", rondines: slots };
  const modo = copia.modo || "libre";
  // El rondín que atiende un escaneo hecho en `t`: el que tenga su ventana abierta (el más cercano a su hora programada)
  const slotEn = (t) => slots.filter((x) => t >= x.abreMs && t <= x.venceMs).sort((a, b) => Math.abs(a.programadoMs - t) - Math.abs(b.programadoMs - t))[0] || null;
  const porSlot = new Map();
  for (const e of escaneos) {
    const sl = slotEn(e.horaEstimadaMs);
    if (!sl) continue;
    porSlot.set(sl.indice, [...(porSlot.get(sl.indice) || []), e]);
  }
  const hechosServidor = (indice) => new Map((copia.actual && copia.actual.indice === indice ? copia.actual.puntos : []).filter((p) => p.hecho).map((p) => [p.puntoId, p.tsMs]));
  const estadoSlot = (sl) => {
    const hechos = hechosServidor(sl.indice);
    for (const e of porSlot.get(sl.indice) || []) if (e.meta?.puntoId && !hechos.has(e.meta.puntoId)) hechos.set(e.meta.puntoId, e.horaEstimadaMs);
    const completo = plantilla.length > 0 && plantilla.every((p) => hechos.has(p.puntoId));
    return { hechos, completo };
  };
  const rondines = slots.map((sl) => {
    const { hechos, completo } = estadoSlot(sl);
    const base = copia.actual?.indice === sl.indice || porSlot.has(sl.indice);
    return { ...sl, hechos: base ? hechos.size : sl.hechos, estado: completo ? "completo" : (base && hechos.size ? "en_curso" : sl.estado) };
  });
  const vigentes = slots.filter((sl) => ahoraMs >= sl.abreMs && ahoraMs <= sl.venceMs && !["justificado"].includes(sl.estado) && !estadoSlot(sl).completo);
  const sl = vigentes.find((x) => estadoSlot(x).hechos.size > 0) || vigentes.find((x) => ahoraMs <= x.cierraInicioMs) || null;
  let actual = null;
  if (sl) {
    const { hechos } = estadoSlot(sl);
    const puntos = plantilla.map((p) => ({ ...p, hecho: hechos.has(p.puntoId), tsMs: hechos.get(p.puntoId) ?? null }));
    const sig = modo === "ordenada" ? puntos.find((p) => !p.hecho) : null;
    actual = { indice: sl.indice, programadoMs: sl.programadoMs, venceMs: sl.venceMs, estado: hechos.size ? "en_curso" : "pendiente", hechos: hechos.size, total: puntos.length, porcentaje: puntos.length ? Math.round((hechos.size / puntos.length) * 100) : 0, modo, siguientePuntoId: sig ? sig.puntoId : null, puntos };
  }
  const proximo = slots.find((x) => x.programadoMs > ahoraMs && x.indice !== sl?.indice) || null;
  return { hay: true, modo, rondines, actual, proximoMs: proximo?.programadoMs ?? null };
}


// Carga el rondín en línea (y guarda copia); sin conexión usa la copia + lo capturado y aún no enviado.
// Devuelve { r, sinRed } o lanza si no hay conexión ni copia.
export async function rondinConRespaldo(api, turnoId, { listar, metaGet, metaSet, ahoraEstimado }) {
  try {
    const r = await api(`/rondines/proximo?turnoId=${encodeURIComponent(turnoId)}`, { method: "GET" });
    const previo = await metaGet(`rondin:${turnoId}`);
    metaSet(`rondin:${turnoId}`, { ...r, plantilla: r.actual ? r.actual.puntos.map(({ puntoId, nombre, orden, descripcion, requiereGps }) => ({ puntoId, nombre, orden, descripcion, requiereGps })) : previo?.plantilla || null });
    return { r, sinRed: false };
  } catch (e) {
    if (e.status) throw e;
    const copia = await metaGet(`rondin:${turnoId}`);
    if (!copia) throw e;
    const cola = (await listar()).filter((x) => x.tipo === "rondin" && x.turnoId === turnoId && x.estado === "pendiente");
    return { r: rondinLocal(copia, cola, ahoraEstimado()), sinRed: true };
  }
}
