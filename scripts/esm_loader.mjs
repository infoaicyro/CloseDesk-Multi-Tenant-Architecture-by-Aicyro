// scripts/esm_loader.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context);
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") {
      let candidate = null;

      if (specifier.startsWith("@/")) {
        candidate = path.resolve(process.cwd(), "src", specifier.slice(2));
      } else if (specifier.startsWith(".") || specifier.startsWith("/")) {
        let parentDir;
        try {
          parentDir = path.dirname(fileURLToPath(context.parentURL));
        } catch {
          parentDir = process.cwd();
        }
        candidate = path.resolve(parentDir, specifier);
      }

      if (candidate) {
        if (fs.existsSync(candidate + ".js")) {
          return {
            url: pathToFileURL(candidate + ".js").href,
            shortCircuit: true,
          };
        }
        if (fs.existsSync(candidate + ".jsx")) {
          return {
            url: pathToFileURL(candidate + ".jsx").href,
            shortCircuit: true,
          };
        }
        if (fs.existsSync(path.join(candidate, "index.js"))) {
          return {
            url: pathToFileURL(path.join(candidate, "index.js")).href,
            shortCircuit: true,
          };
        }
      }
    }
    throw err;
  }
}
