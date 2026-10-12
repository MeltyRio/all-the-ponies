"""Explicit native closure -> ATP asset keys; no archive or website discovery."""
from dataclasses import dataclass
import argparse
import hashlib
import json
from pathlib import Path
import re

from . import from_native, model_glb, animation_glb
from .native import load_native


@dataclass(frozen=True)
class AssetBundle:
    catalogue: dict
    files: dict[str, bytes]


def convert_native(rk_path, anim_path, csv_path, selected_names, *, identity,
                   visible_meshes, rest_name=None, rest_frame=None,
                   event_path=None, events_absent=False) -> AssetBundle:
    """Convert one explicit source association; all texture data stays in GLB.

    Mesh, rest and event-source arguments have the same meaning as in
    ``load_native``. No game identity lookup or skeleton retargeting occurs.
    The caller must obtain the model/library association from native metadata.
    """
    if not isinstance(identity, str) or not identity or any(ord(c) < 32 for c in identity):
        raise ValueError("A nonempty model identity is required")
    native = load_native(rk_path, anim_path, csv_path, selected_names, visible_meshes=visible_meshes,
                         rest_name=rest_name, rest_frame=rest_frame,
                         event_path=event_path, events_absent=events_absent)
    model, clips = from_native(native, identity=identity)
    files = {}

    def asset(data):
        digest = hashlib.sha256(data).hexdigest()
        path = f"models/3d/{digest}.glb"
        files[path] = data
        return {"path": path, "sha256": digest, "bytes": len(data), "rigKey": model.rig.key}

    row = asset(model_glb(model))
    row["animations"] = [{**asset(animation_glb(clip)), "id": clip.name, "name": clip.name,
                          "duration": len(clip.global_frames) / clip.fps} for clip in clips]
    return AssetBundle({"schemaVersion": 1, "models": {identity: row}}, files)


def write_bundle(bundle: AssetBundle, output: str | Path) -> None:
    """Write a new staging directory, never replace an existing asset set.

    JSON is semantic data: ATP's uploader may compact it. Only immutable GLBs
    carry byte digests. Upload/deployment and the root manifest remain ATP's.
    """
    for key, payload in bundle.files.items():
        match = re.fullmatch(r"models/3d/([a-f0-9]{64})\.glb", key)
        if not match or hashlib.sha256(payload).hexdigest() != match[1]:
            raise ValueError("Asset key must match the GLB content digest")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    for key, payload in bundle.files.items():
        path = output / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    (output / "models_3d.json").write_text(
        json.dumps(bundle.catalogue, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(description="Convert an explicit RK/ANIM dependency closure to ATP GLB assets")
    parser.add_argument("--rk", type=Path, required=True)
    parser.add_argument("--anim", type=Path, required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--mesh", action="append", required=True, help="Visible native submesh; repeat for each mesh")
    parser.add_argument("--animation", action="append", required=True, help="CSV clip name; repeat for each action")
    rest = parser.add_mutually_exclusive_group(required=True)
    rest.add_argument("--rest-name")
    rest.add_argument("--rest-frame", type=int)
    events = parser.add_mutually_exclusive_group(required=True)
    events.add_argument("--events", type=Path)
    events.add_argument("--events-absent", action="store_true", help="Caller verified that the source event XML is absent")
    parser.add_argument("--output", type=Path, required=True, help="New staging directory; existing directories are refused")
    args = parser.parse_args()
    try:
        bundle = convert_native(args.rk, args.anim, args.csv, args.animation, identity=args.identity,
                                visible_meshes=args.mesh, rest_name=args.rest_name, rest_frame=args.rest_frame,
                                event_path=args.events, events_absent=args.events_absent)
        write_bundle(bundle, args.output)
    except (ValueError, OSError, NotImplementedError) as error:
        parser.exit(1, f"Conversion failed: {error}\n")
    print(f"Wrote {len(bundle.files)} GLB assets and models_3d.json")


if __name__ == "__main__":
    main()
