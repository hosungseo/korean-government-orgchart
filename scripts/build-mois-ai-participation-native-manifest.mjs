import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMoisAiParticipationNativeManifest } from "../src/hwp-native-manifest.mjs";

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.resolve(
  repositoryDirectory,
  process.argv[2] || "desktop/src-tauri/resources/mois-ai-participation-left.native.json",
);
const manifest = buildMoisAiParticipationNativeManifest();

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(outputPath);
