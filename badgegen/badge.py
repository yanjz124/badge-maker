"""Assemble the badge geometry from text + logo into printable meshes.

Coordinate convention (millimetres, z-up):
  * The FRONT face sits on the z=0 plane. Print face-down so this whole face
    lands on the textured build plate.
  * The text + logo form a coplanar INLAY occupying z in [0, inlay_depth], flush
    with the front. The BODY is the rest of the plate with the inlay cavity
    subtracted. Exported as two 3MF parts -> assign two filaments in the slicer.
  * Back features (pin channel / magnet pockets) are recessed from the back face
    at z = thickness.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import trimesh
from shapely.geometry import Polygon, MultiPolygon, box as shbox
from shapely.affinity import scale as _scale
from shapely.ops import unary_union

from . import MM_PER_INCH
from .polygons import fit_into, min_feature_width
from .text2poly import text_to_polygon
from .svg2poly import svg_to_polygon

BODY_COLOR = [25, 25, 25, 255]      # near-black plate
INLAY_COLOR = [235, 235, 235, 255]  # near-white text/logo


@dataclass
class BadgeSpec:
    line1: str = "ELDER BERGET"  # free text (whatever you want)
    line2: str = ""              # optional second line
    logo_svg: str | None = None
    font_path: str = r"C:\Windows\Fonts\framd.ttf"  # Franklin Gothic Medium (US Army nameplate font)

    width_in: float = 3.0
    height_in: float = 1.75
    thickness: float = 2.6      # total plate thickness (z)
    inlay_depth: float = 0.8    # thickness of the colored inlay body (mm)
    corner_radius: float = 3.0  # rounded plate corners (mm); 0 = square

    relief_style: str = "recessed"  # 'recessed' (carved) | 'raised' (embossed) | 'flush'
    relief: float = 0.2         # carve depth / emboss height (mm) — shallow so white stays readable
    reveal_layer: bool = False  # recessed: solid white slab (counters become floating chips) vs.
                                # letter-shaped white inserts (counters stay solid black pillars — robust)
    edge_black: float = 1.2     # black border ring width so edges/back stay black (mm)
    print_side: str = "up"      # 'up' = text face-up (back on plate) | 'down' = text against plate
    mirror: bool = True         # mirror text in X (only applies to face-down printing)

    text_height: float = 6.0    # cap height of a text line (mm); long lines shrink to fit width
    line_gap: float = 0.35      # gap between the two lines, as a fraction of text_height
    logo_grow: float = 0.0      # outward buffer to thicken thin logo strokes (mm)
    logo_scale: float = 0.90    # shrink logo within its region (1.0 = fill region)
    simplify_tol: float = 0.02  # polygon simplify tolerance (mm) — cleaner mesh, fewer slivers
    margin: float = 2.0         # edge keep-clear (mm)
    vgap: float = 2.0           # gap between text block and logo block (mm)

    nozzle: float = 0.4         # nozzle diameter (mm); drives the min-stroke warning
    back: str = "magnet"        # 'magnet' | 'pin' | 'blank'
    back_skin: float = 0.4      # min black between a back pocket and the white inlay (mm)
    thickness_step: float = 0.0  # >0: round thickness up to a multiple of this (layer-grid alignment)
    pin_len: float = 40.0
    pin_height: float = 3.2
    pin_depth: float = 1.0      # recesses the flat base of a stick-on bar pin
    pin_center_frac: float = 0.62   # vertical position of pin channel (0=bottom,1=top)
    magnet_diam: float = 10.2   # pocket for 10mm disc magnets (+0.2 clearance)
    magnet_depth: float = 2.1   # pocket for 2mm-thick magnets (+0.1 for glue)
    magnet_spacing: float = 40.0
    backer_wall: float = 4.0    # magnet backer: wall around each pocket (mm)
    backer_floor: float = 0.6   # magnet backer: solid floor under the pockets (mm)

    @property
    def width(self):
        return self.width_in * MM_PER_INCH

    @property
    def height(self):
        return self.height_in * MM_PER_INCH


def _extrude(geom, height, z0=0.0):
    """Extrude a shapely Polygon/MultiPolygon into a mesh spanning z in [z0, z0+height]."""
    if geom.is_empty:
        raise ValueError("Cannot extrude empty geometry")
    polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    meshes = [trimesh.creation.extrude_polygon(p, height=height) for p in polys if p.area > 0]
    mesh = trimesh.util.concatenate(meshes)
    if z0:
        mesh.apply_translation((0, 0, z0))
    return mesh


def build_front_polygon(spec: BadgeSpec):
    """Return (inlay_geom, report) — the combined 2D inlay outline in badge coords."""
    W, H, m = spec.width, spec.height, spec.margin
    mid = H / 2.0
    cx0, cx1 = m, W - m

    parts = []
    report = {}

    # --- Upper half: one or two free-text lines, centered and capped at text_height. ---
    up_y0, up_y1 = mid + spec.vgap / 2.0, H - m
    Uh = up_y1 - up_y0
    cy = (up_y0 + up_y1) / 2.0
    avail_w = cx1 - cx0

    lines = [t for t in (spec.line1, spec.line2) if (t or "").strip()]
    n = len(lines)
    overflow = 0.0
    if n:
        gap = spec.text_height * spec.line_gap
        th = spec.text_height
        block = n * th + (n - 1) * gap
        if block > Uh:                       # too tall for two lines: scale down to fit
            f = Uh / block
            th *= f
            gap *= f
            block = Uh
        top = cy + block / 2.0
        for i, text in enumerate(lines):
            poly = text_to_polygon(text, spec.font_path)
            bx = poly.bounds
            natural_w = (bx[2] - bx[0]) / (bx[3] - bx[1]) * th   # width if drawn at cap height th
            overflow = max(overflow, natural_w / avail_w)         # >1 means it had to shrink
            line_cy = top - th / 2.0 - i * (th + gap)
            parts.append(fit_into(poly, (cx0, line_cy - th / 2.0, cx1, line_cy + th / 2.0)))

    # --- Lower half: logo, centered, aspect preserved. ---
    logo_min = None
    if spec.logo_svg:
        low_box = (cx0, m, cx1, mid - spec.vgap / 2.0)
        logo = fit_into(svg_to_polygon(spec.logo_svg), low_box)
        if spec.logo_scale != 1.0:
            logo = _scale(logo, xfact=spec.logo_scale, yfact=spec.logo_scale, origin="centroid")
        if spec.logo_grow > 0:
            logo = logo.buffer(spec.logo_grow, join_style=1)
            # Grown letters can end up touching at a single point; close+open by a hair so
            # they fuse into one solid instead of meshing as a non-manifold pinch.
            logo = logo.buffer(0.01, join_style=1).buffer(-0.01, join_style=1)
        logo_min = round(min_feature_width(logo), 3)
        parts.append(logo)

    # Combine the (non-overlapping) text lines + logo by collecting polygons, NOT by
    # unary_union: the union overlay snaps thin holes shut (it was closing the crescent
    # counter of the italic SkyWest 'e'). The parts are laid out disjoint, so a plain
    # MultiPolygon is both correct and hole-preserving.
    flat = []
    for p in parts:
        if p.is_empty:
            continue
        flat.extend(list(p.geoms) if p.geom_type == "MultiPolygon" else [p])
    inlay = MultiPolygon(flat)
    if spec.simplify_tol > 0:      # trim excess vertices (esp. the detailed logo) for a cleaner mesh
        inlay = inlay.simplify(spec.simplify_tol)
        if not inlay.is_valid:
            inlay = inlay.buffer(0)
    report["min_stroke_mm"] = round(min_feature_width(inlay), 3)
    report["logo_min_stroke_mm"] = logo_min
    report["text_overflow"] = round(overflow, 3)   # >1.0 => a line was wider than the tag and got shrunk
    return inlay, report


def _rounded_rect(W, H, r):
    """Rounded WxH rectangle as a shapely polygon (corner radius r, 0 = square)."""
    if r <= 0:
        return shbox(0, 0, W, H)
    r = min(r, W / 2.0, H / 2.0)
    return shbox(r, r, W - r, H - r).buffer(r, join_style=1, quad_segs=24)


def _plate(spec: BadgeSpec):
    W, H, T = spec.width, spec.height, spec.thickness
    return _extrude(_rounded_rect(W, H, spec.corner_radius), T)  # z in [0, T]


def _white_region(spec: BadgeSpec):
    """Rounded rectangle for the white reveal layer, inset so edges/back stay black."""
    e = spec.edge_black
    W, H = spec.width - 2 * e, spec.height - 2 * e
    from shapely.affinity import translate as _tr
    return _tr(_rounded_rect(W, H, max(spec.corner_radius - e, 0)), e, e)


def _back_cutter(spec: BadgeSpec):
    """Return a mesh to subtract from the back, or None for a blank back."""
    W, H, T = spec.width, spec.height, spec.thickness
    if spec.back == "pin":
        cutter = trimesh.creation.box(extents=(spec.pin_len, spec.pin_height, spec.pin_depth * 2))
        cutter.apply_translation((W / 2.0, H * spec.pin_center_frac, T))  # centered on back plane
        return cutter
    if spec.back == "magnet":
        pockets = []
        for sign in (-1, 1):
            cyl = trimesh.creation.cylinder(radius=spec.magnet_diam / 2.0,
                                            height=spec.magnet_depth * 2, sections=48)
            cyl.apply_translation((W / 2.0 + sign * spec.magnet_spacing / 2.0, H / 2.0, T))
            pockets.append(cyl)
        return trimesh.util.concatenate(pockets)
    return None


def _back_depth(spec: BadgeSpec):
    return {"pin": spec.pin_depth, "magnet": spec.magnet_depth}.get(spec.back, 0.0)


def required_thickness(spec: BadgeSpec):
    """Thinnest plate that keeps `back_skin` of black between back pockets and the inlay."""
    front = spec.inlay_depth if spec.relief_style in ("raised", "flush") else spec.relief + spec.inlay_depth
    back = _back_depth(spec)
    return round(front + (spec.back_skin + back if back else 0.0), 3)


def build_backer(spec: BadgeSpec):
    """Inside-the-shirt magnet backer: a stadium bar with pockets matching the badge's.

    Printed pockets-up; the open pocket faces the shirt so each magnet pair is separated
    only by fabric. Positioned just above the badge (+y) so both share one plate.
    """
    d, w = spec.magnet_diam, spec.backer_wall
    L, Wd = spec.magnet_spacing + d + 2 * w, d + 2 * w
    Tb = spec.magnet_depth + spec.backer_floor
    from shapely.affinity import translate as _tr
    bar = _extrude(_tr(_rounded_rect(L, Wd, Wd / 2.0), -L / 2.0, -Wd / 2.0), Tb)
    pockets = []
    for sign in (-1, 1):
        cyl = trimesh.creation.cylinder(radius=d / 2.0, height=spec.magnet_depth * 2, sections=64)
        cyl.apply_translation((sign * spec.magnet_spacing / 2.0, 0, Tb))
        pockets.append(cyl)
    backer = bar.difference(trimesh.util.concatenate(pockets), engine="manifold")
    backer.apply_translation((spec.width / 2.0, spec.height + 6.0 + Wd / 2.0, 0))
    backer.visual.face_colors = BODY_COLOR
    return backer


def build_badge(spec: BadgeSpec):
    """Build the badge. Returns (body_mesh, inlay_mesh, report).

    The front face is the z=0 side. The colored inlay carries the text/logo; the
    relief style sets where it sits relative to the front surface:
      * recessed - inlay floor is `relief` mm behind the front; the body has an
        open text-shaped pocket in front of it (engraved / carved look).
      * raised   - inlay protrudes `relief` mm proud of the front (embossed).
      * flush    - inlay top is coplanar with the front (color only, no relief).
    """
    inlay_geom, report = build_front_polygon(spec)
    need = max(spec.thickness, required_thickness(spec))
    if spec.thickness_step > 0:
        # Snap to a layer grid so the white top and the badge top land on layer boundaries.
        need = round(np.ceil(need / spec.thickness_step - 1e-6) * spec.thickness_step, 4)
    if need != spec.thickness:
        # A back pocket would cut into (or sit right against) the white inlay, or the
        # thickness was snapped to the layer grid: thicken.
        report["thickened_from_mm"] = spec.thickness
        spec.thickness = need
    if spec.mirror and spec.print_side == "down":
        # Face-down: the front is viewed from the bed side, so mirror the content in X
        # about the centerline to read correctly. Face-up is viewed directly (no mirror).
        inlay_geom = _scale(inlay_geom, xfact=-1, yfact=1, origin=(spec.width / 2.0, 0))
    d, wh = spec.relief, spec.inlay_depth
    style = spec.relief_style

    if style == "raised":
        inlay = _extrude(inlay_geom, d + wh, z0=-d)          # [-d, wh]: proud by d
        cavity = _extrude(inlay_geom, wh)                    # [0, wh] carved from body
    elif style == "flush":
        inlay = _extrude(inlay_geom, wh)                     # [0, wh]
        cavity = _extrude(inlay_geom, wh)
    elif spec.reveal_layer:  # recessed, 2-ply engraving reveal (black cap / white core / black back)
        groove = _extrude(inlay_geom, d)                     # [0, d] cut text through the black cap
        inlay = _extrude(_white_region(spec), wh, z0=d)      # [d, d+wh] solid white reveal layer
        cavity = trimesh.util.concatenate([groove, inlay])   # remove groove + white volume from black
    else:  # recessed with isolated white letter inserts (no full core)
        inlay = _extrude(inlay_geom, wh, z0=d)               # [d, d+wh]: floor behind front
        cavity = _extrude(inlay_geom, d + wh)               # [0, d+wh] open pocket + floor slot

    body = _plate(spec).difference(cavity, engine="manifold")

    back = _back_cutter(spec)
    if back is not None:
        body = body.difference(back, engine="manifold")

    for mesh in (body, inlay):     # drop degenerate faces / stray verts from the booleans
        mesh.update_faces(mesh.nondegenerate_faces())
        mesh.remove_unreferenced_vertices()
        mesh.merge_vertices()

    if spec.print_side == "up":
        # Reflect z -> T-z so the front/text lands on top and the back sits on the plate.
        # (Reflection flips winding; trimesh corrects it so normals stay outward.)
        flip = np.array([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, spec.thickness], [0, 0, 0, 1]], float)
        for mesh in (body, inlay):
            mesh.apply_transform(flip)

    inlay.visual.face_colors = INLAY_COLOR
    body.visual.face_colors = BODY_COLOR

    report.update(
        width_mm=round(spec.width, 2),
        height_mm=round(spec.height, 2),
        thickness_mm=spec.thickness,
        relief_style=style,
        relief_mm=d,
        print_side=spec.print_side,
        nozzle_mm=spec.nozzle,
        back=spec.back,
        body_watertight=bool(body.is_watertight),
        inlay_watertight=bool(inlay.is_watertight),
    )
    return body, inlay, report
