"""Optional native adapter using the pinned, public Luna Kit readers.

No archive extraction or PonyVista imports live here. The caller supplies a
small, already extracted dependency closure and explicitly selected submesh names.
A selected name keeps every matching native submesh (clothing parts may repeat).
Matrices and transforms remain in the game's coordinate system for core.py.
"""
from __future__ import annotations

import csv
import hashlib
import io
import math
import struct
from pathlib import Path
from typing import Collection

from .native_animation import read_animation, NATIVE_POSITION_SCALE

LUNA_COMMIT = "aeb659af80f973a7bb7d2d058f05b4fc1446bed3"


class NativeInputError(ValueError):
    """The supplied native dependency closure is unsupported or inconsistent."""


def _sibling(folder: Path, name: str) -> Path:
    candidate = (folder / name).resolve()
    if not candidate.is_relative_to(folder.resolve()):
        raise NativeInputError(f"Native dependency leaves its directory: {name}")
    if not candidate.is_file():
        raise NativeInputError(f"Missing native dependency: {candidate.name}")
    return candidate


def material_dependency_names(name: str) -> tuple[str, ...]:
    """Native material stems may retain a source-art extension.

    Preserve exact material lookup first. Only the two source-image suffixes
    confirmed by this catalogue may be removed; no numbered/name substitution.
    """
    exact = name + ".rkm"
    stem = Path(name)
    if stem.suffix.lower() in {".psd", ".tga"}:
        return exact, str(stem.with_suffix(".rkm"))
    return (exact,)


def _material_sibling(folder: Path, name: str) -> Path:
    for candidate in material_dependency_names(name):
        path = (folder / candidate).resolve()
        if not path.is_relative_to(folder.resolve()):
            raise NativeInputError(f"Native dependency leaves its directory: {name}")
        if path.is_file():
            return path
    raise NativeInputError(f"Missing native dependency: {name}.rkm")


def _validate_model_layout(path: Path) -> None:
    """Validate the section layouts understood by the pinned public reader."""
    raw = path.read_bytes()
    if len(raw) < 80 + 24 * 16:
        raise NativeInputError("Truncated RK model header")
    magic, major, minor = struct.unpack_from("<8sII", raw)
    if magic != b"RKFORMAT" or (major, minor) not in {(5, 0), (5, 1), (5, 2), (6, 2)}:
        raise NativeInputError("Unsupported RK model version")
    sections = {}
    for index in range(24):
        tag, offset, count, size = struct.unpack_from("<4I", raw, 80 + index * 16)
        if not tag:
            continue
        if tag in sections or (count and (offset < 80 + 24 * 16 or offset + size > len(raw))):
            raise NativeInputError("Invalid RK section bounds or duplicate tag")
        sections[tag] = (offset, count, size)
    def section(tag, stride=None):
        item = sections.get(tag)
        if item is None or not item[1] or item[2] % item[1] or (stride and item[2] != item[1] * stride):
            raise NativeInputError(f"Unsupported RK section layout: {tag}")
        return item
    vertices = section(3)
    submeshes = section(1, 16)
    section(2)  # Material names use the section-declared stride, not a fixed width.
    names = section(16, 64)
    if names[1] != submeshes[1]:
        raise NativeInputError("RK submesh/name counts differ")
    section(7, 140)
    weights = section(17, 12)
    if weights[1] != vertices[1]:
        raise NativeInputError("RK vertex/weight counts differ")
    faces = section(4)
    if faces[2] // faces[1] not in (2, 4) or faces[1] % 3:
        raise NativeInputError("Unsupported RK face index layout")
    # Luna reads faces sequentially, so check each declared range before it can
    # read beyond the face section or attach another submesh's triangles.
    next_index = 0
    for index in range(submeshes[1]):
        triangles, offset, _, _ = struct.unpack_from('<4I', raw, submeshes[0] + index * 16)
        if offset != next_index:
            raise NativeInputError("Non-contiguous native face layout is unsupported by the pinned parser")
        next_index = offset + triangles * 3
        if next_index > faces[1]:
            raise NativeInputError("Native submesh face range exceeds its declared section")
    attributes = section(13, 4)
    uv = [struct.unpack_from("<HBB", raw, attributes[0] + i * 4) for i in range(attributes[1])]
    uv = [row for row in uv if row[0] in (1026, 1030)]
    if len(uv) != 1 or uv[0][1] < 12 or uv[0][1] + (8 if uv[0][0] == 1026 else 4) > vertices[2] // vertices[1]:
        raise NativeInputError("Unsupported RK position/UV layout")


