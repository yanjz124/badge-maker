// Badge geometry: a JavaScript port of badgegen/badge.py on top of manifold-3d.
//
// Coordinates are millimetres, z up. Built front-down (front face on z=0) like the Python
// version, then reflected so the text faces up when print_side is "up". Every manifold
// object is freed before returning: callers get plain typed arrays, which keeps repeated
// live-preview builds from leaking WebAssembly memory.

import { svgDocToRings, textToRings } from "./outline.js";

export const MM_PER_INCH = 25.4;

export const DEFAULTS = {
  line1: "ELDER SMITH",
  line2: "",
  line1_height: 0,         // per-line cap height override (mm); 0 = text_height
  line2_height: 0,
  width_in: 3.0,
  height_in: 1.75,
  thickness: 2.6,          // minimum plate thickness; grows for back pockets / layer snap
  inlay_depth: 0.8,        // white layer thickness
  corner_radius: 3.0,
  relief_style: "recessed", // recessed | raised | flush
  relief: 0.16,            // black cap over the white (recessed) / emboss height (raised)
  white_core: true,        // full white core like engraved 2-ply plastic; false = letter inserts
  edge_black: 1.2,         // black rim around the white core
  print_side: "up",        // up = text on top | down = text on the bed (mirrored)
  text_height: 6.0,        // cap height of a line
  line_gap: 0.35,
  logo_grow: 0.05,         // thicken thin logo strokes (mm)
  logo_scale: 0.9,
  simplify_tol: 0.02,
  margin: 2.0,
  vgap: 2.0,
  nozzle: 0.2,
  back: "magnet",          // magnet | pin | blank
  back_skin: 0.4,
  pin_len: 40.0,
  pin_height: 3.2,
  pin_depth: 1.0,
  pin_center_frac: 0.62,
  magnet_diam: 10.2,
  magnet_depth: 2.1,
  magnet_spacing: 40.0,
  backer: true,
  backer_wall: 4.0,
  backer_floor: 0.6,
  top_layer: 0.08,         // fine layer height for the top TOP_ZONE mm (0 = off)
  ironing: "top",          // top | topmost | solid | none
};

export const TOP_ZONE = 0.4; // mm of fine layers at the top; also the thickness snap step

/**
 * Create a badge kit bound to a ready manifold module (`await Module(); setup()`).
 * Returns pure functions over plain specs; fonts/logos are passed in pre-parsed.
 */
