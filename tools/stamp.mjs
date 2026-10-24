// Cache-busting for GitHub Pages (which lets browsers cache files for 10 minutes):
// every "?v=" in the site's own HTML/JS gets a hash of the site's content, so a deploy
// never mixes a new page with stale scripts, logos or fonts. Run before committing
// changes to docs/: `npm run stamp`. Idempotent — the hash ignores existing stamps.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STAMP = /\?v=[0-9a-f]*/g;
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (f === "vendor" ? [] : walk(p)) : [p];
});
const all = walk("docs").sort();
const stamped = all.filter((p) => /\.(html|js|mjs)$/.test(p));

const h = createHash("sha1");
for (const p of all) {
  const buf = readFileSync(p);
  h.update(p);
  h.update(stamped.includes(p) ? buf.toString("utf8").replace(STAMP, "?v=") : buf);
}
const v = h.digest("hex").slice(0, 10);
let changed = 0;
for (const p of stamped) {
  const s = readFileSync(p, "utf8"), t = s.replace(STAMP, `?v=${v}`);
  if (t !== s) { writeFileSync(p, t); changed++; }
}
console.log(`stamp ${v}: updated ${changed} file(s)`);