def _csv_clips(path: Path, frame_count: int, required: set[str]) -> tuple[list[dict], int, list[dict]]:
    result, seen, duplicates, diagnostics = [], {}, 0, []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        for line, row in enumerate(csv.reader(handle), 1):
            if not row:
                continue
            name = row[0]
            reason = None
            try:
                if len(row) != 4 or not name:
                    raise ValueError("expected name,start,end,fps")
                start, end, fps = int(row[1]), int(row[2]), float(row[3])
                valid_range = 0 <= start <= end < frame_count
                if not (valid_range and math.isfinite(fps) and fps > 0):
                    raise ValueError("out-of-range frames or invalid FPS")
            except ValueError as error:
                reason = str(error)
            if reason is not None:
                if name in required:
                    raise NativeInputError(f"Invalid selected animation CSV row {line}: {name}: {reason}")
                diagnostics.append({"line": line, "name": name, "reason": reason})
                continue
            if name not in required:
                continue
            key = (start, end, fps)
            if name in seen:
                if seen[name] != key:
                    raise NativeInputError(f"Conflicting animation declarations: {name}")
                duplicates += 1
                continue
            seen[name] = key
            result.append({"name": name, "start": start, "end": end, "fps": fps})
    return result, duplicates, diagnostics


def _verify_event_source(event_path, events_absent: bool, names: set[str]) -> tuple[dict, Path | None]:
    """Validate an explicit event source; absence must be asserted by discovery."""
    if bool(event_path) == bool(events_absent):
        raise NativeInputError("Supply an event XML or explicitly confirm its native source absence")
    if events_absent:
        return {"status": "source-absence-confirmed-by-caller", "checked_clips": sorted(names)}, None
    import re
    from xml.etree import ElementTree as ET
    path = Path(event_path).resolve()
    if not path.is_file():
        raise NativeInputError(f"Missing native event XML: {path.name}")
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
        if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.IGNORECASE):
            raise NativeInputError("DTD/entity declarations are unsupported in native event XML")
        text = re.sub(r"^\s*<\?xml[^>]*\?>", "", text)
        # Game files can contain both MeshList and AnimationList at top level.
        root = ET.fromstring("<NativeEventSource>" + text + "</NativeEventSource>")
    except (UnicodeError, ET.ParseError) as error:
        raise NativeInputError(f"Invalid native event XML: {path.name}") from error
    if any(node.tag not in {"MeshList", "AnimationList"} for node in root):
        raise NativeInputError("Unsupported native event document structure")
    for animation_list in root.iter("AnimationList"):
        if any(node.tag != "Animation" for node in animation_list):
            raise NativeInputError("Unsupported native animation declaration")
    for node in root.iter("Animation"):
        if node.get("Name") in names and set(node.attrib) != {"Name"}:
            raise NativeInputError("Unsupported selected native animation attributes")
        if node.get("Name") in names and len(node):
            raise NativeInputError(f"Selected animation requires unsupported native events: {node.get('Name')}")
    return {"status": "parsed-source-xml", "name": path.name,
            "sha256": hashlib.sha256(raw).hexdigest(), "checked_clips": sorted(names)}, path


