# Optional 3D model viewer (draft)

This draft adds an optional entry to the existing pony, pet and costume detail pages. It reuses
ATP's `ObjectPage` action slot, translated object name, `DialogComponent`, buttons,
asset URL resolver and i18n. It does not add a parallel website or a downloader.
No catalogue entry means no 3D button. Existing inventory/variant controls are
unchanged. Each page looks up its object ID in the same catalogue; a costume
entry represents a verified, complete outfit model, not an interactive wardrobe.

## Reproduce without game assets

From the repository root, with Python 3.12+, Node and pnpm:

```sh
python3 -m venv tools/model-converter/.venv
tools/model-converter/.venv/bin/python -m pip install './tools/model-converter[native]'
tools/model-converter/.venv/bin/python -m unittest discover -s tools/model-converter/tests -t tools/model-converter -v
pnpm install --frozen-lockfile
tools/model-converter/.venv/bin/python tools/model-converter/examples/make_demo.py \
  --output tests/model-viewer/generated
pnpm test:model-viewer
pnpm test:model-viewer:glb
pnpm exec playwright install chromium
pnpm test:model-viewer:browser
pnpm demo:model-viewer
```

The lockfile was generated with pnpm 10.28.2. With pnpm 11's stricter install
policy, approve the existing upstream build scripts for `@parcel/watcher`,
`esbuild`, `sharp` and `workerd` using `pnpm approve-builds`, then repeat the
install. Keep that machine's approval configuration local; no blanket dependency
script approval is needed for the viewer.

The output directory must be new. When repeating conversion, preserve earlier
results and pass a fresh directory to `make_demo.py --output`. Use the same path
in `MODEL_VIEWER_ASSETS` for the browser commands and as the argument to
`pnpm test:model-viewer:glb <output-directory>`.

The browser demo opens at `http://127.0.0.1:5195`; it uses the real ATP viewer/dialog components in
a small test page, not the entire ATP site. A test-only asset resolver points
to a second local HTTP origin, exercising CORS and the catalogue/upload contract.
The normal application always uses ATP's existing `createAssetUrl`.

The example creates self-authored two-joint RK and ANIM data, reads them through
the native adapter, and produces a textured skinned flag and a three-second
`wave` animation. No native game files, GLBs, screenshots, credentials or local
wheel are committed. The browser test saves screenshots/video/results below
ignored `tests/model-viewer/generated/browser`. `CHROME_PATH` may explicitly
select an existing Chromium browser; the test otherwise uses Playwright's
installed Chromium. `MODEL_VIEWER_RESULTS` and `MODEL_VIEWER_PORT` override local
test output and port.

For the actual site, use ATP's existing development/build instructions and
configured data environment. Run `pnpm build` and `pnpm type-check` separately;
the standalone demo does not replace the full production build.

## Data and hosting contract

The [converter README](../tools/model-converter/README.md) documents the Python
API, source formats, numerical conversion and explicit association requirements.
It emits one semantic `models_3d.json` catalogue and immutable binary objects
under `models/3d/<sha256>.glb`.

Merge verified converter output into the **complete** ATP data staging directory
alongside existing data, then include `models_3d.json` in the existing root
`manifest.json`. Use the manifest value for the **uploaded, reserialized** JSON
as its version. ATP's data uploader may compact/re-encode JSON: the viewer does
not compare those JSON bytes to a pre-upload digest. Each GLB still has a checked
byte count and SHA-256, and its asset key must contain that same digest. Embedded
buffers/textures prevent hidden external GLB dependencies.

Do not run the existing full-data sync tool against a converter-only directory.
It expects the rest of ATP's data, and this draft does not make its upload order,
error propagation or publication atomic. Publish immutable binary files before
switching a verified catalogue/manifest; keep the last working resource set on
failure. No upload or publishing automation is added here.

The catalogue is fetched on client mount with `credentials: omit`; Three.js and
WebGL initialize only after opening the viewer. Relative keys are resolved with
ATP's CDN-aware helper. External URLs/path traversal in catalogue entries and
external buffer/image URIs inside GLBs are rejected. Hosting must allow browser
GET/CORS and deliver GLB bytes unchanged. CSP/cache/deployment policies remain
owned by ATP.

## Model and animation boundary

A model GLB contains mesh, embedded texture, material, bind matrices and rest
skeleton, but no animation. An animation GLB contains joints and STEP tracks,
but no mesh or texture. Both use ordinary glTF 2.0 structures plus small extras:

- `atpRig`: version, coordinate convention, indexed hierarchy and compatibility
  key derived from the explicitly selected native animation library content.
- `atpClip`: native FPS, frame count and duration.
- `atpNativeDepth`: native material depth test/write flags not represented by
  standard glTF material fields.

The viewer checks these records, hierarchy, node associations, track channels,
STEP interpolation and sample times before rebinding tracks to model node UUIDs.
It does not infer compatibility from a character's name or bone count. This
profile is intentionally conservative: it is not a general retargeting system.
Changing a native library invalidates its rig identity even if only one clip
changed. The caller still must establish the RK/library association from native
metadata; these formats alone do not prove that any arbitrary pair belongs
together.

Each clip is fetched only when first selected, then reused within that viewer
session. Content-addressed assets can use ordinary HTTP caching across sessions;
there is no additional persistent application cache or large shared library
pre-download. Closing releases the session cache and GPU resources.
Loading is exposed through `aria-busy` without a flashing text message;
downloading a clip does not resize or recenter the open dialog.

## Interaction and lifetime

Default mode keeps the initial camera elevation, target and size: horizontal
mouse/single-finger dragging or left/right keys rotates around the model. The
small lock button uses ATP's native blue button style; the closed/open SVG shows
the current locked/free mode. Free
rotation enables vertical orbit and zoom without interrupting a playing action
or resetting the current view. Switching back, or pressing Reset view, cancels
pending/running animation, restores the rest pose, and resets camera position,
target and scale. There is no per-frame auto-follow or zoom.

Selecting a clip plays once; selecting it again replays it. Completion restores
the exact rest transforms after the mixer's update. Abort signals and a request
generation prevent late responses from reviving canceled actions. Unmount
removes controls/listeners/observers, stops RAF, aborts requests, releases
textures/meshes/skeletons/mixer state and destroys the WebGL context. GPU creation
is deferred to mounted client code, so SSR does not require WebGL.

Controls retain ATP's gradient and menu dark-fill focus feedback without an
additional browser outline.

## Review scope and limitations

This is an explicit-input conversion and basic playback draft. Props, companions,
clothing assembly, native events, special shaders, task scenes, character-family
action sorting and resource auto-discovery/update are excluded. A selected clip
with events, including unknown events, is rejected rather than silently rendered
without its behavior. Only the documented ordinary shader and native format
records are supported. Future formats require investigation/tests, not fallback
models. Standard glTF validation cannot prove native-game visual equivalence.

The public tests verify synthetic geometry, indices, UVs, skin/bind math, alpha,
frame decoding, invalid input, separation/binding, resource integrity, disposal,
async cancellation and actual Chromium rendering/input. Mobile tests emulate
Chromium touch, not physical iOS/Safari. English strings use ATP's usual fallback;
additional translations are deferred.

The package location/name, small GLB extras profile and ownership of catalogue
generation are discussion points for this Draft PR. No new registry package,
Luna Kit patch or resource hosting is assumed. This source is GPL-3.0-only like
ATP; Luna Kit is GPL-3.0, Three.js is MIT, NumPy is BSD and Pillow is MIT-CMU.
Third-party code and game assets are not vendored.
