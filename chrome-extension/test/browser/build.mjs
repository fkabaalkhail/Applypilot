/**
 * Bundles the browser harness (test/browser/entry.ts) into a single IIFE that
 * Playwright injects into a real Chromium page via page.addScriptTag.
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(here, "entry.ts")],
  outfile: path.join(here, "dist", "harness.js"),
  bundle: true,
  format: "iife",
  target: ["chrome110"],
  logLevel: "info",
});
console.log("Harness bundled → test/browser/dist/harness.js");
