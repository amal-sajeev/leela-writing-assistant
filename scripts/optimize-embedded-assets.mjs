import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "assets");
const outputRoot = path.join(root, "release-art");
const outputFile = path.join(root, "src", "companion", "embedded-assets.ts");
const files = (await listFiles(sourceRoot)).filter((file) => file.endsWith(".webp")).sort();

if (files.length === 0) throw new Error("No WebP artwork found in assets/");

for (const file of files) {
  const target = path.join(outputRoot, ...file.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", path.join(sourceRoot, ...file.split("/")),
    "-vf", "scale='min(640,iw)':-2:flags=lanczos", "-c:v", "libwebp", "-quality", "55",
    "-compression_level", "6", "-preset", "picture", "-y", target,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not optimize ${file}`);
}

const imports = files.map((file, index) => `import asset${index} from "../../release-art/${file}";`);
const entries = files.map((file, index) => `  ${JSON.stringify(file)}: asset${index},`);
const source = [
  ...imports,
  "",
  "export const EMBEDDED_ASSETS: Readonly<Record<string, string>> = {",
  ...entries,
  "};",
  "",
].join("\n");

await writeFile(outputFile, source);
console.log(`Embedded ${files.length} optimized scenes.`);

async function listFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(directory, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}
