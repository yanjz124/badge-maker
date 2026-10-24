// File writers for built plates. Input everywhere is a list of objects:
//   { name, parts: [{ mesh: {positions, indices}, name, slot }], settings, ranges }
// slot is the 1-based filament (1 = body/black, 2 = inlay/white).
//
// Formats:
//   bambu   - Bambu Studio / OrcaSlicer 3MF: per-part filament, per-object ironing and
//             fine top layers (layer ranges). Doesn't touch the user's profiles.
//   prusa   - PrusaSlicer / SuperSlicer 3MF: one object per badge with two volumes on
//             extruders 1/2, ironing and layer ranges.
//   generic - plain 3MF core spec, one colored object per part (Cura, Simplify3D, ...).
//   stl     - one combined STL (single color), or a ZIP of one STL per color.
//   obj     - OBJ + MTL with colors.

import { zipSync, strToU8 } from "../../vendor/fflate.mjs";

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

export const NOTICE = "Generated with ElderPrice3D (unofficial). Not made, endorsed, or sponsored by, "
  + "and not affiliated with, The Church of Jesus Christ of Latter-day Saints / Intellectual Reserve, Inc.";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const f4 = (v) => +v.toFixed(4);

function meshXml(meshes, triAttrs = "") {
  // Several meshes merged into one <mesh> (vertex indices offset); returns xml + tri counts.
  const v = [], t = [];
  let base = 0;
  const counts = [];
  for (const m of meshes) {
    const p = m.positions, ix = m.indices;
    for (let i = 0; i < p.length; i += 3) v.push(`<vertex x="${f4(p[i])}" y="${f4(p[i + 1])}" z="${f4(p[i + 2])}"/>`);
    for (let i = 0; i < ix.length; i += 3) t.push(`<triangle v1="${ix[i] + base}" v2="${ix[i + 1] + base}" v3="${ix[i + 2] + base}"${triAttrs}/>`);
    base += p.length / 3;
    counts.push(ix.length / 3);
  }
  return { xml: `<mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh>`, counts };
}

function model(resources, items, extraNs = "", meta = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}"${extraNs}>
<metadata name="Description">${esc(NOTICE)}</metadata>${meta}
<resources>${resources.join("")}</resources>
<build>${items.join("")}</build>
</model>
`;
}

function zip(files) {
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(out, { level: 6 });
}

function rangesXml(objects, idOf) {
  const blocks = [];
  objects.forEach((o, i) => {
    if (!o.ranges || !o.ranges.length) return;
    const r = [` <object id="${idOf(o, i)}">`];
    for (const [z0, z1, lh] of o.ranges) {
      r.push(`  <range min_z="${z0.toFixed(4)}" max_z="${z1.toFixed(4)}">`,
        `   <option opt_key="extruder">0</option>`,
        `   <option opt_key="layer_height">${lh}</option>`,
        `  </range>`);
    }
    r.push(" </object>");
    blocks.push(r.join("\n"));
  });
  return blocks.length ? `<?xml version="1.0" encoding="utf-8"?>\n<objects>\n${blocks.join("\n")}\n</objects>\n` : null;
}

/** Bambu Studio / OrcaSlicer: one assembly per object, parts mapped to filament slots. */
export function to3mfBambu(objects) {
  const resources = [], items = [], cfg = [];
  let id = 1;
  for (const o of objects) {
    const partIds = [];
    for (const p of o.parts) {
      resources.push(`<object id="${id}" type="model" name="${esc(p.name)}">${meshXml([p.mesh]).xml}</object>`);
      partIds.push(id++);
    }
    const asm = id++;
    resources.push(`<object id="${asm}" type="model" name="${esc(o.name)}"><components>${partIds.map((i) => `<component objectid="${i}"/>`).join("")}</components></object>`);
    items.push(`<item objectid="${asm}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`);
    const lines = [` <object id="${asm}">`, `  <metadata key="name" value="${esc(o.name)}"/>`];
    for (const [k, v] of Object.entries(o.settings || {})) lines.push(`  <metadata key="${k}" value="${esc(v)}"/>`);
    o.parts.forEach((p, j) => lines.push(`  <part id="${partIds[j]}" subtype="normal_part">`,
      `   <metadata key="name" value="${esc(p.name)}"/>`, `   <metadata key="extruder" value="${p.slot}"/>`, "  </part>"));
    lines.push(" </object>");
    cfg.push(lines.join("\n"));
  }
  const files = {
    "[Content_Types].xml": CONTENT_TYPES,
    "_rels/.rels": RELS,
    "3D/3dmodel.model": model(resources, items),
    "Metadata/model_settings.config": `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${cfg.join("\n")}\n</config>\n`,
  };
  const ranges = rangesXml(objects, (_o, i) => i + 1); // keyed by 1-based object order
  if (ranges) files["Metadata/layer_config_ranges.xml"] = ranges;
  return zip(files);
}