export function createBadgeKit(wasm) {
  const { CrossSection, Manifold } = wasm;

  // Track every wasm object created during one build so it can be freed in one go.
  function scope() {
    const live = [];
    const k = (o) => (live.push(o), o);
    k.free = () => { for (const o of live) { try { o.delete(); } catch { /* already freed */ } } live.length = 0; };
    return k;
  }

  const box = (cs) => { const b = cs.bounds(); return [b.min[0], b.min[1], b.max[0], b.max[1]]; };

  // Uniformly scale + center a cross-section into [x0, y0, x1, y1] (polygons.fit_into).
  function fitInto(k, cs, [bx0, by0, bx1, by1]) {
    const [minx, miny, maxx, maxy] = box(cs);
    const gw = maxx - minx, gh = maxy - miny;
    if (gw <= 0 || gh <= 0) return cs;
    const s = Math.min((bx1 - bx0) / gw, (by1 - by0) / gh);
    const dx = bx0 + (bx1 - bx0 - gw * s) / 2, dy = by0 + (by1 - by0 - gh * s) / 2;
    return k(k(k(cs.translate([-minx, -miny])).scale([s, s])).translate([dx, dy]));
  }

  function roundedRect(k, W, H, r) {
    if (r <= 0) return k(CrossSection.square([W, H]));
    r = Math.min(r, W / 2, H / 2);
    const inner = k(k(CrossSection.square([W - 2 * r, H - 2 * r])).translate([r, r]));
    return k(inner.offset(r, "Round", 2, 96));
  }

  /**
   * Thinnest stroke (mm) via morphological opening, like polygons.min_feature_width, but
   * only searched up to `cap` mm: it exists to flag strokes near the nozzle width.
   */
  function minFeatureWidth(cs, relLoss = 0.02, cap = 2.0) {
    const total = cs.area();
    if (!(total > 0)) return 0;
    const loss = (r) => {
      const a = cs.offset(-r, "Miter"), b = a.offset(r, "Miter");
      const v = (total - b.area()) / total;
      a.delete(); b.delete();
      return v;
    };
    let hi = cap / 2, lo = 0;
    if (loss(hi) < relLoss) return cap;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      if (loss(mid) >= relLoss) hi = mid; else lo = mid;
    }
    return 2 * hi;
  }

  let logoCache = null;

  // Fit/scale/grow the logo into its box. Returns a CrossSection the cache owns.
  function processLogo(doc, logoBox, spec) {
    const k = scope();
    try {
      const rings = svgDocToRings(doc);
      if (!rings.length) return { cs: new CrossSection([]), min: null };
      let logo = fitInto(k, k(new CrossSection(rings, "EvenOdd")), logoBox);
      if (spec.logo_scale !== 1) {
        const [x0, y0, x1, y1] = box(logo), c = [(x0 + x1) / 2, (y0 + y1) / 2], s = spec.logo_scale;
        logo = k(k(k(logo.translate([-c[0], -c[1]])).scale([s, s])).translate(c));
      }
      if (spec.logo_grow > 0) {
        // Grown letters can touch at a point; close+open by a hair so they fuse cleanly.
        logo = k(k(k(logo.offset(spec.logo_grow, "Round", 2, 24)).offset(0.01, "Round", 2, 8)).offset(-0.01, "Round", 2, 8));
      }
      const out = logo.simplify(0.005); // offsets add many near-collinear points; not in scope
      return { cs: out, min: minFeatureWidth(out) };
    } finally {
      k.free();
    }
  }

  const width = (s) => s.width_in * MM_PER_INCH;
  const height = (s) => s.height_in * MM_PER_INCH;

  /**
   * The white artwork outline (text lines + logo) as a CrossSection owned by `k`.
   * assets = { font: opentype.Font, lineFonts?: [Font|null, Font|null], logoDoc: XML Document | null }.
   */
  function frontSection(k, spec, assets, report) {
    const W = width(spec), H = height(spec), m = spec.margin, mid = H / 2;
    const cx0 = m, cx1 = W - m;
    const parts = [];

    // Upper half: one or two lines centered. Each line may override the font
    // (assets.lineFonts[i]) and height (spec.lineN_height; 0 = text_height).
    const lines = [0, 1]
      .map((i) => ({
        text: spec[`line${i + 1}`],
        font: (assets.lineFonts && assets.lineFonts[i]) || assets.font,
        h: spec[`line${i + 1}_height`] > 0 ? spec[`line${i + 1}_height`] : spec.text_height,
      }))
      .filter((l) => (l.text || "").trim() && l.font);
    let overflow = 0;
    if (lines.length) {
      const upY0 = mid + spec.vgap / 2, upY1 = H - m, Uh = upY1 - upY0, cy = (upY0 + upY1) / 2;
      let gap = spec.text_height * spec.line_gap, f = 1;
      const block = lines.reduce((s, l) => s + l.h, 0) + (lines.length - 1) * gap;
      if (block > Uh) f = Uh / block; // too tall: scale every line and the gap together
      gap *= f;
      let y = cy + (block * f) / 2;
      for (const l of lines) {
        const th = l.h * f;
        const rings = textToRings(l.font, l.text);
        if (rings.length) {
          const cs = k(new CrossSection(rings, "NonZero"));
          const [x0, y0, x1, y1] = box(cs);
          overflow = Math.max(overflow, ((x1 - x0) / (y1 - y0)) * th / (cx1 - cx0));
          parts.push(fitInto(k, cs, [cx0, y - th, cx1, y]));
        }
        y -= th + gap;
      }
    }

    // Lower half: logo, centered, aspect kept.
    let logoMin = null;
    if (assets.logoDoc) {
      const logoBox = [cx0, m, cx1, mid - spec.vgap / 2];
      const key = JSON.stringify([logoBox, spec.logo_scale, spec.logo_grow]);
      if (!logoCache || logoCache.doc !== assets.logoDoc || logoCache.key !== key) {
        // Same logo on every badge: process it once (offsets + stroke check are the slow part).
        if (logoCache) logoCache.cs.delete();
        logoCache = { doc: assets.logoDoc, key, ...processLogo(assets.logoDoc, logoBox, spec) };
      }
      if (!logoCache.cs.isEmpty()) parts.push(logoCache.cs);
      logoMin = logoCache.min;
    }

    // compose() keeps the disjoint parts as-is (no boolean union that could snap thin
    // letter counters shut; see the SkyWest 'e' bug in the Python version).
    let front = parts.length ? k(CrossSection.compose(parts)) : k(new CrossSection([]));
    if (spec.simplify_tol > 0 && !front.isEmpty()) front = k(front.simplify(spec.simplify_tol));
    report.text_overflow = +overflow.toFixed(3);
    report.logo_min_stroke_mm = logoMin == null ? null : +logoMin.toFixed(3);
    return front;
  }

  function backDepth(spec) {
    return spec.back === "pin" ? spec.pin_depth : spec.back === "magnet" ? spec.magnet_depth : 0;
  }

  /** Plate thickness after back-pocket clearance and (face-up) layer-grid snapping. */
  function finalThickness(spec) {
    const front = spec.relief_style === "recessed" ? spec.relief + spec.inlay_depth : spec.inlay_depth;
    const back = backDepth(spec);
    let t = Math.max(spec.thickness, front + (back ? spec.back_skin + back : 0));
    if (spec.top_layer > 0 && spec.print_side === "up") t = Math.ceil(t / TOP_ZONE - 1e-6) * TOP_ZONE;
    return +t.toFixed(4);
  }

  function toMesh(man) {
    const mesh = man.getMesh();
    const np = mesh.numProp, vp = mesh.vertProperties, n = vp.length / np;
    let positions = vp;
    if (np !== 3) {
      positions = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) positions.set(vp.subarray(i * np, i * np + 3), i * 3);
    } else {
      positions = new Float32Array(vp);
    }
    return { positions, indices: new Uint32Array(mesh.triVerts) };
  }

  /** Polygons of a CrossSection as plain arrays (for 2D preview). */
  const polys = (cs) => cs.toPolygons().map((ring) => ring.map((p) => [p[0], p[1]]));

  /**
   * Build one badge. Returns { body, inlay, backer, preview, report, thickness } where the
   * meshes are { positions: Float32Array, indices: Uint32Array }.
   */
  function buildBadge(specIn, assets) {
    const spec = { ...DEFAULTS, ...specIn };
    const k = scope();
    try {
      const report = {};
      const W = width(spec), H = height(spec);
      const T = finalThickness(spec);
      if (T !== spec.thickness) report.thickened_from_mm = spec.thickness;
      let front = frontSection(k, spec, assets, report);
      const plateCS = roundedRect(k, W, H, spec.corner_radius);
      const e = spec.edge_black;
      const coreCS = k(roundedRect(k, W - 2 * e, H - 2 * e, Math.max(spec.corner_radius - e, 0)).translate([e, e]));
      const preview = { plate: polys(plateCS), front: polys(front), core: spec.white_core && spec.relief_style === "recessed" ? polys(coreCS) : null };

      if (spec.print_side === "down") front = k(k(front.mirror([1, 0])).translate([W, 0]));
      const d = spec.relief, wh = spec.inlay_depth;
      const ext = (cs, h, z0 = 0) => k(k(cs.extrude(h)).translate([0, 0, z0]));
      const empty = front.isEmpty();
      let inlay, cavity;
      if (spec.relief_style === "raised" && !empty) {
        inlay = ext(front, d + wh, -d); cavity = ext(front, wh);
      } else if (spec.relief_style === "flush" && !empty) {
        inlay = ext(front, wh); cavity = inlay;
      } else if (spec.white_core) {
        inlay = ext(coreCS, wh, d);
        cavity = empty ? inlay : k(Manifold.union([ext(front, d), inlay]));
      } else if (!empty) {
        inlay = ext(front, wh, d); cavity = ext(front, d + wh);
      }
      let body = k(ext(plateCS, T));
      if (cavity) body = k(body.subtract(cavity));

      const cutter = backCutter(k, spec, W, H, T);
      if (cutter) body = k(body.subtract(cutter));

      let parts = [body, inlay].filter(Boolean);
      if (spec.print_side === "up") parts = parts.map((p) => k(k(p.mirror([0, 0, 1])).translate([0, 0, T])));
      const [bodyM, inlayM] = parts;

      const backer = spec.back === "magnet" && spec.backer ? toMesh(buildBackerManifold(k, spec)) : null;
      report.thickness_mm = T;
      report.width_mm = +W.toFixed(2);
      report.height_mm = +H.toFixed(2);
      report.body_ok = bodyM.status() === "NoError";
      return {
        body: toMesh(bodyM),
        inlay: inlayM ? toMesh(inlayM) : null,
        backer,
        preview,
        report,
        spec: { ...spec, thickness: T },
      };
    } finally {
      k.free();
    }
  }

  function backCutter(k, spec, W, H, T) {
    if (spec.back === "pin") {
      return k(k(Manifold.cube([spec.pin_len, spec.pin_height, spec.pin_depth * 2], true))
        .translate([W / 2, H * spec.pin_center_frac, T]));
    }
    if (spec.back === "magnet") {
      const cyl = (sx) => k(k(Manifold.cylinder(spec.magnet_depth * 2, spec.magnet_diam / 2, spec.magnet_diam / 2, 64, true))
        .translate([W / 2 + sx, H / 2, T]));
      return k(Manifold.union([cyl(-spec.magnet_spacing / 2), cyl(spec.magnet_spacing / 2)]));
    }
    return null;
  }

  // Inside-the-shirt magnet backer: a stadium bar with pockets matching the badge's,
  // pockets up (they face the shirt when worn). Origin at its lower-left corner.
  function buildBackerManifold(k, spec) {
    const d = spec.magnet_diam, w = spec.backer_wall;
    const L = spec.magnet_spacing + d + 2 * w, Wd = d + 2 * w, Tb = spec.magnet_depth + spec.backer_floor;
    const bar = k(roundedRect(k, L, Wd, Wd / 2).extrude(Tb));
    const cyl = (x) => k(k(Manifold.cylinder(spec.magnet_depth * 2, d / 2, d / 2, 64, true)).translate([x, Wd / 2, Tb]));
    return k(bar.subtract(k(Manifold.union([cyl(w + d / 2), cyl(L - w - d / 2)]))));
  }

  return { buildBadge, finalThickness, DEFAULTS };
}

