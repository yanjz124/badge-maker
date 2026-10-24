"""Write a Bambu Studio / Orca-compatible two-color 3MF.

Bambu/Orca ignore the 3MF core-spec `basematerials`; they map filaments through
their own `Metadata/model_settings.config`, using a per-part `extruder` slot
(1-based). To make the badge open as a single two-color object, we author the 3MF
by hand: two component objects (body, inlay) grouped under one assembly object,
and a model_settings.config that puts body on filament 1 and inlay on filament 2.

We deliberately do NOT write project_settings.config, so importing the badge does
not overwrite the user's printer/print profile. The two parts simply land on
filament slots 1 and 2 — the user sets slot 1 = black, slot 2 = white.
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np

CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
"""
RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
"""


def _mesh_xml(mesh):
    v = np.asarray(mesh.vertices, float)
    f = np.asarray(mesh.faces, np.int64)
    verts = "".join(f'<vertex x="{x:.4f}" y="{y:.4f}" z="{z:.4f}"/>' for x, y, z in v)
    tris = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in f)
    return f"<mesh><vertices>{verts}</vertices><triangles>{tris}</triangles></mesh>"


def write_bambu_3mf(objects, path):
    """Write a Bambu/Orca 3MF to `path`.

    objects: list of (assembly_name, parts, settings[, layer_ranges]). Each becomes one
    object on the plate; parts is a list of (mesh, part_name, filament_slot) with 1-based slots
    (1 = first AMS slot, ...). settings is a dict of per-object print overrides
    (e.g. {"ironing_type": "top"}) — stored on the object only, so the user's
    printer/process profile is left alone. layer_ranges is an optional list of
    (min_z, max_z, layer_height): a height-range modifier (Bambu's "layer range"),
    e.g. finer layers only for the top of the badge.
    """
    path = Path(path)
    resources, items, cfg, ranges_xml = [], [], [], []
    next_id = 1
    for obj_idx, (asm_name, parts, settings, *extra) in enumerate(objects, start=1):
        part_ids = []
        for mesh, name, _slot in parts:
            resources.append(f'<object id="{next_id}" type="model" name="{name}">{_mesh_xml(mesh)}</object>')
            part_ids.append(next_id)
            next_id += 1
        asm_id = next_id
        next_id += 1
        components = "".join(f'<component objectid="{i}"/>' for i in part_ids)
        resources.append(f'<object id="{asm_id}" type="model" name="{asm_name}">'
                         f"<components>{components}</components></object>")
        items.append(f'<item objectid="{asm_id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>')

        # Bambu part->filament mapping (parts are the component objects).
        lines = [f' <object id="{asm_id}">', f'  <metadata key="name" value="{asm_name}"/>']
        lines += [f'  <metadata key="{k}" value="{v}"/>' for k, v in (settings or {}).items()]
        for pid, (_m, name, slot) in zip(part_ids, parts):
            lines += [f'  <part id="{pid}" subtype="normal_part">',
                      f'   <metadata key="name" value="{name}"/>',
                      f'   <metadata key="extruder" value="{slot}"/>',
                      '  </part>']
        lines.append(' </object>')
        cfg.append("\n".join(lines))

        # Height-range modifiers are keyed by the object's 1-based order in the model.
        if extra and extra[0]:
            r = [f' <object id="{obj_idx}">']
            for z0, z1, lh in extra[0]:
                r += [f'  <range min_z="{z0:.4f}" max_z="{z1:.4f}">',
                      '   <option opt_key="extruder">0</option>',
                      f'   <option opt_key="layer_height">{lh:g}</option>',
                      '  </range>']
            r.append(' </object>')
            ranges_xml.append("\n".join(r))

    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="millimeter" xml:lang="en-US" xmlns="{CORE_NS}">\n'
        "<resources>" + "".join(resources) + "</resources>\n"
        "<build>" + "".join(items) + "</build>\n"
        "</model>\n"
    )
    model_settings = ('<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'
                      + "\n".join(cfg) + "\n</config>\n")

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", model_settings)
        if ranges_xml:
            z.writestr("Metadata/layer_config_ranges.xml",
                       '<?xml version="1.0" encoding="utf-8"?>\n<objects>\n'
                       + "\n".join(ranges_xml) + "\n</objects>\n")
    return path
