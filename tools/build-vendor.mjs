import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

await build({
  entryPoints: ["tools/firebase-entry.js"],
  outfile: "js/vendor/firebase.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  legalComments: "none",
});

await build({
  entryPoints: ["tools/qr-entry.js"],
  outfile: "js/vendor/qr.js",
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2020", legalComments: "none",
});
// qrcode-generator no trae archivo LICENSE: se conserva el aviso de copyright de su cabecera (MIT).
const cab = readFileSync("node_modules/qrcode-generator/dist/qrcode.mjs", "utf8").split(/\r?\n/).slice(0, 16).join("\n");
writeFileSync(
  "js/vendor/LICENSE-qrcode-generator.txt",
  `qrcode-generator (MIT) — https://github.com/kazuhikoarase/qrcode-generator\n\n${cab}\n`,
);

await build({
  entryPoints: ["tools/jsqr-entry.js"],
  outfile: "js/vendor/jsqr.js",
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2020", legalComments: "none",
});
copyFileSync("node_modules/jsqr/LICENSE", "js/vendor/LICENSE-jsqr-Apache-2.0.txt");

// Fuentes (Inter) e íconos (Lucide): node tools/build-diseno.mjs
