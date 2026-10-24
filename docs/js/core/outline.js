// Turn SVG artwork and font glyphs into closed contours ([[x, y], ...] rings, y-up).
//
// No DOM or library dependencies beyond what the caller passes in: the SVG parser takes
// an already-parsed XML Document (DOMParser in the browser, @xmldom/xmldom in Node) and
// the font helper takes an opentype.js Font. Callers build a manifold CrossSection from
// the rings with the right fill rule.

// ---------- curve flattening ----------

function segs(len, step) {
  return Math.max(2, Math.min(256, Math.ceil(len / step)));
}

function cubic(out, p0, p1, p2, p3, step) {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = segs(len, step);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
}

function quad(out, p0, p1, p2, step) {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const n = segs(len, step);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}

// SVG elliptical arc (endpoint parameterization, spec F.6.5) sampled into points.
function arc(out, p0, rx, ry, phiDeg, largeArc, sweep, p1, step) {
  if (rx === 0 || ry === 0) { out.push(p1); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  if (largeArc === sweep) co = -co;
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2, cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = segs(Math.abs(dt) * Math.max(rx, ry), step);
  for (let i = 1; i <= n; i++) {
    const t = t0 + (dt * i) / n;
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
}

// ---------- SVG path data ----------

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function tokenize(d) {
  const out = [];
  let i = 0;
  while (i < d.length) {
    const ch = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { out.push(ch); i++; continue; }
    if (/[\s,]/.test(ch)) { i++; continue; }
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) { i++; continue; }
    out.push(m[0]); // kept as text so packed arc flags ("01") can be split later
    i = NUM.lastIndex;
  }
  return out;
}

const isCmd = (tok) => tok.length === 1 && /[A-Za-z]/.test(tok);

/** Parse SVG path data into rings (arrays of [x, y]) in the path's own user space. */
export function pathToRings(d, step) {
  const t = tokenize(d);
  const rings = [];
  let ring = null, cur = [0, 0], start = [0, 0], lastCtrl = null, lastCmd = "", i = 0, cmd = "";
  const num = () => parseFloat(t[i++]);
  const flag = () => {
    // Arc flags may be packed without separators ("a1 1 0 01 2 3"): the tokenizer reads
    // "01" as one number, so peel off one digit and leave the rest for the next read.
    const s = t[i];
    if (s.length > 1 && /^[01]/.test(s)) { t[i] = s.slice(1); return s[0] === "1"; }
    i++;
    return parseFloat(s) !== 0;
  };
  const begin = (p) => { if (ring && ring.length > 2) rings.push(ring); ring = [p]; };
  while (i < t.length) {
    if (isCmd(t[i])) cmd = t[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const pt = (x, y) => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    if (C === "Z") {
      if (ring && ring.length > 2) rings.push(ring);
      ring = null; cur = start; lastCtrl = null; lastCmd = "Z";
      continue;
    }
    if (!ring) begin(cur.slice());
    switch (C) {
      case "M": {
        const p = pt(num(), num());
        begin(p); cur = p; start = p; lastCtrl = null;
        cmd = rel ? "l" : "L"; // subsequent pairs are implicit lineto
        break;
      }
      case "L": { const p = pt(num(), num()); ring.push(p); cur = p; lastCtrl = null; break; }
      case "H": { const x = num(); const p = [rel ? cur[0] + x : x, cur[1]]; ring.push(p); cur = p; lastCtrl = null; break; }
      case "V": { const y = num(); const p = [cur[0], rel ? cur[1] + y : y]; ring.push(p); cur = p; lastCtrl = null; break; }
      case "C": {
        const c1 = pt(num(), num()), c2 = pt(num(), num()), p = pt(num(), num());
        cubic(ring, cur, c1, c2, p, step); lastCtrl = c2; cur = p; break;
      }
      case "S": {
        const c1 = lastCtrl && /[CS]/.test(lastCmd) ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const c2 = pt(num(), num()), p = pt(num(), num());
        cubic(ring, cur, c1, c2, p, step); lastCtrl = c2; cur = p; break;
      }
      case "Q": {
        const c = pt(num(), num()), p = pt(num(), num());
        quad(ring, cur, c, p, step); lastCtrl = c; cur = p; break;
      }
      case "T": {
        const c = lastCtrl && /[QT]/.test(lastCmd) ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const p = pt(num(), num());
        quad(ring, cur, c, p, step); lastCtrl = c; cur = p; break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), la = flag(), sw = flag(), p = pt(num(), num());
        arc(ring, cur, rx, ry, rot, la, sw, p, step); lastCtrl = null; cur = p; break;
      }
      default: i++;
    }
    lastCmd = C;
  }
  if (ring && ring.length > 2) rings.push(ring);
  return rings;
}

// ---------- SVG document ----------

const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

function parseTransform(s) {
  let m = IDENTITY;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r;
  while ((r = re.exec(s))) {
    const a = (r[2].match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) || []).map(Number);
    let n = IDENTITY;
    switch (r[1]) {
      case "matrix": n = a.length === 6 ? a : IDENTITY; break;
      case "translate": n = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case "scale": n = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0]; break;
      case "rotate": {
        const t = ((a[0] || 0) * Math.PI) / 180, c = Math.cos(t), s2 = Math.sin(t);
        n = [c, s2, -s2, c, 0, 0];
        if (a.length === 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case "skewX": n = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": n = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

function styleProp(el, name) {
  const st = el.getAttribute("style") || "";
  const m = st.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
  return (m ? m[1] : el.getAttribute(name) || "").trim().toLowerCase();
}

const SKIP = new Set(["defs", "clipPath", "mask", "symbol", "metadata", "title", "desc", "style", "pattern", "linearGradient", "radialGradient", "text"]);

function shapeRings(el, step) {
  const n = (k) => parseFloat(el.getAttribute(k) || "0");
  switch (el.localName || el.nodeName) {
    case "path": return pathToRings(el.getAttribute("d") || "", step);
    case "rect": {
      const x = n("x"), y = n("y"), w = n("width"), h = n("height");
      let rx = parseFloat(el.getAttribute("rx")), ry = parseFloat(el.getAttribute("ry"));
      if (isNaN(rx)) rx = isNaN(ry) ? 0 : ry;
      if (isNaN(ry)) ry = rx;
      if (!rx) return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
      return pathToRings(`M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}`
        + `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}`
        + `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`, step);
    }
    case "circle": case "ellipse": {
      const cx = n("cx"), cy = n("cy");
      const rx = el.getAttribute("r") != null ? n("r") : n("rx"), ry = el.getAttribute("r") != null ? n("r") : n("ry");
      return pathToRings(`M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`, step);
    }
    case "polygon": case "polyline": {
      const v = (el.getAttribute("points") || "").match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) || [];
      const ring = [];
      for (let i = 0; i + 1 < v.length; i += 2) ring.push([+v[i], +v[i + 1]]);
      return ring.length > 2 ? [ring] : [];
    }
  }
  return [];
}

/**
 * All filled shapes of an SVG document as rings, y flipped to point up.
 * Skips stroke-only shapes (fill="none") and non-rendered containers (defs, masks...).
 */
export function svgDocToRings(doc) {
  const root = doc.documentElement;
  const vb = (root.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  const size = vb.length === 4 && vb[2] > 0 ? Math.max(vb[2], vb[3])
    : Math.max(parseFloat(root.getAttribute("width")) || 100, parseFloat(root.getAttribute("height")) || 100);
  const step = size / 800;
  const rings = [];
  const walk = (el, m, hidden) => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const tag = c.localName || c.nodeName;
      if (SKIP.has(tag)) continue;
      const cm = mul(m, parseTransform(c.getAttribute("transform")));
      const fill = styleProp(c, "fill");
      const noFill = fill === "none" || (hidden && !fill);
      if (styleProp(c, "display") === "none" || styleProp(c, "visibility") === "hidden") continue;
      if (tag === "g" || tag === "svg" || tag === "a") { walk(c, cm, fill === "none" || hidden); continue; }
      if (noFill) continue;
      for (const r of shapeRings(c, step)) {
        rings.push(r.map(([x, y]) => [cm[0] * x + cm[2] * y + cm[4], -(cm[1] * x + cm[3] * y + cm[5])]));
      }
    }
  };
  walk(root, IDENTITY, false);
  return rings;
}

// ---------- fonts ----------

/** Rings for `text` set in an opentype.js Font (kerning applied), y up. */
export function textToRings(font, text, size = 100) {
  const path = font.getPath(text, 0, 0, size, { kerning: true });
  const rings = [];
  const step = size / 200;
  let ring = null, cur = [0, 0];
  const close = () => { if (ring && ring.length > 2) rings.push(ring); ring = null; };
  for (const c of path.commands) {
    switch (c.type) {
      case "M": close(); cur = [c.x, c.y]; ring = [cur]; break;
      case "L": cur = [c.x, c.y]; ring.push(cur); break;
      case "C": cubic(ring, cur, [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y], step); cur = [c.x, c.y]; break;
      case "Q": quad(ring, cur, [c.x1, c.y1], [c.x, c.y], step); cur = [c.x, c.y]; break;
      case "Z": close(); break;
    }
  }
  close();
  return rings.map((r) => r.map(([x, y]) => [x, -y]));
}
