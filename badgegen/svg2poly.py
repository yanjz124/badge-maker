"""Parse an SVG file (paths, basic shapes, transforms) into shapely geometry.

svgelements handles the SVG spec details (viewBox, nested group transforms, curve
math); we flatten every filled subpath to a polyline and hand the rings to the
even-odd builder. SVG's y-axis points down, so we flip y to get a normal y-up model.
"""
from __future__ import annotations

import numpy as np
import svgelements as se

from .polygons import rings_to_polygon


def svg_to_polygon(svg_path, flatten_step=0.25):
    """Return a shapely (Multi)Polygon for all filled shapes in an SVG file.

    flatten_step is the max spacing (in the SVG's own units) between sampled
    points along curves — smaller is smoother but heavier.
    """
    doc = se.SVG.parse(svg_path)
    rings = []
    for el in doc.elements():
        if not isinstance(el, se.Shape):
            continue
        # Skip shapes that are explicitly not filled (e.g. stroke-only guides).
        try:
            if el.values.get("fill", "").lower() == "none":
                continue
        except Exception:
            pass
        path = se.Path(el)  # absolute coords: element transform is baked in
        for sub in path.as_subpaths():
            subpath = se.Path(*list(sub))
            pts = []
            for seg in subpath:
                if isinstance(seg, se.Move):
                    p = seg.end
                    pts.append((p.x, -p.y))
                    continue
                length = 0.0
                try:
                    length = seg.length(error=1e-3)
                except Exception:
                    pass
                n = max(2, int(length / flatten_step) + 1)
                for i in range(1, n + 1):
                    p = seg.point(i / n)
                    pts.append((p.x, -p.y))
            if len(pts) >= 3:
                rings.append(np.array(pts, dtype=float))
    return rings_to_polygon(rings)
