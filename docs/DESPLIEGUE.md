# Despliegue (Fase 1)

Todo lo sensible vive como **secret del Worker**. Nada de esto va en el repo ni en el frontend.

## 1. Firebase (proyecto aislado `marpec-guardias`)

1. Crear el proyecto (si el ID no está libre, usar el más cercano y reflejarlo en `worker/wrangler.toml` y `js/config.js`).
2. Activar **Authentication → Email/Password**. Dejar desactivados Anonymous y los demás proveedores.
3. Si el plan lo permite (Identity Platform), **deshabilitar el auto-registro de usuarios**. Aun sin esto, una cuenta auto-registrada no tiene claim `rol`, las reglas la rechazan y el Worker también.
4. Crear la base **Firestore** (modo producción) y el bucket de **Storage**.
5. Registrar una app web y copiar `apiKey`, `authDomain`, `projectId` a `js/config.js` (son públicos por diseño).
6. Publicar reglas: `firebase deploy --only firestore:rules,storage --project marpec-guardias`.
7. Cuenta de servicio: *Configuración del proyecto → Cuentas de servicio → Generar clave*. **Se carga como secret y se borra del disco** (ver abajo). Rol mínimo recomendado: *Firebase Authentication Admin* + *Cloud Datastore User*.

## 2. Worker `marpec-guardias-proxy`

```bash
cd worker
npx wrangler secret put SERVICE_ACCOUNT_JSON   # pegar el JSON completo de la cuenta de servicio
npx wrangler secret put PIN_PEPPER             # cadena aleatoria >= 32 bytes (p. ej. openssl rand -base64 48)
npx wrangler secret put SETUP_TOKEN            # token aleatorio de un solo uso
npx wrangler deploy
```

> **No cambiar `PIN_PEPPER` después**: invalidaría todos los PIN guardados.

## 3. Primer admin (un solo uso)

```bash
curl -X POST https://<worker>/setup/primer-admin \
  -H "x-setup-token: <SETUP_TOKEN>" -H "content-type: application/json" \
  -d '{"nombre":"...","email":"...","password":"(mínimo 10 caracteres)"}'
```

Se reclama de forma atómica: la segunda llamada responde `404` para siempre. Después: `npx wrangler secret delete SETUP_TOKEN`.

## 4. Frontend (GitHub Pages)

- Repo `marpec-guardias`, rama `main`, Pages desde la raíz.
- `ALLOWED_ORIGIN` del Worker = `https://<usuario>.github.io` (el origen no incluye la ruta del repo).
- Al conocer la URL del Worker, ajustar `js/config.js` y reemplazar `https://*.workers.dev` en la meta CSP de `index.html` por el host exacto del Worker.

## Reconstruir lo vendorizado

`npm install && npm run build:vendor` regenera `js/vendor/firebase.js` y `fonts/` desde `node_modules` (solo desarrollo; no se carga nada de terceros en ejecución).

## Fase 2 — pasos de despliegue

1. Respaldo previo: `node tools/respaldar-firestore.mjs` (queda en `.tools/respaldos/`, ignorado por git).
2. Secret nuevo del Worker: `node tools/rotate-secrets.mjs qr` (genera `QR_SECRET` aleatorio; no se muestra).
3. Reglas e índices: `firebase deploy --only firestore --project marpec-guardias` (esperar a que los índices queden en estado *Enabled*).
4. Worker: `cd worker && npx wrangler deploy`. Frontend: push a `main` (GitHub Pages).
5. Verificación en real: `node tools/e2e-real-fase2.mjs <uid-admin>`.
6. Antes de entregar a MARPEC: `node tools/borrar-pruebas.mjs --aplicar`.

## Fase 3 — pasos de despliegue

> **Requisito previo (lo hace el dueño de la cuenta):** activar **Cloudflare R2** en https://dash.cloudflare.com → *R2 Object Storage* → «Purchase R2 Plan / Get started» (puede pedir un método de pago; el plan gratuito incluye 10 GB-mes, sin cargo mientras no se exceda). Después: `npx wrangler r2 bucket create marpec-guardias-selfies` y **no** habilitar acceso público ni dominio personalizado.

1. Respaldo previo: `node tools/respaldar-firestore.mjs`.
2. Reglas e índices: `firebase deploy --only firestore --project marpec-guardias` (esperar a que los índices nuevos de `asistencias` queden *READY*).
3. Worker (incluye el cron de 5 min y el binding R2): `cd worker && npx wrangler deploy`.
4. Frontend: push a `main` (service worker v5).
5. Verificación en real: `node tools/e2e-real-fase3.mjs <uid-admin>` (~4 min).
6. Antes de entregar a MARPEC: `node tools/borrar-pruebas.mjs --aplicar` (borra también las selfies de prueba en R2; la bitácora no se borra, sus entradas de prueba llevan `prueba=true`).

