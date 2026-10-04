# MARPEC Guardias

PWA de control de guardias para MARPEC Seguridad Privada. **Fase 1 de 6: base segura** (estructura, acceso y roles).

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
node tools/serve.mjs        # servidor estático local en :5173
```

Lema: *Lealtad, Honradez, Disciplina*.