def load_native(
    rk_path: str | Path,
    anim_path: str | Path,
    csv_path: str | Path,
    selected_names: Collection[str],
    *,
    visible_meshes: Collection[str],
    rest_name: str | None = None,
    rest_frame: int | None = None,
    event_path: str | Path | None = None,
    events_absent: bool = False,
) -> dict:
    """Read native files without axis changes, retargeting, or visibility guesses.

    ``bind_global`` uses column-vector matrices. ANIM translations/quaternions
    are global model-space, not parent-local. CSV end frames are inclusive.
    Version 5.2 / frame types 0, 1 and 4 are supported with exact length checks.
    ``rest_name`` names a native CSV clip whose first frame is the rest pose.
    Alternatively, ``rest_frame`` explicitly selects a native frame when the
    source declares no idle clip. The two inputs are mutually exclusive.
    Texture bytes are PNG-encoded by Pillow from Luna's decoded native image.
    Event XML or an explicit native-source absence declaration is required.
    Selected actions with events are rejected. Only the ordinary rkshader
    material is supported; special materials and controllers need a later PR.
    """
    import numpy as np
    try:
        from luna_kit.model import RKModel
        from luna_kit.model.rk import parse_rkm
        from luna_kit.pvr import PVR
        from luna_kit.utils import image_has_alpha, put_alpha
    except ImportError as error:
        raise NativeInputError("Install the pinned optional Luna Kit native dependencies") from error

    rk_path, anim_path, csv_path = map(lambda value: Path(value).resolve(), (rk_path, anim_path, csv_path))
    for path in (rk_path, anim_path, csv_path):
        if not path.is_file():
            raise NativeInputError(f"Missing native input: {path.name}")
    try:
        animation = read_animation(anim_path)
    except ValueError as error:
        raise NativeInputError(str(error)) from error
    major, minor, frame_type = animation.header.major, animation.header.minor, animation.header.frame_type
    frames = animation.header.frame_count
    _validate_model_layout(rk_path)
    model = RKModel(str(rk_path))
    if len(model.bones) != animation.header.bone_count:
        raise NativeInputError("Model and animation bone counts differ")
    if [bone.index for bone in model.bones] != list(range(len(model.bones))):
        raise NativeInputError("Non-contiguous native bone indices")
    for bone in model.bones:
        if bone.parentIndex >= bone.index or bone.parentIndex < -1:
            raise NativeInputError("Unsupported or cyclic bone hierarchy")
        matrix = np.asarray(bone.matrix_4x4, dtype=np.float64)
        if not np.isfinite(matrix).all() or abs(np.linalg.det(matrix)) < 1e-12:
            raise NativeInputError(f"Invalid bind matrix: {bone.name}")

    if (rest_name is None) == (rest_frame is None):
        raise NativeInputError("Specify exactly one native rest clip or rest frame")
    if rest_frame is not None and (isinstance(rest_frame, bool) or not isinstance(rest_frame, int) or not 0 <= rest_frame < frames):
        raise NativeInputError("Explicit native rest frame is out of range")
    selected = list(dict.fromkeys(selected_names))
    required_names = set(selected) | ({rest_name} if rest_name is not None else set())
    declarations, duplicates, csv_diagnostics = _csv_clips(csv_path, frames, required_names)
    by_name = {item["name"]: item for item in declarations}
    if not selected:
        raise NativeInputError("Select at least one native animation")
    for name in required_names:
        if name not in by_name:
            raise NativeInputError(f"Unknown native animation: {name}")

    event_source, checked_event_path = _verify_event_source(event_path, events_absent, required_names)

    mesh_names = [mesh.name for mesh in model.meshes]
    visible = set(visible_meshes)
    if not visible or not visible.issubset(mesh_names):
        raise NativeInputError("Explicit visible submesh selection is missing or invalid")
    retained_indices = {i for i, name in enumerate(mesh_names) if name in visible}
    positions = np.array([[vert.pos.x, vert.pos.y, vert.pos.z] for vert in model.verts], dtype=np.float64)
    texcoords = np.array([[vert.u, vert.v] for vert in model.verts], dtype=np.float64)
    joints = np.array([[item.bone for item in vert.bones] for vert in model.verts], dtype=np.int64)
    weights = np.array([[item.weight for item in vert.bones] for vert in model.verts], dtype=np.float64)
    if joints.shape != (len(positions), 4) or weights.shape != joints.shape:
        raise NativeInputError("Only native four-influence skinning is supported")
    if not np.isfinite(positions).all() or not np.isfinite(texcoords).all() or not np.isfinite(weights).all():
        raise NativeInputError("Non-finite native vertex data")
    if (weights < 0).any() or ((joints < 0) | (joints >= len(model.bones))).any():
        raise NativeInputError("Invalid native joint or weight")

    dependencies = [rk_path, anim_path, csv_path]
    if checked_event_path is not None:
        dependencies.append(checked_event_path)
    materials, material_ids, primitives = [], {}, []
    material_sources = []
    for native_mesh_index, mesh in enumerate(model.meshes):
        if native_mesh_index not in retained_indices:
            continue
        if not (0 <= mesh.material_index < len(model.materials)):
            raise NativeInputError(f"Invalid material on submesh {mesh.name}")
        if mesh.material_index not in material_ids:
            material = model.materials[mesh.material_index]
            rkm_path = _material_sibling(rk_path.parent, material.name)
            with rkm_path.open(newline="", encoding="utf-8-sig") as handle:
                rows = [row for row in csv.reader(handle, delimiter="=") if row]
            if any(len(row) != 2 for row in rows) or len({row[0] for row in rows}) != len(rows):
                raise NativeInputError(f"Invalid or duplicate material properties: {rkm_path.name}")
            raw_fields = dict(rows)
            try:
                properties = parse_rkm(str(rkm_path))
            except (TypeError, ValueError) as error:
                raise NativeInputError(f"Unsupported material property: {rkm_path.name}") from error
            material_sources.append({"name": rkm_path.name, "status": "parsed-source-rkm"})
            resolved_shader = properties.Shader or "rkshader"
            if resolved_shader != "rkshader":
                raise NativeInputError(f"Unsupported native shader: {resolved_shader}")
            if properties.BlendMode not in {"none", "opaque", "alpha"}:
                raise NativeInputError(f"Unsupported native blending: {properties.BlendMode}")
            if properties.ClampMode not in {"RK_CLAMP", "RK_REPEAT"}:
                raise NativeInputError(f"Unsupported texture addressing: {properties.ClampMode}")
            suffix = ".png" if properties.NoCompress else ".pvr"
            texture_path = _sibling(rkm_path.parent, properties.DiffuseTexture + suffix)
            alpha_path = texture_path.with_name(texture_path.stem + ".alpha" + texture_path.suffix)
            texture_dependencies = [texture_path]
            if not properties.NoCompress and alpha_path.is_file():
                alpha_path = _sibling(rkm_path.parent, str(alpha_path.relative_to(rkm_path.parent)))
                texture_dependencies.append(alpha_path)
            else:
                alpha_path = None
            def decode_texture():
                if properties.NoCompress:
                    from PIL import Image
                    with Image.open(texture_path) as image:
                        rgba = image.convert("RGBA")
                else:
                    try:
                        # Resolve sidecars here so Luna cannot read dependencies
                        # outside the checked closure or recurse into alpha-of-alpha.
                        image = PVR(str(texture_path), external_alpha=False).image
                        if image is None:
                            raise NativeInputError(f"Texture decoder returned no image: {texture_path.name}")
                        if alpha_path is not None and not image_has_alpha(image):
                            alpha = PVR(str(alpha_path), external_alpha=False).image
                            if alpha is None:
                                raise NativeInputError(f"Texture decoder returned no image: {alpha_path.name}")
                            if alpha.size == image.size:
                                image = put_alpha(image, alpha)
                    except (AssertionError, struct.error) as error:
                        raise NativeInputError(f"Native PVR parse failed: {texture_path.name}: {error}") from error
                    rgba = image.convert("RGBA")
                output = io.BytesIO()
                rgba.save(output, format="PNG")
                return output.getvalue(), rgba.width, rgba.height
            png, width, height = decode_texture()
            material_ids[mesh.material_index] = len(materials)
            materials.append({"name": material.name, "rkm_fields": raw_fields, "png_bytes": png,
                              "width": width, "height": height, "resolved_shader": resolved_shader,
                              "native_default_shader": not bool(properties.Shader)})
            dependencies.extend([rkm_path, *texture_dependencies])
        triangles = np.array([[tri.x, tri.y, tri.z] for tri in mesh.triangles], dtype=np.int64)
        if triangles.ndim != 2 or triangles.shape[1] != 3 or not len(triangles):
            raise NativeInputError(f"Invalid or empty native triangles: {mesh.name}")
        if triangles.min() < 0 or triangles.max() >= len(positions):
            raise NativeInputError(f"Native face index out of range: {mesh.name}")
        primitive = {"name": mesh.name, "indices": triangles, "material": material_ids[mesh.material_index]}
        primitives.append(primitive)

    referenced = np.unique(np.concatenate([primitive['indices'].reshape(-1) for primitive in primitives]))
    if np.any(weights[referenced].sum(axis=1) == 0):
        raise NativeInputError("Zero-weight vertices require native shader semantics outside this initial scope")

    def transforms(start: int, end: int) -> dict:
        return {"translations": animation.translations[start:end + 1],
                "rotations_xyzw": animation.rotations_xyzw[start:end + 1]}

    clips = [{**by_name[name], "event_source_status": event_source["status"], **transforms(by_name[name]["start"], by_name[name]["end"])} for name in selected]
    rest_frame = by_name[rest_name]["start"] if rest_name is not None else rest_frame
    result = {"name": model.name, "positions": positions, "texcoords": texcoords, "joints": joints,
            "weights": weights, "primitives": primitives, "materials": materials,
            "bones": [{"name": bone.name, "parent": bone.parentIndex,
                       "bind_global": np.array(bone.matrix_4x4, dtype=np.float64)} for bone in model.bones],
            "clips": clips, "rest": {"name": rest_name, "frame": rest_frame, **transforms(rest_frame, rest_frame)},
            "provenance": {"animation_sha256": hashlib.sha256(anim_path.read_bytes()).hexdigest(), "luna_commit": LUNA_COMMIT, "animation_reader": "atp-rk-5.2-0-1-4-v1", "anim_format": {"major": major, "minor": minor, "type": frame_type},
                           "event_source": event_source, "duplicate_csv_rows_merged": duplicates, "unselected_csv_diagnostics": csv_diagnostics,
                           "rest_source": "native-csv-first-frame" if rest_name is not None else "caller-selected-native-frame",
                           "native_position_scale": NATIVE_POSITION_SCALE, "material_sources": material_sources,
                           "default_shader_materials": [item["name"] for item in materials if item["native_default_shader"]],
                           "files": [{"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                                     for path in dict.fromkeys(dependencies)]}}
    return result
