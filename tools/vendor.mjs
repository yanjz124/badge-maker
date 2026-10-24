// Copy the pinned browser builds from node_modules into docs/vendor so the GitHub Pages
// site is fully static (no CDN at runtime). Run after `npm install`: `npm run vendor`.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NM = "node_modules", OUT = "docs/vendor";
const files = {
  "manifold/manifold.js": "manifold-3d/manifold.js",
  "manifold/manifold.wasm": "manifold-3d/manifold.wasm",
  "opentype.mjs": "opentype.js/dist/opentype.mjs",
  "fflate.mjs": "fflate/esm/browser.js",
  "three/three.module.js": "three/build/three.module.js",
  "three/three.core.js": "three/build/three.core.js",
  "three/OrbitControls.js": "three/examples/jsm/controls/OrbitControls.js",
  "primer/primer.css": "@primer/css/dist/primer.css",
  "primer/light.css": "@primer/primitives/dist/css/functional/themes/light.css",
  "primer/dark.css": "@primer/primitives/dist/css/functional/themes/dark.css",
  "primer/size.css": "@primer/primitives/dist/css/functional/size/size.css",
  "primer/border.css": "@primer/primitives/dist/css/functional/size/border.css",
  "primer/base-size.css": "@primer/primitives/dist/css/base/size/size.css",
  "primer/typography.css": "@primer/primitives/dist/css/base/typography/typography.css",
  "primer/functional-typography.css": "@primer/primitives/dist/css/functional/typography/typography.css",
  "LICENSES/manifold-3d.txt": "manifold-3d/LICENSE",
  "LICENSES/opentype.js.txt": "opentype.js/LICENSE",
  "LICENSES/fflate.txt": "fflate/LICENSE",
  "LICENSES/three.txt": "three/LICENSE",
  "LICENSES/primer-css.txt": "@primer/css/LICENSE",
  "LICENSES/primer-primitives.txt": "@primer/primitives/LICENSE",
  "LICENSES/libre-franklin-OFL.txt": "@fontsource/libre-franklin/LICENSE",
};
for (const w of [500, 600, 700]) {
  files[`fonts/libre-franklin-${w}.woff`] = `@fontsource/libre-franklin/files/libre-franklin-latin-${w}-normal.woff`;
}
rmSync(OUT, { recursive: true, force: true });
for (const [dst, src] of Object.entries(files)) {
  const to = join(OUT, dst);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(NM, src), to);
}
const licenses = Object.keys(files).filter((f) => f.startsWith("LICENSES/")).map((f) => f.slice(9));
writeFileSync(join(OUT, "LICENSES/index.html"), `<!doctype html><meta charset="utf-8"><title>Third-party licenses</title>
<body style="font-family:system-ui,sans-serif;max-width:40em;margin:2em auto;padding:0 16px">
<h1>Third-party licenses</h1><ul>${licenses.map((f) => `<li><a href="${f}">${f.replace(/\.txt$/, "")}</a></li>`).join("")}</ul>
<p><a href="../../">Back</a></p></body>`);
console.log(`vendored ${Object.keys(files).length} files into ${OUT}`);