/** PrusaSlicer: one object per badge; volumes are triangle ranges on extruders 1/2. */
export function to3mfPrusa(objects) {
  const resources = [], items = [], cfg = [];
  objects.forEach((o, i) => {
    const id = i + 1;
    const { xml, counts } = meshXml(o.parts.map((p) => p.mesh));
    resources.push(`<object id="${id}" type="model">${xml}</object>`);
    items.push(`<item objectid="${id}" printable="1"/>`);
    const lines = [` <object id="${id}" instances_count="1">`, `  <metadata type="object" key="name" value="${esc(o.name)}"/>`];
    if (o.settings && o.settings.ironing_type) {
      lines.push(`  <metadata type="object" key="ironing" value="1"/>`,
        `  <metadata type="object" key="ironing_type" value="${o.settings.ironing_type === "topmost" ? "topmost" : o.settings.ironing_type === "solid" ? "solid" : "top"}"/>`);
    }
    let first = 0;
    o.parts.forEach((p, j) => {
      const last = first + counts[j] - 1;
      lines.push(`  <volume firstid="${first}" lastid="${last}">`,
        `   <metadata type="volume" key="name" value="${esc(p.name)}"/>`,
        `   <metadata type="volume" key="volume_type" value="ModelPart"/>`,
        `   <metadata type="volume" key="extruder" value="${p.slot}"/>`, "  </volume>");
      first = last + 1;
    });
    lines.push(" </object>");
    cfg.push(lines.join("\n"));
  });
  const files = {
    "[Content_Types].xml": CONTENT_TYPES,
    "_rels/.rels": RELS,
    "3D/3dmodel.model": model(resources, items, ' xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"',
      '\n<metadata name="slic3rpe:Version3mf">1</metadata>'),
    "Metadata/Slic3r_PE_model.config": `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${cfg.join("\n")}\n</config>\n`,
  };
  const ranges = rangesXml(objects, (_o, i) => i + 1);
  if (ranges) files["Metadata/Prusa_Slicer_layer_config_ranges.xml"] = ranges;
  return zip(files);
}

/** Core-spec 3MF: every part its own colored object (body/inlay), for any slicer. */
export function to3mfGeneric(objects, colors) {
  const resources = [`<basematerials id="1"><base name="Filament 1" displaycolor="${colors[1]}FF"/><base name="Filament 2" displaycolor="${colors[2]}FF"/></basematerials>`];
  const items = [];
  let id = 2;
  for (const o of objects) {
    for (const p of o.parts) {
      resources.push(`<object id="${id}" type="model" name="${esc(`${o.name}_${p.name}`)}" pid="1" pindex="${p.slot - 1}">${meshXml([p.mesh]).xml}</object>`);
      items.push(`<item objectid="${id}"/>`);
      id++;
    }
  }
  return zip({ "[Content_Types].xml": CONTENT_TYPES, "_rels/.rels": RELS, "3D/3dmodel.model": model(resources, items) });
}

