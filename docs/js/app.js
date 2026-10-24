// Page controller: reads the form, rebuilds badges (debounced), draws the 2D/3D previews
// and encodes downloads. All geometry runs locally in the browser.
import Module from "../vendor/manifold/manifold.js";
import * as opentype from "../vendor/opentype.mjs";
import { createBadgeKit, DEFAULTS, layoutPlates, slug } from "./core/badge.js";
import { encode, FORMATS, NOTICE, zipFiles } from "./core/export.js";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const STORE_KEY = "badge-maker:v1";

const FORMAT_NOTES = {
  bambu: "Opens as two-color objects with ironing and fine top layers preset. Best for Bambu Lab printers and OrcaSlicer.",
  prusa: "Two volumes per badge on extruders 1 and 2, with ironing and fine top layers. For PrusaSlicer / SuperSlicer (MMU, XL, CORE One).",
  generic: "Body and text as separate colored objects. In Cura and other slicers, select both and merge/group, then set each part's extruder.",
  stlcolors: "One STL per color. Import them together as a single multi-part object and give each its filament.",
  stl: "A single-color STL of everything (no color separation). For previews or single-color prints.",
  obj: "OBJ + MTL with the two colors, for viewers and slicers that read OBJ colors.",
};

// UI-only settings (not part of the badge spec) and their defaults.
const UI_DEFAULTS = {
  mode: "single", line1: "ELDER SMITH", line2: "", batch: "ELDER YAN\nELDER JONES\nSISTER DESAUTELS",
  perBadge: false, font: "600", logo: "church", color1: "#1a1a1a", color2: "#f0f0f0",
  bed: 256, format: "bambu", view: "front",
};

let kit = null;
const assets = { fonts: {}, uploadedFont: null, churchLogo: null, uploadedLogo: null };
let state = { ui: { ...UI_DEFAULTS }, spec: {} };
let current = { plates: [], plateIndex: 0, errors: [] };
let viewer = null;
let buildToken = 0;

// ---------- state <-> form ----------

function specDefaults() {
  const d = { ...DEFAULTS };
  delete d.line1; delete d.line2;
  return d;
}

function readForm() {
  const spec = {};
  for (const el of $$("[data-spec]")) {
    const k = el.dataset.spec, t = el.dataset.type;
    if (el.type === "checkbox") spec[k] = el.checked;
    else if (t === "bool") spec[k] = el.value === "true";
    else if (el.type === "number" || t === "num") { const v = parseFloat(el.value); spec[k] = isFinite(v) ? v : specDefaults()[k]; }
    else spec[k] = el.value;
  }
  const ui = { ...state.ui };
  for (const el of $$("[data-ui]")) {
    const k = el.dataset.ui;
    ui[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? (parseFloat(el.value) || UI_DEFAULTS[k]) : el.value;
  }
  state = { ui, spec };
}

function writeForm() {
  const spec = { ...specDefaults(), ...state.spec };
  for (const el of $$("[data-spec]")) {
    const v = spec[el.dataset.spec];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = String(v);
  }
  for (const el of $$("[data-ui]")) {
    const v = state.ui[el.dataset.ui];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = String(v);
  }
  // Uploaded files are not persisted: fall back to the bundled choice.
  if ($("#font").value === "upload" && !assets.uploadedFont) $("#font").value = UI_DEFAULTS.font;
  if ($("#logo").value === "upload" && !assets.uploadedLogo) $("#logo").value = UI_DEFAULTS.logo;
  setMode(state.ui.mode, false);
  setView(state.ui.view, false);
  syncVisibility();
}

function syncVisibility() {
  const back = $("#back").value;
  for (const el of $$("[data-show]")) {
    const [k, v] = el.dataset.show.split("=");
    el.hidden = (k === "back" ? back : "") !== v;
  }
  $("#fontFile").hidden = $("#font").value !== "upload";
  $("#logoFile").hidden = $("#logo").value !== "upload";
  $("#formatNote").textContent = FORMAT_NOTES[$("#format").value] || "";
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { saved = null; }
  const fromHash = decodeShare(location.hash);
  const src = fromHash || saved;
  if (src) state = { ui: { ...UI_DEFAULTS, ...(src.ui || {}) }, spec: { ...(src.spec || {}) } };
}

function encodeShare() {
  const d = specDefaults(), spec = {};
  for (const [k, v] of Object.entries(state.spec)) if (d[k] !== v) spec[k] = v;
  const ui = {};
  for (const [k, v] of Object.entries(state.ui)) if (UI_DEFAULTS[k] !== v && k !== "view") ui[k] = v;
  const json = JSON.stringify({ ui, spec });
  return "#s=" + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShare(hash) {
  const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(hash || "");
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch { return null; }
}

// ---------- tabs ----------

function setMode(mode, rebuild = true) {
  state.ui.mode = mode;
  for (const b of $$("[data-mode]")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
  for (const p of $$("[data-pane]")) p.hidden = p.dataset.pane !== mode;
  if (rebuild) schedule();
}

function setView(view, redraw = true) {
  state.ui.view = view;
  for (const b of $$("[data-view]")) b.setAttribute("aria-selected", String(b.dataset.view === view));
  $("#stage2d").hidden = view !== "front";
  $("#stage3d").hidden = view !== "3d";
  if (redraw) drawPreview();
}

// ---------- assets ----------

async function loadFont(weight) {
  if (!assets.fonts[weight]) {
    const buf = await (await fetch(`vendor/fonts/libre-franklin-${weight}.woff`)).arrayBuffer();
    assets.fonts[weight] = opentype.parse(buf);
  }
  return assets.fonts[weight];
}

async function currentAssets() {
  const f = state.ui.font;
  const font = f === "upload" && assets.uploadedFont ? assets.uploadedFont : await loadFont(f === "upload" ? UI_DEFAULTS.font : f);
  let logoDoc = null;
  if (state.ui.logo === "church") {
    if (!assets.churchLogo) {
      const txt = await (await fetch("assets/church_logo.svg")).text();
      assets.churchLogo = new DOMParser().parseFromString(txt, "image/svg+xml");
    }
    logoDoc = assets.churchLogo;
  } else if (state.ui.logo === "upload") {
    logoDoc = assets.uploadedLogo;
  }
  return { font, logoDoc };
}

// ---------- build ----------

function entries() {
  if (state.ui.mode === "single") return [{ line1: state.ui.line1, line2: state.ui.line2 }];
  return state.ui.batch.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, b = ""] = l.split("|").map((s) => s.trim());
    return { line1: a, line2: b };
  });
}

