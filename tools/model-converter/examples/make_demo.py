"""Generate the public demo through the same native adapter as actual inputs."""
import argparse
from pathlib import Path
import tempfile

from atp_glb.export import convert_native, write_bundle
from native_fixture import write_fixture


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--identity", default="Synthetic_Flag")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as name:
        folder = Path(name)
        write_fixture(folder)
        bundle = convert_native(folder / "flag.rk", folder / "flag.anim", folder / "flag.csv", ["wave"],
                                identity=args.identity, visible_meshes=["flag"], rest_name="rest",
                                event_path=folder / "flag.xml")
        write_bundle(bundle, args.output)


if __name__ == "__main__":
    main()
