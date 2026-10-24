"""2D outline helpers: turn text and SVG artwork into clean shapely geometry.

Both fonts and SVG artwork describe filled shapes as a set of closed rings, where
"holes" (the inside of an O, the gap in an A) are just rings nested inside other
rings. Neither source reliably tells us which rings are solid and which are holes,
so we resolve it geometrically with the even-odd rule: a ring nested an odd number
of levels deep is a hole, even is solid.
"""
from __future__ import annotations

import numpy as np
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely.affinity import scale as _scale, translate as _translate


def rings_to_polygon(rings):
    """Build a valid (Multi)Polygon from a flat list of closed rings (Nx2 arrays).

    Uses even-odd nesting via point-in-polygon containment so holes are handled
    correctly regardless of winding direction.
    """
    polys = []
    for r in rings:
        r = np.asarray(r, dtype=float)
        if len(r) < 3:
            continue
        p = Polygon(r)
        if not p.is_valid:
            p = p.buffer(0)
        if p.is_empty or p.area <= 0:
            continue
        polys.append(p)
    if not polys:
        return MultiPolygon([])

    # Explode any multipart results from buffer(0) into single rings again.
    flat = []
    for p in polys:
        if p.geom_type == "MultiPolygon":
            flat.extend(list(p.geoms))
        else:
            flat.append(p)
    flat.sort(key=lambda p: p.area, reverse=True)

    solids, holes = [], []
    for p in flat:
        pt = p.representative_point()
        depth = sum(1 for q in flat if q.area > p.area and q.contains(pt))
        (holes if depth % 2 else solids).append(p)

    geom = unary_union(solids) if solids else MultiPolygon([])
    if holes:
        geom = geom.difference(unary_union(holes))
    if not geom.is_valid:
        geom = geom.buffer(0)
    return geom


def fit_into(geom, box, align="center"):
    """Scale (uniform, preserving aspect) and translate geom to fit inside box.

    box = (x0, y0, x1, y1). Returns geom centered in the box unless align is
    'top'/'bottom' for vertical placement.
    """
    minx, miny, maxx, maxy = geom.bounds
    gw, gh = maxx - minx, maxy - miny
    if gw <= 0 or gh <= 0:
        return geom
    bx0, by0, bx1, by1 = box
    bw, bh = bx1 - bx0, by1 - by0
    s = min(bw / gw, bh / gh)
    geom = _translate(geom, -minx, -miny)
    geom = _scale(geom, xfact=s, yfact=s, origin=(0, 0))
    nw, nh = gw * s, gh * s
    dx = bx0 + (bw - nw) / 2.0
    if align == "top":
        dy = by1 - nh
    elif align == "bottom":
        dy = by0
    else:
        dy = by0 + (bh - nh) / 2.0
    return _translate(geom, dx, dy)


def min_feature_width(geom, rel_loss=0.02):
    """Estimate the thinnest stroke in geom (mm), for printability checks.

    Uses morphological opening: opening by radius r (erode then dilate) leaves
    thick features untouched but deletes any stroke thinner than 2r. We bisect for
    the smallest r whose opening loses more than `rel_loss` of the total area; the
    thinnest stroke is then ~2r. Returns 0.0 for empty geometry.
    """
    if geom.is_empty or geom.area <= 0:
        return 0.0
    total = geom.area

    def loss(r):
        if r <= 0:
            return 0.0
        opened = geom.buffer(-r, join_style=2).buffer(r, join_style=2)
        return (total - opened.area) / total

    hi = max(geom.bounds[2] - geom.bounds[0], geom.bounds[3] - geom.bounds[1]) / 2.0
    if loss(hi) < rel_loss:  # essentially uniform; nothing notably thin
        return round(2.0 * hi, 3)
    lo = 0.0
    for _ in range(24):
        mid = (lo + hi) / 2.0
        if loss(mid) >= rel_loss:
            hi = mid
        else:
            lo = mid
    return 2.0 * hi
