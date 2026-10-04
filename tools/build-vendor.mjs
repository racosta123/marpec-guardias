import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

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

mkdirSync("fonts", { recursive: true });
const f = "node_modules/@fontsource";
for (const w of [400, 500, 600, 700])
  copyFileSync(`${f}/barlow/files/barlow-latin-${w}-normal.woff2`, `fonts/barlow-${w}.woff2`);
for (const w of [600, 700])
  copyFileSync(`${f}/barlow-condensed/files/barlow-condensed-latin-${w}-normal.woff2`, `fonts/barlow-condensed-${w}.woff2`);
copyFileSync(`${f}/barlow/LICENSE`, "fonts/LICENSE-Barlow-OFL.txt");
console.log("vendor listo");
