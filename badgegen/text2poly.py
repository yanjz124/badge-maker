"""Render text with a TTF font into shapely geometry (with correct letter holes)."""
from __future__ import annotations

from matplotlib.textpath import TextPath
from matplotlib.font_manager import FontProperties

from .polygons import rings_to_polygon


def text_to_polygon(text, font_path, size=100.0):
    """Return a shapely (Multi)Polygon for `text` rendered in the given TTF font.

    The returned geometry sits near the origin at an arbitrary scale (`size` in
    font points); callers scale it to fit with polygons.fit_into().
    Baseline layout and kerning are handled by matplotlib's TextPath.
    """
    text = text or ""
    if not text.strip():
        return rings_to_polygon([])
    fp = FontProperties(fname=font_path)
    tp = TextPath((0, 0), text, size=size, prop=fp)
    rings = tp.to_polygons(closed_only=True)
    return rings_to_polygon(rings)