let timer = null;
function schedule(delay = 180) {
  clearTimeout(timer);
  timer = setTimeout(rebuild, delay);
}

async function rebuild() {
  if (!kit) return;
  readForm();
  save();
  syncVisibility();
  const token = ++buildToken;
  const list = entries();
  const t0 = performance.now();
  $("#buildInfo").textContent = list.length > 1 ? `Building 0 / ${list.length}…` : "Building…";
  const errors = [];
  let a;
  try { a = await currentAssets(); } catch (e) { errors.push(`Could not load the font or logo: ${e.message}`); }
  const built = [];
  if (a) {
    for (let i = 0; i < list.length; i++) {
      if (token !== buildToken) return; // a newer edit superseded this build
      try {
        const b = kit.buildBadge({ ...state.spec, ...list[i] }, a);
        built.push({ ...b, name: slug(list[i].line1, list[i].line2), label: [list[i].line1, list[i].line2].filter(Boolean).join(" / ") });
      } catch (e) {
        errors.push(`“${list[i].line1}”: ${e.message || e}`);
      }
      if (list.length > 1) {
        $("#buildInfo").textContent = `Building ${i + 1} / ${list.length}…`;
        await new Promise((r) => setTimeout(r));
      }
    }
  }
  if (token !== buildToken) return;
  current = { plates: layoutPlates(built, { bed: state.ui.bed }), plateIndex: 0, built, errors };
  const ms = Math.round(performance.now() - t0);
  $("#buildInfo").textContent = built.length
    ? `${built.length} badge${built.length > 1 ? "s" : ""} · ${built[0].report.thickness_mm} mm thick · ${ms} ms`
    : "";
  $("#download").disabled = !built.length;
  showMessages();
  drawPreview();
}

