#!/usr/bin/env python3
"""ElderPrice3D — generate an LDS missionary badge STL/3MF from the command line.

Examples
--------
  python generate.py --title ELDER --name SMITH
  python generate.py --title SISTER --name "GARCIA" --logo assets/church_logo.svg
  python generate.py --name NELSON --back magnet --out output/elder_nelson

Outputs a two-part 3MF (body + inlay -> two AMS filaments) and a combined STL.
Prints text FACE-UP by default (ironed top). Magnet back adds an inside-shirt backer.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import trimesh

from badgegen.badge import BadgeSpec, build_badge, BODY_COLOR, INLAY_COLOR


def _slug(*parts):
    s = "_".join(p for p in parts if p).strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s or "badge"


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Generate an LDS missionary badge (3MF + STL).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--line1", default="ELDER BERGET", help="Text (whatever you want)")
    ap.add_argument("--line2", default="", help="Optional second line")
    ap.add_argument("--logo", default="assets/church_logo.svg",
                    help="SVG artwork for the lower half (use '' for none)")
    ap.add_argument("--logo-grow", type=float, default=0.05,
                    help="Thicken thin logo strokes by this many mm (outward buffer)")
    ap.add_argument("--logo-scale", type=float, default=0.90,
                    help="Shrink the logo within its region (1.0 = fill)")
    ap.add_argument("--font", default=r"C:\Windows\Fonts\framd.ttf",
                    help="Path to a .ttf font (Franklin Gothic/Army default; try FRAMDCN.TTF, arialbd.ttf)")
    ap.add_argument("--text-height", type=float, default=6.0,
                    help="Cap height of a text line (mm); smaller = more side margin")
    ap.add_argument("--out", default=None,
                    help="Output path stem (no extension). Default: output/<line1>")

    ap.add_argument("--width-in", type=float, default=3.0)
    ap.add_argument("--height-in", type=float, default=1.75)
    ap.add_argument("--thickness", type=float, default=2.6, help="Plate thickness (mm)")
    ap.add_argument("--inlay-depth", type=float, default=0.8,
                    help="Depth of the two-color inlay from the front (mm)")
    ap.add_argument("--corner-radius", type=float, default=3.0,
                    help="Rounded plate corner radius (mm); 0 = square")
    ap.add_argument("--relief", choices=["recessed", "raised", "flush"], default="recessed",
                    help="Text/logo relief: recessed (carved), raised (embossed), or flush")
    ap.add_argument("--relief-depth", type=float, default=None,
                    help="Carve depth / emboss height (mm) = black cap over the white. Default: 2 top"
                         " layers (0.16) with the white core, 1 top layer (0.08) with --letter-inserts")
    ap.add_argument("--top-layer", type=float, default=0.08,
                    help="Face-up: layer height (mm) for the top of the badge (black lip + white"
                         " surface), via a height-range modifier in the 3MF; 0 = use the profile's")
    ap.add_argument("--face-down", action="store_true",
                    help="Print with the text against the plate (textured front). Default: text face-up")
    ap.add_argument("--letter-inserts", action="store_true",
                    help="Recessed: white only under the text/logo instead of a full white core"
                         " (default core works like engraved 2-ply plastic: mill anywhere -> white)")
    ap.add_argument("--edge-black", type=float, default=1.2,
                    help="Black border ring width so edges/back stay black (mm)")

    ap.add_argument("--nozzle", type=float, default=0.4,
                    help="Nozzle diameter (mm) for the min-stroke warning; use 0.2 for a 0.2mm hotend")
    ap.add_argument("--back", choices=["magnet", "pin", "blank"], default="magnet",
                    help="Back fastening: magnet (2x 10x2mm discs + printed inside-shirt backer),"
                         " pin (channel for a stick-on bar pin), or blank")
    ap.add_argument("--pin-depth", type=float, default=1.0,
                    help="Pin back: channel depth (mm); 1.8 = the original deeper slot")
    ap.add_argument("--no-backer", action="store_true",
                    help="Magnet back: don't add the inside-shirt backer to the plate")
    ap.add_argument("--ironing", choices=["top", "topmost", "solid", "none"], default="top",
                    help="Per-object ironing for the badge (top = all top surfaces incl. letter floors)")
    ap.add_argument("--plate", nargs="+", metavar="TEXT", default=None,
                    help="Put several badges (one per TEXT, e.g. 'ELDER YAN') and their backers on"
                         " ONE build plate in a single 3MF; overrides --line1/--line2")
    ap.add_argument("--bed", type=float, default=256.0, help="Build plate size (mm, square) for --plate")
    ap.add_argument("--no-stl", action="store_true", help="Skip the combined STL export")
    ap.add_argument("--preview", action="store_true", help="Also save a PNG preview of the front")
    return ap.parse_args(argv)


TOP_ZONE = 0.4   # mm of fine layers at the top; also the thickness snap step


def _top_ranges(a, spec):
    """Fine layers for the top of a face-up badge, so the black cap over the white is thin.

    The badge is snapped to a multiple of TOP_ZONE (see main), and the range starts TOP_ZONE
    below the top: a boundary on the 0.08/0.1/0.2 layer grids, so the fine layers land
    exactly on the white top and the badge top."""
    if a.face_down or a.top_layer <= 0:
        return None
    T = spec.thickness                      # read after build_badge (it may have thickened)
    return [(round(T - TOP_ZONE, 4), T, a.top_layer)]


def _move_to(mesh, x, y):
    """Translate mesh so its XY bounding-box corner lands at (x, y)."""
    mesh.apply_translation((x - mesh.bounds[0][0], y - mesh.bounds[0][1], 0))


def build_plate(a, base):
    """Lay out one badge (+ magnet backer) per text on a single plate; write one 3MF/STL."""
    from dataclasses import replace
    from badgegen.threemf import write_bambu_3mf
    from badgegen.badge import build_backer

    gap = 6.0
    badge_settings = {} if a.ironing == "none" else {"ironing_type": a.ironing}
    rows, failed = [], False
    for text in a.plate:
        spec = replace(base, line1=text, line2="")
        print(f"Building badge: {text!r}")
        body, inlay, report = build_badge(spec)
        backer = build_backer(spec) if spec.back == "magnet" and not a.no_backer else None
        rows.append((text, spec, body, inlay, backer))
        failed |= not (report["body_watertight"] and report["inlay_watertight"])
        if report.get("text_overflow", 0) > 1.01:
            print(f"  ! {text!r} is too long and was shrunk {round((report['text_overflow'] - 1) * 100)}%")

    # Each row = badge, then its backer to the right. Rows stack in +y; wrap into
    # another column when a column would overflow the bed.
    W, H = base.width, base.height
    bw = max((r[4].extents[0] for r in rows if r[4] is not None), default=0.0)
    row_w = W + (gap + bw if bw else 0.0)
    per_col = max(1, int((a.bed - 10 + gap) // (H + gap)))
    ncols = -(-len(rows) // per_col)
    nrows = min(len(rows), per_col)
    total_w = ncols * row_w + (ncols - 1) * gap * 2
    total_h = nrows * H + (nrows - 1) * gap
    if total_w > a.bed - 10 or total_h > a.bed - 10:
        print(f"  ! warning: layout {total_w:.0f}x{total_h:.0f}mm may not fit a {a.bed:.0f}mm bed;"
              " split the names across several plates.")
    x0, y0 = (a.bed - total_w) / 2.0, (a.bed - total_h) / 2.0   # centered on the bed

    objects, meshes = [], []
    for i, (text, spec, body, inlay, backer) in enumerate(rows):
        col, row = divmod(i, per_col)
        x = x0 + col * (row_w + gap * 2)
        y = y0 + (nrows - 1 - row) * (H + gap)       # first name at the back (top) of the bed
        dx, dy = x - body.bounds[0][0], y - body.bounds[0][1]
        for m in (body, inlay):                      # move body+inlay together, keeping alignment
            m.apply_translation((dx, dy, 0))
        name = _slug(text)
        objects.append((name, [(body, "body", 1), (inlay, "inlay", 2)], badge_settings,
                        _top_ranges(a, spec)))
        meshes += [body, inlay]
        if backer is not None:
            _move_to(backer, x + W + gap, y + (H - backer.extents[1]) / 2.0)
            objects.append((f"{name}_backer", [(backer, "backer", 1)], {}))
            meshes.append(backer)

    out = Path(a.out or str(Path("output") / ("plate_" + "_".join(_slug(t) for t in a.plate))))
    out.parent.mkdir(parents=True, exist_ok=True)
    written = [write_bambu_3mf(objects, out.with_suffix(".3mf"))]
    if not a.no_stl:
        trimesh.util.concatenate(meshes).export(out.with_suffix(".stl"))
        written.append(out.with_suffix(".stl"))

    print(f"\nPlate: {len(rows)} badge(s){' + backers' if bw else ''}, layout {total_w:.0f}x{total_h:.0f}mm"
          f" centered on a {a.bed:.0f}mm bed. Thickness {rows[0][1].thickness}mm.")
    if failed:
        print("  ! warning: a mesh is not watertight — check the artwork/text.")
    print("Wrote:")
    for p in written:
        print(f"  {Path(p).resolve()}")
    print("\nSlicer: open the .3mf - every badge is its own object with body on filament 1 (black)"
          " and inlay on filament 2 (white); backers are black. Ironing is set per badge"
          f" ({a.ironing}). Text face-up. Just slice." if not a.face_down else "")


def main(argv=None):
    a = parse_args(argv)
    if a.relief_depth is None:
        # The white core puts the black cap over the whole face: 2 thin layers stay opaque black.
        layer = a.top_layer if a.top_layer > 0 else 0.1
        a.relief_depth = round(layer * (1 if a.letter_inserts else 2), 3)
    spec = BadgeSpec(
        line1=a.line1, line2=a.line2,
        logo_svg=(a.logo or None),
        logo_grow=a.logo_grow, logo_scale=a.logo_scale,
        font_path=a.font,
        width_in=a.width_in, height_in=a.height_in,
        thickness=a.thickness, inlay_depth=a.inlay_depth,
        corner_radius=a.corner_radius,
        relief_style=a.relief, relief=a.relief_depth,
        print_side=("down" if a.face_down else "up"),
        reveal_layer=not a.letter_inserts, edge_black=a.edge_black,
        text_height=a.text_height,
        nozzle=a.nozzle,
        back=a.back, pin_depth=a.pin_depth,
        thickness_step=(TOP_ZONE if a.top_layer > 0 and not a.face_down else 0.0),
    )

    if spec.logo_svg and not Path(spec.logo_svg).exists():
        sys.exit(f"error: logo file not found: {spec.logo_svg}")

    if a.plate:
        return build_plate(a, spec)

    label = " / ".join(t for t in (spec.line1, spec.line2) if t.strip())
    print(f"Building badge: {label!r}  ({spec.width_in}\" x {spec.height_in}\", back={spec.back})")
    body, inlay, report = build_badge(spec)

    stem = a.out or str(Path("output") / _slug(spec.line1, spec.line2))
    out = Path(stem)
    out.parent.mkdir(parents=True, exist_ok=True)

    # --- Bambu/Orca 3MF: one object, two parts (body=filament 1, inlay=filament 2). ---
    from badgegen.threemf import write_bambu_3mf
    from badgegen.badge import build_backer
    badge_settings = {} if a.ironing == "none" else {"ironing_type": a.ironing}
    objects = [(_slug(spec.line1, spec.line2), [(body, "body", 1), (inlay, "inlay", 2)], badge_settings,
                _top_ranges(a, spec))]
    backer = None
    if spec.back == "magnet" and not a.no_backer:
        backer = build_backer(spec)
        objects.append(("magnet_backer", [(backer, "backer", 1)], {}))
    path_3mf = out.with_suffix(".3mf")
    write_bambu_3mf(objects, path_3mf)

    written = [path_3mf]
    if not a.no_stl:
        combined = trimesh.util.concatenate([body, inlay])
        path_stl = out.with_suffix(".stl")
        combined.export(path_stl)
        written.append(path_stl)
        if backer is not None:
            path_b = out.with_name(out.name + "_backer.stl")
            backer.export(path_b)
            written.append(path_b)

    if a.preview:
        from badgegen.preview import save_preview
        from badgegen.badge import build_front_polygon
        inlay_geom, _ = build_front_polygon(spec)
        path_png = out.with_suffix(".png")
        save_preview(inlay_geom, spec, path_png)
        written.append(path_png)

    print("\n--- report ---")
    for k, v in report.items():
        print(f"  {k}: {v}")
    ov = report.get("text_overflow", 0)
    if ov and ov > 1.01:
        print(f"  ! warning: text is {round((ov-1)*100)}% wider than the tag at {spec.text_height}mm"
              f" cap height and was shrunk to fit. Shorten the text, add a second line (--line2),"
              f" lower --text-height, or use a condensed font (--font C:\\Windows\\Fonts\\FRAMDCN.TTF).")
    thin = report.get("logo_min_stroke_mm") or report.get("min_stroke_mm", 1)
    if thin is not None and thin < spec.nozzle * 1.05:
        print(f"  ! warning: thinnest stroke ~{thin}mm is at/under your {spec.nozzle}mm nozzle -"
              " it may print faint or lose color separation. Try a bigger --logo-grow, a larger badge,"
              " or a simpler/bolder logo.")
    if not report.get("body_watertight") or not report.get("inlay_watertight"):
        print("  ! warning: a mesh is not watertight — check the artwork/text.")
    if "thickened_from_mm" in report:
        print(f"  note: plate thickened {report['thickened_from_mm']} -> {spec.thickness}mm so the"
              f" {spec.back} pockets keep {spec.back_skin}mm of black under the white inlay.")
    if backer is not None:
        print("\nMagnets: 4x 10x2mm disc magnets (N52). Glue 2 into the badge pockets. For the backer,"
              " snap each loose magnet onto its badge magnet, then press the backer (pockets facing"
              " the badge) over them and glue - that guarantees every pair attracts. Wear it with"
              " the shirt clamped between badge and backer: no holes.")
    if a.ironing != "none":
        print(f"Ironing: set on the badge object ({a.ironing}); the backer is not ironed.")

    print("\nWrote:")
    for p in written:
        print(f"  {p.resolve()}")

    if a.face_down:
        orient = ("It's oriented text-DOWN (face on the plate) for a textured front; text is"
                  " mirrored so it reads correctly after printing. Just slice.")
    else:
        orient = ("It's oriented text-UP (back on the plate) so the crisp text is on top - no"
                  " flipping needed. Just slice.")
    print("\nSlicer (Bambu/Orca): open the .3mf - it comes in as ONE object with two parts already"
          " on filament 1 (body) and filament 2 (inlay). Set AMS slot 1 = black, slot 2 = white."
          f"\n{orient}")


if __name__ == "__main__":
    main()
