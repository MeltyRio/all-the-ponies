# ATP model converter (Draft PR)

This small Python package converts an explicitly associated RK model, ANIM
library and CSV clip declarations into a skinned model GLB plus independent
animation GLBs. It does not discover game identities, download assets, upload
files, execute native events or implement a second ATP data pipeline.

## Install and run without game assets

Requires Python 3.12 or later. From this directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install '.[native]'
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python examples/make_demo.py --output demo-assets
```

`make_demo.py` creates a self-authored checkerboard flag with two joints in RK
and ANIM formats, loads it through the same adapter as real inputs, and emits
one model GLB and one playable `wave` GLB. The native fixture files live only in
a temporary directory. No game artwork or native game bytes are included.

The `native` extra pins the public Luna Kit source archive to commit
`aeb659af80f973a7bb7d2d058f05b4fc1446bed3` and its SHA-256. Core `Model`, `Rig`,
`Clip`, `model_glb` and `animation_glb` need only NumPy and Pillow. Installation
uses normal source builds, not a local wheel, private directory or old virtual
environment.

## Explicit native inputs

```sh
.venv/bin/atp-convert-model --rk extracted/actor.rk --anim extracted/library.anim \
  --csv extracted/library.csv --identity Pony_Example --mesh body \
  --animation idle --rest-name idle --events extracted/library.xml \
  --output new-staging
```

The caller must establish the model/library association from original resource
metadata and select the default visible meshes explicitly. Equal bone counts
alone do **not** establish compatibility. Use `--mesh` and `--animation` more
than once for multiple selected meshes/clips. If the source declares no rest
clip, `--rest-frame` is available. `--events-absent` is only appropriate after
checking the original source; a missing file in an incomplete extraction is
not evidence of absence. Materials and textures must be alongside the RK.

The output directory must not exist. Conversion completes in memory before
writing, and the catalogue is written last. The caller chooses and verifies a
fresh staging directory; this is not an atomic production deployment system.

The importable API is:

```python
from atp_glb.export import convert_native, write_bundle

bundle = convert_native(
    "extracted/actor.rk", "extracted/library.anim", "extracted/library.csv",
    ["idle"], identity="Pony_Example", visible_meshes=["body"],
    rest_name="idle", event_path="extracted/library.xml",
)
write_bundle(bundle, "new-staging")
```

`AssetBundle.catalogue` is ordinary JSON data; `AssetBundle.files` maps ATP
asset keys to GLB bytes. No model-specific branches or browser code enter the
converter. Low-level conversion remains separately usable without filesystem
I/O. `load_native` preserves source names/digests for local diagnostics, but the
public GLBs and catalogue omit this provenance and all local paths.

## ATP resource contract

`models_3d.json` contains `schemaVersion: 1` and a `models` object keyed by ATP
identity. Each row has `path`, `sha256`, `bytes`, `rigKey`, and `animations`.
Animation rows additionally have `id`, `name`, and `duration` (seconds).

All paths are relative asset keys such as `models/3d/<sha256>.glb`. The website
resolves them with its existing `createAssetUrl`. Textures and buffers are
embedded, so GLBs have no further URL dependencies. Shared byte-identical
animations naturally have the same asset key.

The catalogue has **no byte-hash contract**: ATP's uploader can parse and compact
its JSON without invalidating GLB digests. Add its version to ATP's existing
root asset manifest in the same way as other data files. GLB bytes are immutable
and must reach hosting unchanged. This tool does not change the uploader or
assume permission to publish any source assets.

## Numerical and format decisions

- Luna Kit reads RK geometry/bones, RKM fields, and PVR textures. A local section
  guard rejects face bounds and layouts that the pinned parser cannot safely
  interpret. Supported RK headers are 5.0, 5.1, 5.2 and 6.2 with the checked
  section layouts, not arbitrary files using these version numbers.
- ANIM 5.2 supports three established little-endian records. Type 0 is 32 bytes:
  XYZW float quaternion, XYZ float translation, unit float lane. Type 1 is 22
  bytes: XYZ float translation, W float, XYZ int16 quaternion components / 32767.
  Type 4 is 11 bytes: XYZ int16 translation times 0.031250953674316406, W int16 /
  32767, XYZ int8 / 127. Payload length, finite values and quaternion validity
  are checked. Type 4 is tested against Luna's reader; types 0/1 use independent
  synthetic byte records and retain the previously audited converter's layout.
- Native poses are global model-space. The converter derives parent-local TRS
  and checks the reconstruction. Bind matrices remain specific to the model;
  inverse binds are not inferred from an animation frame.
- A proper 180-degree X rotation converts native negative-Y-up coordinates to
  glTF positive-Y-up. RK triangles reverse winding for glTF's CCW convention.
  Native UVs and decoded texture pixels are retained.
- Four influences are validated. Only UNORM16 normalization residue is corrected.
  Repeated positive influences for the same joint are merged without changing
  skinning. Zero-weight vertices are explicitly outside this initial scope.
- Ordinary `rkshader` uses glTF unlit textured materials with original culling,
  wrapping and alpha mode. Native depth-write/test values are carried in a small
  material `extras` field because glTF does not standardize these switches.
  Other shaders are rejected, not approximated.
- Animation GLBs contain no geometry or images. Standard STEP tracks target
  stable indexed joint names. A repeated final key preserves each native frame's
  full `1 / fps` duration. Both GLBs carry a small `atpRig` compatibility record:
  its key includes the selected native ANIM content digest and indexed parent
  hierarchy, rather than merely bone names/count. Consumers must compare it
  before binding tracks. This explicit association does not discover whether
  an arbitrary same-size native animation belongs to a model.

## Scope and limits

This first draft deliberately excludes props, companions, event execution,
clothing assembly, special shaders, task scenes, automatic discovery and game
updates. Explicitly selected actions with events (including unknown events) are
rejected. Unknown animation formats, missing dependencies, non-rigid poses and
incompatible layouts fail with a diagnostic; they do not receive fallback models.

The output extras and package location are draft integration choices for review.
The public tests cover synthetic data, not all released game assets. No claim is
made about future game versions. Run a standard glTF validator and inspect a real
browser render for newly converted resources before publishing them.

This package and its code derived from the existing local converter are GPL-3.0-only,
as is ATP. Luna Kit is GPL-3.0. NumPy (BSD) and Pillow (MIT-CMU) remain separate
runtime dependencies; no third-party source or game resources are vendored here.