function showMessages() {
  const box = $("#messages");
  box.textContent = "";
  const add = (cls, text) => {
    const d = document.createElement("div");
    d.className = `flash ${cls} f6`;
    d.textContent = text;
    box.appendChild(d);
  };
  for (const e of current.errors) add("flash-error", e);
  const b = current.built || [];
  if (!b.length) return;
  const spec = b[0].spec;
  const over = b.filter((x) => x.report.text_overflow > 1.01);
  if (over.length) {
    add("flash-warn", `Text was shrunk to fit: ${over.map((x) => `${x.label} (${Math.round((x.report.text_overflow - 1) * 100)}%)`).join(", ")}. `
      + "Shorten it, split it into two lines, or lower the text height.");
  }
  const thin = b[0].report.logo_min_stroke_mm;
  if (thin != null && thin < spec.nozzle * 1.05) {
    add("flash-warn", `The logo's thinnest strokes are about ${thin.toFixed(2)} mm, at or under your ${spec.nozzle} mm nozzle. Raise “Logo boldness” or use a smaller nozzle.`);
  }
  if (b[0].report.thickened_from_mm != null) {
    add("", `Thickness set to ${b[0].report.thickness_mm} mm so the back pockets keep ${spec.back_skin} mm of black under the white`
      + (spec.top_layer > 0 && spec.print_side === "up" ? " and the top layers line up." : "."));
  }
  if (current.plates.length > 1) add("", `${b.length} badges need ${current.plates.length} build plates of ${state.ui.bed} mm; each plate is a separate file in the download.`);
}

// ---------- 2D preview ----------

function ringsPath(rings) {
  return rings.map((r) => "M" + r.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join("L") + "Z").join("");
}

function badgeGroup(b, colors) {
  const p = b.preview;
  return `<path d="${ringsPath(p.plate)}" fill="${colors[1]}" stroke="currentColor" stroke-opacity=".35" stroke-width=".4" vector-effect="non-scaling-stroke"/>`
    + `<path d="${ringsPath(p.front)}" fill="${colors[2]}" fill-rule="nonzero"/>`;
}

