// Agrega a firebase/firestore.indexes.json los índices de la Fase 6 (idempotente).
import { readFileSync, writeFileSync } from "node:fs";

const ruta = "firebase/firestore.indexes.json";
const ix = JSON.parse(readFileSync(ruta, "utf8"));
const nuevos = [
  ["panicoVista", "supervisorUid", "tsMs", "DESCENDING"], // historial (más reciente primero)
  ["panicoVista", "supervisorUid", "tsMs", "ASCENDING"], // panel en vivo (rango por fecha)
  ["offlineVista", "supervisorUid", "tsMs", "DESCENDING"],
  ["offlineVista", "supervisorUid", "tsMs", "ASCENDING"],
];
for (const [col, f1, f2, o2] of nuevos) {
  const ya = ix.indexes.some((i) => i.collectionGroup === col && i.fields[0].fieldPath === f1 && i.fields[1]?.fieldPath === f2 && i.fields[1].order === o2);
  if (!ya) ix.indexes.push({ collectionGroup: col, queryScope: "COLLECTION", fields: [{ fieldPath: f1, order: "ASCENDING" }, { fieldPath: f2, order: o2 }] });
}
// retira el índice que no se usa (estadoRevision se filtra en el cliente)
ix.indexes = ix.indexes.filter((i) => !(i.collectionGroup === "offlineVista" && i.fields[0].fieldPath === "estadoRevision"));
writeFileSync(ruta, JSON.stringify(ix, null, 2) + "\n");
console.log("índices totales:", ix.indexes.length);
