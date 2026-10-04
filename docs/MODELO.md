# Modelo de datos propuesto (fases 2–6)

> Solo diseño. En la Fase 1 únicamente existen `usuarios`, `credenciales` y `ajustes/sistema`.

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
