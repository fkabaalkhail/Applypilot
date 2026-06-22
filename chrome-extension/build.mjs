/**
 * Build script — bundles the TypeScript sources with esbuild and copies
 * static assets (manifest, popup HTML/CSS, icons) into dist/.
 *
 * Usage:
 *   node build.mjs           one-shot production build
 *   node build.mjs --watch   rebuild on change (development)
 *
 * Load the resulting `dist/` folder via chrome://extensions → "Load unpacked".
 */
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
const DIST = "dist";

function copyStatic() {
  mkdirSync(path.join(DIST, "popup"), { recursive: true });
  cpSync("manifest.json", path.join(DIST, "manifest.json"));
  cpSync("src/popup/popup.html", path.join(DIST, "popup", "popup.html"));
  cpSync("src/popup/popup.css", path.join(DIST, "popup", "popup.css"));
  cpSync("assets", path.join(DIST, "assets"), { recursive: true });
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [
    // Output names must match the paths referenced in manifest.json.
    { in: "src/background/serviceWorker.ts", out: "serviceWorker" },
    { in: "src/content/contentScript.ts", out: "contentScript" },
    { in: "src/popup/popup.ts", out: "popup/popup" },
  ],
  bundle: true,
  outdir: DIST,
  format: "iife", // self-contained scripts; MV3 content scripts cannot use ES modules
  target: ["chrome110"],
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  plugins: [
    {
      name: "copy-static",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) copyStatic();
        });
      },
    },
  ],
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes…");
} else {
  await esbuild.build(options);
  console.log("Build complete → dist/");
}
