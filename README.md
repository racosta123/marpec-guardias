# MARPEC Guardias

PWA de control de guardias para MARPEC Seguridad Privada. **Fase 6 de 7:** acceso y roles (F1), sitios/personal/turnos (F2), entrada/salida/relevo y asistencia (F3), rondines con QR por punto (F4), incidencias, visitantes y bitácora del turno (F5), modo sin internet, botón de pánico, notificaciones push y panel en vivo (F6).

- `index.html`, `css/`, `js/`, `fonts/`, `sw.js`, `manifest.webmanifest` — frontend (HTML/CSS/JS vanilla, GitHub Pages).
- `worker/` — Cloudflare Worker `marpec-guardias-proxy` (único punto de escritura y de asignación de roles).
- `firebase/` + `firebase.json` — reglas de Firestore y Storage (denegar todo).
- `docs/` — [MODELO.md](docs/MODELO.md) (fases futuras), [SEGURIDAD.md](docs/SEGURIDAD.md), [DESPLIEGUE.md](docs/DESPLIEGUE.md).
- `tests/` y `worker/test/` — pruebas de reglas y del Worker.

```bash
npm install                 # solo herramientas de build/test
npm run build:vendor        # regenera js/vendor/firebase.js y fonts/
npm run test:worker         # pruebas del Worker (sin red; Google simulado)
npm run test:rules          # reglas con el emulador de Firebase (requiere Java)
npm run audit               # npm audit + búsqueda de secretos (árbol y historial git)
node tests/ui/fase3.cdp.mjs <url>   # interfaz de la Fase 3 en Chrome real (cámara/GPS simulados)
node tests/ui/fase4.cdp.mjs <url>   # interfaz de rondines (Fase 4) en Chrome real
node tests/ui/fase5.cdp.mjs <url>   # interfaz de incidencias, visitantes y bitácora (Fase 5)
node tests/ui/fase6.cdp.mjs <url>   # sin internet, pánico, alertas y panel en vivo (Fase 6)
node tools/serve.mjs        # servidor estático local en :5173
```

Lema: *Lealtad, Honradez, Disciplina*.