function drawPreview() {
  const colors = { 1: state.ui.color1, 2: state.ui.color2 };
  const stage = $("#stage2d");
  const nav = $("#plateNav");
  const plate = current.plates[current.plateIndex];
  if (!plate) { stage.innerHTML = ""; nav.hidden = true; return; }

  if (state.ui.view === "3d") {
    try {
      if (!viewer) {
        import("./viewer3d.js").then(({ Viewer }) => {
          viewer = new Viewer($("#stage3d"));
          drawPreview();
        }).catch((e) => { $("#stage3d").textContent = `3D preview unavailable: ${e.message}`; });
        return;
      }
      viewer.show(plate.objects, colors, plate.bed);
    } catch (e) {
      $("#stage3d").textContent = `3D preview unavailable: ${e.message}`;
    }
  } else if (state.ui.mode === "single" && current.built.length === 1) {
    const b = current.built[0], W = b.report.width_mm, H = b.report.height_mm, m = 3;
    stage.innerHTML = `<svg viewBox="${-m} ${-m} ${W + 2 * m} ${H + 2 * m}" role="img" aria-label="Badge front preview" style="color:var(--fgColor-muted)">
      <g transform="translate(0 ${H}) scale(1 -1)">${badgeGroup(b, colors)}</g></svg>`;
  } else {
    const bed = plate.bed;
    let g = `<rect x="0" y="0" width="${bed}" height="${bed}" rx="4" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="3 3"/>`;
    for (const pl of plate.placements) {
      g += `<g transform="translate(${pl.x} ${pl.y})">${badgeGroup(pl.built, colors)}</g>`;
      if (pl.backer) {
        const r = pl.backer.h / 2;
        g += `<rect x="${pl.backer.x}" y="${pl.backer.y}" width="${pl.backer.w}" height="${pl.backer.h}" rx="${r}" fill="${colors[1]}" stroke="currentColor" stroke-opacity=".35" stroke-width=".4" vector-effect="non-scaling-stroke"/>`;
      }
    }
    stage.innerHTML = `<svg viewBox="-4 -4 ${bed + 8} ${bed + 8}" role="img" aria-label="Build plate preview" style="color:var(--fgColor-muted)">
      <g transform="translate(0 ${bed}) scale(1 -1)">${g}</g></svg>`;
  }

  nav.hidden = current.plates.length < 2;
  if (!nav.hidden) {
    nav.innerHTML = "";
    nav.append(`Plate `);
    current.plates.forEach((_, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn btn-sm ml-1 ${i === current.plateIndex ? "btn-primary" : ""}`;
      btn.textContent = String(i + 1);
      btn.onclick = () => { current.plateIndex = i; drawPreview(); };
      nav.append(btn);
    });
  }
}

// ---------- downloads ----------

function saveBytes(bytes, filename, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function download() {
  const fmt = state.ui.format;
  // Tell the 3MF flavours apart by name; Bambu is the default and keeps the plain name.
  const tag = { prusa: "_prusa", generic: "_generic", stlcolors: "_stl" }[fmt] || "";
  const colors = { 1: state.ui.color1.toUpperCase(), 2: state.ui.color2.toUpperCase() };
  const built = current.built || [];
  if (!built.length) return;
  if (state.ui.mode === "single") {
    const name = built[0].name;
    const { bytes, ext, mime } = encode(fmt, current.plates[0].objects, { colors, base: name });
    return saveBytes(bytes, `${name}${tag}.${ext}`, mime);
  }
  // Batch: one file per plate (or per badge), zipped together when there are several.
  const files = {};
  if (state.ui.perBadge) {
    for (const b of built) {
      const [plate] = layoutPlates([b], { bed: state.ui.bed });
      const { bytes, ext } = encode(fmt, plate.objects, { colors, base: b.name });
      files[`${b.name}${tag}.${ext}`] = bytes;
    }
  } else {
    current.plates.forEach((p, i) => {
      const base = current.plates.length > 1 ? `badges_plate${i + 1}` : "badges_plate";
      const { bytes, ext } = encode(fmt, p.objects, { colors, base });
      files[`${base}${tag}.${ext}`] = bytes;
    });
  }
  const names = Object.keys(files);
  if (names.length === 1) return saveBytes(files[names[0]], names[0], FORMATS[fmt].mime);
  files["NOTICE.txt"] = NOTICE + "\n";
  saveBytes(zipFiles(files), `badges${tag}.zip`, "application/zip");
}

// ---------- startup ----------

function bind() {
  for (const b of $$("[data-mode]")) b.addEventListener("click", () => { setMode(b.dataset.mode); save(); });
  for (const b of $$("[data-view]")) b.addEventListener("click", () => { setView(b.dataset.view); save(); });
  for (const el of $$("[data-spec], [data-ui]")) {
    el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" || el.type === "color" ? "change" : "input", () => {
      if (el.id === "white_core") {
        // Keep the cap at the matching default when switching core styles (2 vs 1 fine layer).
        const relief = $("#relief");
        if (el.value === "false" && relief.value === "0.16") relief.value = "0.08";
        if (el.value === "true" && relief.value === "0.08") relief.value = "0.16";
      }
      if (el.dataset.ui === "color1" || el.dataset.ui === "color2" || el.dataset.ui === "format") {
        readForm(); save(); syncVisibility(); drawPreview();
        return;
      }
      syncVisibility();
      schedule();
    });
  }
  $("#fontFile").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      assets.uploadedFont = opentype.parse(await f.arrayBuffer());
      schedule(0);
    } catch (e) {
      current.errors = [`That font couldn't be read (${e.message}). Use a .ttf, .otf or .woff file.`];
      showMessages();
    }
  });
  $("#logoFile").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const doc = new DOMParser().parseFromString(await f.text(), "image/svg+xml");
    if (doc.getElementsByTagName("parsererror").length) {
      current.errors = ["That SVG couldn't be read."];
      showMessages();
      return;
    }
    assets.uploadedLogo = doc;
    schedule(0);
  });
  $("#download").addEventListener("click", () => {
    try { download(); } catch (e) { current.errors = [`Export failed: ${e.message}`]; showMessages(); }
  });
  $("#share").addEventListener("click", async () => {
    readForm();
    const url = location.href.split("#")[0] + encodeShare();
    try {
      await navigator.clipboard.writeText(url);
      $("#share").textContent = "Link copied";
    } catch {
      history.replaceState(null, "", url);
      $("#share").textContent = "Link is in the address bar";
    }
    setTimeout(() => { $("#share").textContent = "Copy share link"; }, 2500);
  });
  $("#reset").addEventListener("click", () => {
    state = { ui: { ...UI_DEFAULTS, mode: state.ui.mode }, spec: {} };
    writeForm();
    schedule(0);
  });
}

async function main() {
  const sel = $("#format");
  for (const [k, f] of Object.entries(FORMATS)) sel.append(new Option(f.label, k));
  load();
  writeForm();
  bind();
  try {
    const wasm = await Module();
    wasm.setup();
    kit = createBadgeKit(wasm);
    $("#loading").remove();
  } catch (e) {
    $("#loading").className = "flash flash-error mb-3";
    $("#loading").textContent = `This browser couldn't start the geometry engine (WebAssembly): ${e.message}`;
    return;
  }
  await rebuild();
}

main();
