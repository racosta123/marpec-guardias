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
