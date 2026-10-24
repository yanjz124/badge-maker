// Node smoke test for the browser core (docs/js/core): builds badges with the same
// modules the site uses, checks geometry, and writes sample exports to tools/out/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import Module from "../docs/vendor/manifold/manifold.js";
import * as opentype from "../docs/vendor/opentype.mjs";
import { createBadgeKit, layoutPlates, slug } from "../docs/js/core/badge.js";
import { encode, FORMATS } from "../docs/js/core/export.js";

const wasm = await Module();
wasm.setup();
const kit = createBadgeKit(wasm);

const font = opentype.parse(readFileSync("docs/vendor/fonts/libre-franklin-600.woff").buffer.slice(0));
const logoDoc = new DOMParser().parseFromString(readFileSync("docs/assets/church_logo.svg", "utf8"), "image/svg+xml");

function volume(m) {
  const p = m.positions, ix = m.indices;
  let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fail++; };

// 1) Logo-only badge, same settings as the Python pin plate -> volumes comparable.
const t0 = performance.now();
const logoOnly = kit.buildBadge({ line1: "", back: "pin", pin_depth: 1.8 }, { font, logoDoc });
console.log(`logo-only build ${(performance.now() - t0).toFixed(0)} ms`, logoOnly.report,
  "body", volume(logoOnly.body).toFixed(1), "inlay", volume(logoOnly.inlay).toFixed(1));
check(logoOnly.report.thickness_mm === 3.2, "pin 1.8 -> 3.2mm thick");
check(logoOnly.report.body_ok, "body manifold");

// 2) The three requested names, magnet back, one plate.
const names = ["ELDER YAN", "ELDER JONES", "SISTER DESAUTELS"];
const built = names.map((n) => {
  const t = performance.now();
  const b = kit.buildBadge({ line1: n }, { font, logoDoc });
  console.log(`${n}: ${(performance.now() - t).toFixed(0)} ms`, JSON.stringify(b.report));
  check(volume(b.body) > 0 && volume(b.inlay) > 0 && volume(b.backer) > 0, `${n} volumes positive`);
  return { ...b, name: slug(n) };
});
const plates = layoutPlates(built, { bed: 256 });
check(plates.length === 1 && plates[0].objects.length === 6, "one plate, 3 badges + 3 backers");
mkdirSync("tools/out", { recursive: true });
for (const f of Object.keys(FORMATS)) {
  const { bytes, ext } = encode(f, plates[0].objects, { base: "plate" });
  writeFileSync(`tools/out/plate_${f}.${ext}`, bytes);
  console.log(`  ${f}: ${(bytes.length / 1024).toFixed(0)} KB`);
}
// Single badge with SkyWest-like thin counter check: letters with counters keep their holes.
const e = kit.buildBadge({ line1: "e o a R", back: "blank", white_core: false }, { font, logoDoc: null });
check(e.preview.front.length >= 8, `counters preserved (${e.preview.front.length} rings for 'e o a R')`);
process.exit(fail ? 1 : 0);
