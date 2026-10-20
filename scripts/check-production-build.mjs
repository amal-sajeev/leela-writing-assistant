import { stat, readFile } from "node:fs/promises";

const bundle = "main.js";
const [{ size }, source] = await Promise.all([stat(bundle), readFile(bundle, "utf8")]);

if (size > 2_200_000) throw new Error(`Production bundle is too large: ${size} bytes`);
if (/sourceMappingURL=|sourceURL=/.test(source)) throw new Error("Production bundle includes a source map reference");
if (!source.includes("lyra-companion")) throw new Error("Production bundle does not look like the Lyra plugin");

console.log(`[lyra] production bundle: ${size} bytes`);
