# Modelo de datos propuesto (fases 2–6)

> Fase 1: `usuarios`, `credenciales`, `ajustes/sistema`. **Fase 2 (implementada):** `sitios`, `turnos`, `configuracion/empresa`, `auditoria`; `usuarios` gana `sitiosAsignados`. El resto sigue siendo diseño.

## Principios (no negociables)

1. **Hora del servidor.** Todo `timestamp` de negocio lo pone el servidor (`REQUEST_TIME` en el commit del Worker). La hora del teléfono se guarda aparte, solo como dato informativo (`horaDispositivo`) para detectar relojes alterados.
2. **Registros inmutables.** Las colecciones de eventos (`asistencias`, `relevos`, `rondines`, `incidencias`, `visitantes`) permiten **solo crear**. Sin `update` ni `delete`, ni siquiera para el Worker por convención (el código del Worker no expone esas operaciones). Una corrección es un documento nuevo en `ajustes` con **motivo obligatorio y autor**, que referencia el registro original; las vistas aplican el ajuste al leer.
3. **Todo pasa por el Worker.** El cliente no escribe en Firestore. Las reglas permanecen en "denegar todo" y solo abren lecturas puntuales y acotadas por rol/sitio.
4. **Fotos en bucket privado.** Storage con reglas "denegar todo". El Worker emite URLs firmadas de subida (un solo objeto, tamaño y tipo limitados, corta vigencia) y de lectura (corta vigencia, solo a roles autorizados). La ruta incluye el id del registro; la foto no se referencia con URL pública.
5. **Mínimo dato.** Ubicación solo durante el turno; no hay rastreo continuo.

## Colecciones

| Colección | Clave | Campos principales | Quién lee (vía reglas) | Escritura |
|---|---|---|---|---|
| `usuarios` *(Fase 1)* | uid (`g-<num>` guardia; uid Auth para supervisor/admin) | nombre, rol, activo, numeroEmpleado?, email?, creadoEn | Solo el dueño | Worker (crear); cambios = ajuste |
| `credenciales` *(Fase 1)* | número de empleado | uid, hash, salt, iterations, activo | **Nadie** (solo Worker) | Worker |
| `ajustes/sistema` *(Fase 1)* | fijo | adminCreado, creadoEn | Nadie | Worker |
| `sitios` | siteId | nombre, direccion, perimetro {lat, lng, radioM} o polígono, qrKid (versión de llave), activo | supervisor/admin; guardia solo su sitio asignado | Worker (admin) |
| `turnos` | turnoId | siteId, guardiaUid, inicioProgramado, finProgramado, estado (programado/abierto/cerrado), creadoPor | guardia: los suyos; supervisor/admin: todos | Worker |
| `asistencias` | asistId | turnoId, guardiaUid, siteId, tipo (entrada/salida), ts (servidor), horaDispositivo, gps {lat,lng,precisionM}, dentroPerimetro (calculado en servidor), qrOk, fotoPath, hashPrevio | guardia: las suyas; sup/admin | Worker — **solo crear** |
| `relevos` | relevoId | siteId, turnoSaliente, turnoEntrante, ts, notas, novedades[], firmaSalienteUid, firmaEntranteUid | guardias involucrados; sup/admin | Worker — solo crear |
| `rondines` | rondinId | turnoId, guardiaUid, siteId, puntos[{puntoId, ts, qrOk, gps}], estado | guardia: los suyos; sup/admin | Worker — solo crear (cada punto es un doc hijo) |
| `incidencias` | incId | siteId, turnoId, guardiaUid, ts, tipo, severidad, descripcion, fotos[], pánico? | guardia: las suyas; sup/admin | Worker — solo crear |
| `visitantes` | visId | siteId, ts, nombre, motivo, destino, fotoIdPath?, registradoPor, salidaTs? (evento aparte) | sup/admin; guardia del sitio | Worker — solo crear |
| `ajustes` | ajusteId | refColeccion, refId, campo, valorNuevo, **motivo**, autorUid, ts | sup/admin | Worker — solo crear |
| `auditoria` | evtId | actorUid, accion, objetivo, ts, ip hash | admin | Worker — solo crear |

