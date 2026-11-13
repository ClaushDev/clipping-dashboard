// Bundle de Remotion que usa render.mjs.
import { bundle } from "@remotion/bundler";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const remotionDir = path.join(here, "src", "remotion");
const bundleDir = path.join(here, ".remotion-bundle");
// Archivos estáticos de las composiciones. Van aparte de public/ para que Vite no los copie al dashboard.
const publicDir = path.join(here, "remotion-public");
export const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// Carpeta temporal de Remotion y Chrome. Remotion deja ahí bundles y perfiles de Chrome que no borra nunca y pueden
// ocupar decenas de GB: con REMOTION_TMP (p. ej. una carpeta en un disco grande) se usan allí y se limpian solos.
const TMP_ROOT = process.env.REMOTION_TMP || "";
const STALE_MS = 6 * 3600 * 1000;
if (TMP_ROOT) {
  mkdirSync(TMP_ROOT, { recursive: true });
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = TMP_ROOT;
  sweepTmp();
}

/** Borra los bundles y perfiles de Chrome de más de 6 h (los de un render en marcha son recientes y se quedan). */
function sweepTmp() {
  const now = Date.now();
  for (const name of readdirSync(TMP_ROOT)) {
    if (!/^(remotion-|puppeteer_dev_chrome_profile-|react-motion-render)/.test(name)) continue;
    const p = path.join(TMP_ROOT, name);
    try {
      if (now - statSync(p).mtimeMs > STALE_MS) rmSync(p, { recursive: true, force: true });
    } catch {
      /* en uso: la próxima vez */
    }
  }
}

function sourceHash() {
  const h = createHash("sha1");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(name).update(readFileSync(p));
    }
  };
  walk(remotionDir);
  if (existsSync(publicDir)) walk(publicDir);
  h.update(readFileSync(path.join(here, "package.json")));
  return h.digest("hex");
}

/** El bundle (webpack) tarda ~15 s: solo se rehace si cambia el código de src/remotion o sus archivos estáticos. */
export async function getServeUrl() {
  const hash = sourceHash();
  const stamp = path.join(bundleDir, ".hash");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === hash) return bundleDir;
  emit({ stage: "bundling" });
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(publicDir, { recursive: true });
  const modules = path.join(here, "node_modules");
  const url = await bundle({ entryPoint: path.join(remotionDir, "index.ts"), outDir: bundleDir, publicDir,
    webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), modules] } }) });
  writeFileSync(stamp, hash);
  return url;
}
