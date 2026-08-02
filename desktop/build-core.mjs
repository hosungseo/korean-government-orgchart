import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [bunTarget = "bun-windows-x64", rustTarget = "x86_64-pc-windows-msvc"] = process.argv.slice(2);
const extension = bunTarget.includes("windows") ? ".exe" : "";
const output = path.resolve("desktop", "src-tauri", "binaries", `orgchart-core-${rustTarget}${extension}`);

fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(
  "bun",
  ["build", "--compile", "--minify", `--target=${bunTarget}`, "src/cli.mjs", "--outfile", output],
  { stdio: "inherit" },
);

console.log(`orgchart-core sidecar: ${output}`);