## QR firmado por sitio

Cada punto/sitio tiene un código QR con un payload `{siteId, puntoId, kid, nonce?}` firmado con HMAC-SHA256 (o Ed25519) usando una llave por sitio guardada **solo como secret/KV del Worker**. El teléfono envía el contenido escaneado; el Worker verifica la firma y la vigencia de `kid` (rotación = invalida los QR impresos anteriores). El QR no contiene secretos reutilizables fuera de ese sitio.

## Perímetro GPS

El teléfono envía lat/lng/precisión; **el Worker** decide `dentroPerimetro` (distancia haversine ≤ radio + tolerancia de precisión). El cliente nunca decide si está dentro. Se guardan precisión y marca de posible GPS falso (`mock` cuando el SO lo reporta) para revisión del supervisor.

## Reglas de Firestore previstas

- Siguen en `allow write: if false` en todas las colecciones.
- Lecturas: `guardia` → solo documentos con su `guardiaUid`; `supervisor` → documentos cuyo `siteId` esté en su lista de sitios (claim o doc de asignación); `admin` → todo, nunca `credenciales`.
- Las consultas deben llevar el mismo filtro que la regla (no hay `list` abierto).

## Implementación de la Fase 2 (campos reales)

- `usuarios/{uid}`: nombre, rol, activo, numeroEmpleado | email, **sitiosAsignados[]** (guardia), bajaEn, prueba?
- `sitios/{id}`: nombre, direccion, cliente, consignas, supervisorUid|null, lat|null, lng|null, precisionM|null, radioM (20–1000, def. 100), qrVersion, activo.
- `turnos/{id}`: sitioId, sitioNombre, **supervisorUid** (denormalizado para reglas), guardiaUid|null (vacante = sin cubrir), inicioMs, finMs (UTC en ms; se muestran en America/Hermosillo), plantilla (diurno, nocturno, 12x24, 24x24, personalizada), estado (programado|cancelado).
- `configuracion/empresa`: toleranciaRetardoMin, limiteFaltaMin, retardosPorFalta, zonaHoraria (solo se guarda; la usa la Fase 3).
- `auditoria/{id}`: actorUid, actorRol, actorNombre, accion, objetivo, detalle, ts (servidor). Solo se crea.
- Índices compuestos: turnos por (guardiaUid | supervisorUid | sitioId) + inicioMs (`firebase/firestore.indexes.json`).

## Implementación de la Fase 3 (campos reales)

- `marcas/{turnoId}_{entrada|salida}` — **inmutable**: turnoId, sitioId, guardiaUid, tipo, `tsMs` (hora del servidor) y `ts`, lat, lng, precisionM, distanciaM, radioM, qrVersion, fotoKey (R2), fotoBytes, horaDispositivoMs, desfaseDispositivoMs, notasEntrega (solo salida), prueba?.
- `asistencias/{turnoId}` — **resultado recalculable** por el Worker: sitio, supervisorUid, guardia (uid y nombre), inicioMs/finMs, fecha local, estado (`programado`, `por_marcar`, `en_turno`, `salida_pendiente`, `relevo_no_llego`, `cumplido`, `falta`), entradaMs/salidaMs efectivas (marca o ajuste), retardo/retardoMin, falta/motivoFalta, minutosExtra/extraEnCurso/extraEstado, relevoRequerido/relevoLlegado/relevoAlerta/puedeCerrar, resoluciones (extra y cierre) con nombre y motivo, datos para el supervisor (distancia, precisión, hay selfie) y notasEntrega.
- `ajustesAsistencia/{id}` — **inmutable**: turnoId, tipo, horaMs, horaOriginalMs, motivo, autorUid/autorNombre, tsMs. Gana el último por (turno, tipo).
- `autorizaciones/{id}` — **inmutable**: `{turno}_cierre` (cierre sin relevo) y `{turno}_extra_{n}` (autorizado/rechazado con minutos, motivo y autor). Gana la última decisión si coincide con los minutos actuales.
- `configuracion/empresa` — añade ventanaEntradaMin, toleranciaRelevoMin y `limitesExtraPorAnio: [{anio, horasSemana}]`.
- Selfies: R2 `selfies/{sitioId}/{turnoId}/{tipo}-{rand}.jpg` (bucket privado `marpec-guardias-selfies`).
- Índices: asistencias por (guardiaUid | supervisorUid | sitioId) + inicioMs.