// ---------- plate layout (plain arrays, no wasm) ----------

export function translateMesh(mesh, dx, dy, dz = 0) {
  const p = new Float32Array(mesh.positions);
  for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; p[i + 2] += dz; }
  return { positions: p, indices: mesh.indices };
}

export function meshBounds(mesh) {
  const p = mesh.positions, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) { if (p[i + a] < min[a]) min[a] = p[i + a]; if (p[i + a] > max[a]) max[a] = p[i + a]; }
  }
  return { min, max };
}

/**
 * Lay built badges out on square beds: each row is a badge with its backer to the right;
 * rows stack, then wrap into columns, then onto further plates. Returns an array of
 * plates: { objects: [{ name, parts: [{ mesh, name, slot }], settings, ranges }],
 * placements: [{ built, x, y, backer }] (for 2D previews), size, bed }.
 */
export function layoutPlates(built, { bed = 256, gap = 6 } = {}) {
  if (!built.length) return [];
  const usable = bed - 10;
  const W = built[0].report.width_mm, H = built[0].report.height_mm;
  const backerW = Math.max(0, ...built.map((b) => (b.backer ? meshBounds(b.backer).max[0] : 0)));
  const rowW = W + (backerW ? gap + backerW : 0);
  const perCol = Math.max(1, Math.floor((usable + gap) / (H + gap)));
  const perRow = Math.max(1, Math.floor((usable + 2 * gap) / (rowW + 2 * gap)));
  const perPlate = perCol * perRow;
  const plates = [];
  for (let p = 0; p * perPlate < built.length; p++) {
    const chunk = built.slice(p * perPlate, (p + 1) * perPlate);
    const ncols = Math.ceil(chunk.length / perCol), nrows = Math.min(chunk.length, perCol);
    const totalW = ncols * rowW + (ncols - 1) * gap * 2, totalH = nrows * H + (nrows - 1) * gap;
    const x0 = (bed - totalW) / 2, y0 = (bed - totalH) / 2;
    const objects = [], placements = [];
    chunk.forEach((b, i) => {
      const col = Math.floor(i / perCol), row = i % perCol;
      const x = x0 + col * (rowW + gap * 2), y = y0 + (nrows - 1 - row) * (H + gap);
      const name = b.name;
      const T = b.spec.thickness;
      const ranges = b.spec.top_layer > 0 && b.spec.print_side === "up" ? [[+(T - TOP_ZONE).toFixed(4), T, b.spec.top_layer]] : null;
      const settings = b.spec.ironing && b.spec.ironing !== "none" ? { ironing_type: b.spec.ironing } : {};
      const parts = [{ mesh: translateMesh(b.body, x, y), name: "body", slot: 1 }];
      if (b.inlay) parts.push({ mesh: translateMesh(b.inlay, x, y), name: "inlay", slot: 2 });
      objects.push({ name, parts, settings, ranges });
      const place = { built: b, x, y, backer: null };
      placements.push(place);
      if (b.backer) {
        const bb = meshBounds(b.backer);
        const by = y + (H - (bb.max[1] - bb.min[1])) / 2;
        place.backer = { x: x + W + gap, y: by, w: bb.max[0] - bb.min[0], h: bb.max[1] - bb.min[1] };
        objects.push({ name: `${name}_backer`, parts: [{ mesh: translateMesh(b.backer, x + W + gap - bb.min[0], by - bb.min[1]), name: "backer", slot: 1 }], settings: {}, ranges: null });
      }
    });
    plates.push({ objects, placements, size: [totalW, totalH], bed });
  }
  return plates;
}

export function slug(...parts) {
  const s = parts.filter(Boolean).join("_").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "badge";
}