/** Binary STL of the given meshes merged. */
export function toStl(meshes, header = NOTICE) {
  const tris = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + tris * 50), dv = new DataView(buf);
  const h = strToU8(header.slice(0, 80));
  new Uint8Array(buf, 0, 80).set(h);
  dv.setUint32(80, tris, true);
  let o = 84;
  for (const m of meshes) {
    const p = m.positions, ix = m.indices;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
      for (const q of [a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, p[q + k], true); o += 4; }
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

/** ZIP with one STL per filament (import together as parts of one object). */
export function toStlPerColor(objects, base) {
  const bySlot = {};
  for (const o of objects) for (const p of o.parts) (bySlot[p.slot] ||= []).push(p.mesh);
  const files = { "README.txt": `${NOTICE}\n\nImport all STLs together as ONE multi-part object and assign\nfilament 1 (black) to *_1_body.stl and filament 2 (white) to *_2_white.stl.\n` };
  for (const [slot, meshes] of Object.entries(bySlot)) files[`${base}_${slot}_${slot === "1" ? "body" : "white"}.stl`] = toStl(meshes);
  return zip(files);
}

/** ZIP with OBJ + MTL (colors per filament). */
export function toObj(objects, colors, base) {
  const hex = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4)).join(" ");
  const mtl = `# ${NOTICE}\nnewmtl filament1\nKd ${hex(colors[1])}\nnewmtl filament2\nKd ${hex(colors[2])}\n`;
  const out = [`# ${NOTICE}`, `mtllib ${base}.mtl`];
  let base0 = 1;
  for (const o of objects) {
    for (const p of o.parts) {
      out.push(`o ${o.name}_${p.name}`, `usemtl filament${p.slot}`);
      const ps = p.mesh.positions, ix = p.mesh.indices;
      for (let i = 0; i < ps.length; i += 3) out.push(`v ${f4(ps[i])} ${f4(ps[i + 1])} ${f4(ps[i + 2])}`);
      for (let i = 0; i < ix.length; i += 3) out.push(`f ${ix[i] + base0} ${ix[i + 1] + base0} ${ix[i + 2] + base0}`);
      base0 += ps.length / 3;
    }
  }
  return zip({ [`${base}.obj`]: out.join("\n") + "\n", [`${base}.mtl`]: mtl });
}

export const FORMATS = {
  bambu: { label: "3MF — Bambu Studio / OrcaSlicer", ext: "3mf", mime: "model/3mf" },
  prusa: { label: "3MF — PrusaSlicer / SuperSlicer", ext: "3mf", mime: "model/3mf" },
  generic: { label: "3MF — generic (Cura, others)", ext: "3mf", mime: "model/3mf" },
  stlcolors: { label: "STL per color (ZIP) — any multi-material slicer", ext: "zip", mime: "application/zip" },
  stl: { label: "STL — single color", ext: "stl", mime: "model/stl" },
  obj: { label: "OBJ + MTL (ZIP)", ext: "zip", mime: "application/zip" },
};

/** Encode one plate's objects in `format`; returns { bytes, ext, mime }. */
export function encode(format, objects, { colors = { 1: "#1A1A1A", 2: "#F0F0F0" }, base = "badge" } = {}) {
  const f = FORMATS[format];
  let bytes;
  switch (format) {
    case "bambu": bytes = to3mfBambu(objects); break;
    case "prusa": bytes = to3mfPrusa(objects); break;
    case "generic": bytes = to3mfGeneric(objects, colors); break;
    case "stlcolors": bytes = toStlPerColor(objects, base); break;
    case "stl": bytes = toStl(objects.flatMap((o) => o.parts.map((p) => p.mesh))); break;
    case "obj": bytes = toObj(objects, colors, base); break;
    default: throw new Error(`unknown format ${format}`);
  }
  return { bytes, ext: f.ext, mime: f.mime };
}

export { zip as zipFiles };