## Implementación de la Fase 4 (campos reales)

- `puntos/{id}` — sitioId, supervisorUid (denormalizado), nombre, descripcion, orden, qrVersion, lat|null, lng|null, precisionM, radioM (5–200, def. 30), activo, prueba?.
- `programasRondin/{sitioId}` — modo (`ordenada`|`libre`), frecuencia (`{tipo:"cada_horas",cadaHoras}` o `{tipo:"horarios",horarios:["22:00",…]}`), toleranciaInicioMin (0–120), toleranciaFinMin (5–480), activo.
- `rondines/{turnoId}_{indice}` — **resultado recalculable**: sitio, supervisorUid, guardia (uid y nombre), modo, fecha local, programadoMs/abreMs/cierraInicioMs/venceMs, `requeridos` (puntos congelados), estado, iniciadoMs/finalizadoMs, hechos/total/porcentaje, faltantes, saltados, siguientePuntoId, `detalle` por punto (hora, origen escaneo|ajuste, nota, hay foto, distancia).
- `escaneos/{rondinId}_{puntoId}` — **inmutable**: turno, sitio, guardia, punto, `tsMs` (servidor) y `ts`, lat, lng, precisionM, distanciaM, nota, fotoKey (R2 `rondines/…`), horaDispositivoMs y desfase, prueba?.
- `ajustesRondin/{id}` — **inmutable**: rondinId, tipo (`marcar_punto`|`justificar_rondin`), puntoId?, motivo, autorUid/autorNombre.
- Índices: rondines por (guardiaUid | supervisorUid | sitioId) + programadoMs.

## Implementación de la Fase 5 (campos reales)

- `incidencias/{id}` — **inmutable**: sitioId, turnoId, guardiaUid/Nombre, tipoId/tipoNombre, gravedad, descripcion, `creadoMs` (servidor), lat/lng/precisionM/distanciaM, fotoKeys[≤3] (R2 `incidencias/…`), horaDispositivoMs, prueba?.
- `seguimientosIncidencia/{id}` — **inmutable**: incidenciaId, tipo (`comentario`|`estado`), estadoNuevo, texto, autorUid/Nombre/Rol, tsMs.
- `incidenciasResumen/{id}` — **recalculable**: datos de la incidencia + estado actual, `alta`, supervisorUid, nFotos y `seguimientos[]`.
- `visitantes/{id}` — **inmutable**: sitioId, turnoId, guardia, nombre, visitaA, motivo, empresa, placas, fotoKey (vehículo/placa), entradaMs, expiraMs. Sin campos de identificación.
- `salidasVisitante/{id}` — **inmutable**: visitanteId, guardiaUid, turnoId, salidaMs.
- `visitantesVista/{id}` — **recalculable**: entrada + `dentro`, salidaMs, salidaTurnoId, supervisorUid.
- `novedades/{id}` — **inmutable**: turnoId, sitioId, guardiaUid, texto, tsMs.
- `configuracion/catalogos` — `tiposIncidencia: [{id, nombre, activo}]` (no se eliminan); `configuracion/empresa` — añade `retencionVisitantesDias`.
- Índices: incidenciasResumen (guardiaUid | supervisorUid | sitioId) + creadoMs; visitantesVista (supervisorUid | sitioId) + entradaMs.
