"""Render a quick top-down PNG preview of the badge front (white on black)."""
from __future__ import annotations

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import PathPatch
from matplotlib.path import Path as MplPath
from shapely.geometry.polygon import orient
import numpy as np


def _poly_to_patch(poly, **kw):
    # matplotlib fills compound paths by winding order, so holes only render if the
    # interior rings wind opposite the exterior. Orient exterior CCW / holes CW.
    poly = orient(poly, sign=1.0)
    verts, codes = [], []
    rings = [poly.exterior] + list(poly.interiors)
    for r in rings:
        pts = np.asarray(r.coords)
        verts.extend(pts)
        codes.append(MplPath.MOVETO)
        codes.extend([MplPath.LINETO] * (len(pts) - 2))
        codes.append(MplPath.CLOSEPOLY)
    return PathPatch(MplPath(verts, codes), **kw)


def save_preview(inlay_geom, spec, path):
    from .badge import _rounded_rect
    polys = list(inlay_geom.geoms) if inlay_geom.geom_type == "MultiPolygon" else [inlay_geom]
    fig, ax = plt.subplots(figsize=(spec.width_in, spec.height_in), dpi=200)
    plate = _rounded_rect(spec.width, spec.height, spec.corner_radius)
    ax.add_patch(_poly_to_patch(plate, facecolor="#191919", edgecolor="none"))
    for p in polys:
        if p.area > 0:
            ax.add_patch(_poly_to_patch(p, facecolor="#ededed", edgecolor="none"))
    ax.set_xlim(-2, spec.width + 2)
    ax.set_ylim(-2, spec.height + 2)
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(path, bbox_inches="tight", pad_inches=0.05, facecolor="#444444")
    plt.close(fig)