## Fase 4 — pasos de despliegue

1. Respaldo previo: `node tools/respaldar-firestore.mjs`.
2. Reglas e índices: `firebase deploy --only firestore --project marpec-guardias` (esperar a que los índices nuevos de `rondines` queden *READY*).
3. Worker (rutas nuevas y cron de rondines; el secret `QR_SECRET` y el bucket R2 ya existen): `cd worker && npx wrangler deploy`.
4. Frontend: push a `main` (service worker v6).
5. Verificación en real: `node tools/e2e-real-fase4.mjs <uid-admin>` (~8 min).
6. Antes de entregar a MARPEC: `node tools/borrar-pruebas.mjs --aplicar` (ahora también borra puntos, programas, rondines, escaneos y sus fotos de prueba en R2).

## Fase 5 — pasos de despliegue

1. Respaldo previo: `node tools/respaldar-firestore.mjs`.
2. Reglas e índices: `firebase deploy --only firestore --project marpec-guardias` (esperar a que los índices nuevos queden *READY*).
3. Worker (rutas nuevas y purga por retención en el cron; el bucket R2 y los secrets ya existen): `cd worker && npx wrangler deploy`.
4. Frontend: push a `main` (service worker v7).
5. Verificación en real: `node tools/e2e-real-fase5.mjs <uid-admin>` (~8 min; incluye la prueba de retención con el cron real).
6. Antes de entregar a MARPEC: `node tools/borrar-pruebas.mjs --aplicar` (ahora también borra incidencias, visitantes, novedades y sus fotos de prueba en R2).
7. Imprimir y colocar el cartel `aviso-visitantes.html` (borrador: requiere revisión legal y completar los datos de contacto).

## Fase 6 — pasos de despliegue

1. Respaldo previo: `node tools/respaldar-firestore.mjs`.
2. Llaves VAPID (una sola vez; **no se muestran ni se guardan en disco**): `node tools/rotate-secrets.mjs vapid`.
3. Reglas e índices: `firebase deploy --only firestore --project marpec-guardias` (esperar a que los índices nuevos queden *READY*: `panicoVista` y `offlineVista` por `supervisorUid + tsMs`).
4. Worker (rutas `/panico`, `/offline/revisar`, `/push/*`; cabecera `x-server-time`): `cd worker && npx wrangler deploy`.
5. Frontend: push a `main` (service worker v8; incluye el manejo de notificaciones).
6. Verificación en real: `node tools/e2e-real-fase6.mjs <uid-admin>`.
7. Cada supervisor/admin activa sus notificaciones en la pestaña «Alertas» (en iPhone, con la app instalada). Capturar el **teléfono de emergencia** de cada sitio (Sitios → Editar).
8. Antes de entregar a MARPEC: `node tools/borrar-pruebas.mjs --aplicar` (ahora también borra pánico, registros sin conexión, revisiones, suscripciones y marcas `pushEnviados` de prueba).

## Licencia de demostración (30 días)

`config/licencia { modo: "demo" | "produccion", inicio, vence }` la escribe SOLO el operador con `tools/licencia.mjs` (las reglas de Firestore niegan toda escritura de clientes y el Worker no tiene ninguna ruta que la toque). Fechas en hora de Hermosillo; la demo vence al **final** del día de vencimiento (23:59:59.999).

- `node tools/licencia.mjs iniciar [--dias 30] [--desde AAAA-MM-DD]` — vence al final del día (desde + N); por omisión `desde` = hoy.
- `node tools/licencia.mjs extender --dias N | --hasta AAAA-MM-DD` · `node tools/licencia.mjs produccion` (sin vencimiento) · `node tools/licencia.mjs estado`.
- Vencida (o sin documento de licencia): el Worker responde **403 `demo_vencido`** en todo menos `GET /licencia/estado` (público y mínimo), las reglas de Firestore niegan toda lectura (también corta los listeners en vivo) y el cron deja de generar alertas y notificaciones (la retención de visitantes sigue). **Los datos no se borran.**
- Aviso: de 10 días antes en adelante, banner fijo para admin y supervisores; el día en que faltan 10 días, un push al admin (una sola vez).
- **Orden de despliegue (importante):** 1) crear la licencia (`iniciar`), 2) desplegar reglas, 3) desplegar Worker, 4) frontend. Sin documento de licencia el servicio queda cerrado.
