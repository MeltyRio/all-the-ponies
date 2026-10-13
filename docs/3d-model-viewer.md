# Optional 3D model viewer (draft)

This draft adds an optional entry to the existing pony, pet and costume detail pages. It reuses
ATP's `ObjectPage` action slot, translated object name, `DialogComponent`, buttons,
asset URL resolver and i18n. It does not add a parallel website or a downloader.
No catalogue entry means no 3D button. Existing inventory/variant controls are
unchanged. Each page looks up its object ID in the same catalogue; a costume
entry represents a verified, complete outfit model, not an interactive wardrobe.

## Run the demo with game models

Use this ATP PR together with [game-data PR #1](https://github.com/all-the-ponies/game-data/pull/1)
(`MeltyRio/game-data`, branch `codex/3d-resource-association`). Conversion and
native discovery belong to game-data; ATP does not have a Python converter.

First obtain a completed local output from that game-data branch. It must contain
`models_3d.json` and every referenced file under `models/3d/`. Existing upstream
outputs without the new catalogue cannot provide 3D models. Game resources are
not included in either PR; the demo reads resources you have generated locally.

From the ATP checkout, use pnpm 10.28.2 and the frozen lockfile:

```sh
pnpm install --frozen-lockfile
export MODEL_VIEWER_ASSETS="/absolute/path/to/game-data/dist"
pnpm demo:model-viewer
```

Open `http://127.0.0.1:5195` in a browser. No domain, bucket or deployment is needed.
The page lists the actual catalogue identities. Search for an Object ID, select
it and use the 3D button to open ATP's real viewer. Pony, Pet and pre-generated
Costume entries use their own IDs; costumes may use native names such as `SET_*`.
Only generated entries appear. An explicitly requested missing identity shows a
message and never substitutes another model. For a direct link, for example:

```text
http://127.0.0.1:5195/?identity=Pony_Twilight_Sparkle
```

The selected entry must exist in that catalogue. Animation buttons play its
supported clips once, then restore rest. The lock switches horizontal/free
rotation, and Reset restores the view and pose. Supported additional actors and
native materials load with the selected resource; they do not need separate demo
switches. The demo does not add unsupported game events or interactive clothing.

Keep the terminal running; Ctrl+C stops the local servers. `MODEL_VIEWER_PORT`
overrides the page port. Missing `MODEL_VIEWER_ASSETS` or an unreadable catalogue
stops startup with instructions. There is no built-in model or generated fallback.
Restart the demo after regenerating the catalogue.

The page uses the actual ATP viewer/dialog components, without booting the whole
ATP site. A test-only asset resolver serves the selected output from a second
local HTTP origin to exercise CORS and manifest serialization. Production keeps
ATP's existing `createAssetUrl`; this demo does not upload or contact its CDN.

### Generate a local output when needed

Use game-data's [setup and build instructions](https://github.com/MeltyRio/game-data/blob/codex/3d-resource-association/README.md).
The normal build runs Transformer and then model generation. For a local review,
use complete, successfully extracted inputs for one fixed game version and an
isolated raw/output directory. For example, from the game-data checkout:

```sh
uv run --no-sync game-data --env dev build \
  --version 11.4.3c \
  --raw /absolute/path/to/isolated-raw \
  --output /absolute/path/to/new-review-dist \
  --skip download extract image_gen
```

Replace the version with the actual input version. The raw directory must contain
`extracted/` with all inputs needed by Transformer and model generation, not just
one RK/ANIM pair. The build writes its private model report under raw and clears
the specified output before Transformer, so use a new output path. Skipping
`image_gen` only skips the later image stage: Transformer can still need its
normal image/SWF tools. Do not add `--skip transform` for an empty output.
This command does not request uploads. Point `MODEL_VIEWER_ASSETS` at the resulting
`new-review-dist`, without copying game files into the ATP checkout.

## Tests

The Node unit tests use small self-authored in-memory data and need no game assets:

```sh
pnpm test:model-viewer
```

With the same real output selected above, validate its GLBs and run browser checks:

```sh
pnpm test:model-viewer:glb "$MODEL_VIEWER_ASSETS"
pnpm test:model-viewer:browser
```

Browser tests require an installed Playwright Chromium, or `CHROME_PATH` pointing
to an existing Chromium. The tests record their selected identities and any
optional cases absent from the supplied catalogue; absent coverage is not a pass.
Screenshots/video/results go to ignored `tests/model-viewer/generated/browser`,
or `MODEL_VIEWER_RESULTS`. They are private local output, not committed fixtures.
Do not run upload tools against a partial test output.

For the full site, use ATP's normal development/build instructions and configured
data environment. Run its build and type checking separately; the demo is not a
replacement for those checks or production delivery acceptance.

## Data and hosting contract

The companion game-data change generates `models_3d.json` after Transformer,
using Luna GameObjectData and the same extracted inputs. It writes current
model objects under `models/3d/<ObjectID>.glb` and independent animations
under `models/3d/<sha256>/<native-clip-name>.glb` into the existing complete `dist/`.
Model and embedded texture updates replace the same Object ID key. Animation
digest directories distinguish different native libraries with the same clip
name, and preserve an animation when its content changes. Shared clips retain the same key
across characters. Internal additional actors without a game Object ID keep
their flat `models/3d/<sha256>.glb` model key. The reader also accepts previous
flat SHA keys and SHA-directory model keys. Names use
ASCII letters, digits, underscores and hyphens; unsupported names are diagnosed
by the generator rather than silently rewritten.
The current upstream game-data version must include that change before this
consumer has generated game resources to display.

Its existing sync process validates the catalogue's local references, uploads
referenced GLBs first, then the catalogue, and finally the root manifest. The
manifest records the hash of the **uploaded, reserialized** catalogue JSON.
The viewer does not compare those JSON bytes to a pre-upload digest. Each GLB
still has a checked byte count, SHA-256 and rig compatibility metadata.
Embedded textures and buffers prevent hidden external GLB dependencies.

Fixed model keys use `Cache-Control: no-cache` and the viewer requests cache
revalidation. Immutable animation and anonymous model keys retain normal caching.
Publishing is not atomic: a failed upload can replace some model files while
leaving the previous catalogue. An old catalogue may then fail its size or
digest check. After publication finishes, reloading the page reads the latest
catalogue and resources. The viewer does not silently accept mismatched bytes,
automatically retry indefinitely, or promise historical model snapshots.
Retention and eventual deletion of old immutable GLBs remain an upstream
operational decision. ATP adds no upload,
cleanup, downloader, game-object resolver or native parser.
Production R2/CDN delivery and cache behavior have not been accepted by these tests.

Deploy this compatible reader before publishing catalogues with named keys.
An older reader that only accepts flat SHA keys cannot consume the new paths;
retaining old files alone does not update that JavaScript. No public rollout is
performed by these local candidates.

The catalogue is fetched on client mount with `credentials: omit`; Three.js and
WebGL initialize only after opening the viewer. Relative keys are resolved with
ATP's CDN-aware helper. External URLs/path traversal in catalogue entries and
external buffer/image URIs inside GLBs are rejected. Hosting must allow browser
GET/CORS and deliver GLB bytes unchanged. CSP/cache/deployment policies remain
owned by ATP.

The reader accepts catalogue versions 1 and 2. Version 2 is required for an
additional actor or a native material UV clock; a plain catalogue remains version
1. This prevents an older reader from silently showing an incomplete scene.
The same upload reference checks include the additional actor's model and clips.

## Model and animation boundary

A model GLB contains mesh, embedded texture, material, bind matrices and rest
skeleton, but no animation. An animation GLB contains joints and STEP tracks,
but no mesh or texture. Both use ordinary glTF 2.0 structures plus small extras:

- `atpRig`: version, coordinate convention, indexed hierarchy and compatibility
  key derived from the explicitly selected native animation library content.
- `atpClip`: native FPS, frame count and duration.
- `atpNativeDepth`: native material depth test/write flags not represented by
  standard glTF material fields.
- `atpNativeUVClock`: the reviewed native hair controller's initial value, speed
  and range. Its texture offset uses `KHR_texture_transform`; a shared runtime
  clock reproduces the native update and reset-at-maximum rule.

The viewer checks these records, hierarchy, node associations, track channels,
STEP interpolation and sample times before rebinding tracks to model node UUIDs.
It does not infer compatibility from a character's name or bone count. This
profile is intentionally conservative: it is not a general retargeting system.
Changing a native library invalidates its rig identity even if only one clip
changed. The caller still must establish the RK/library association from native
metadata; these formats alone do not prove that any arbitrary pair belongs
together.

Each parent clip is fetched only when first selected, then reused within that viewer
session. Content-addressed assets can use ordinary HTTP caching across sessions;
there is no additional persistent application cache or large shared library
pre-download. Closing releases the session cache and GPU resources.
Loading is exposed through `aria-busy` without a flashing text message;
downloading a clip does not resize or recenter the open dialog.

## Declared additional actors

Game-data can supply one `additionalActor` from the selected native object's
`AdditionalObject` declaration. The client consumes the generated reference,
rest matrix, parent root ordinal and `native-first-then-random-v1` controller;
it does not resolve native resources or infer ownership. The child has its own
rig, mixer and original CSV clip order: first index zero, then a random index
at each completion. It may repeat an index. Clips are fetched on demand and do
not enter the parent's action menu.

The scene uses native scale/offset/LockRotate fields and parent-root X/Z motion.
These are adapted from a stationary world actor to an uncompressed free 3D
preview, as documented by game-data's `docs/3d-additional-actors.md`. This is not
a reproduction of every native UI. Orbit views the complete scene; it does not
change the native fixed-heading reference. Single-sided planar effects remain
single-sided and can appear edge-on or disappear from their reverse side.
Initial framing includes both actors, so a large or distant child can reduce
the parent's on-screen size. Motion can still exceed initial bounds.

The child plays while the parent rests and shares page-hidden pause, rendering,
cancellation and disposal. Reset view restarts its first clip. A failed initial
child load fails the complete scene and releases partial resources. A failed
later clip is reported; it never substitutes an unrelated clip. The verified
hair UV clock also runs while the parent rests and pauses when the page hides.

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

This is a basic playback consumer. Native source discovery and default/outfit
selection belong to game-data; a missing catalogue identity yields no button.
Interactive clothing assembly, event-driven props, recursive companions, native
event execution, task scenes and character-family action sorting are outside the
viewer. One explicitly declared additional actor is supported as described above.
A selected parent clip with events, including unknown events, is rejected rather
than silently rendered without its behavior. In addition to ordinary materials,
game-data recognizes reviewed native horn and hair shaders by their exact source
content: the inactive horn surface is represented by an alpha mask, and hair uses
the verified UV clock. Unknown shader/controller combinations still fail; this
is not general native shader execution. Future formats require investigation and
tests. Standard glTF validation cannot prove native-game visual equivalence.

Producer and consumer unit tests use small synthetic inputs for geometry, indices,
UVs, skin/bind math, alpha, frame decoding, invalid input, separation/binding and
resource integrity. Browser checks use the selected local game-data output for
actual Chromium rendering/input, playback, disposal and cancellation. Mobile tests emulate
Chromium touch, not physical iOS/Safari. English strings use ATP's usual fallback;
additional translations are deferred.

The small GLB extras profile remains a review point for this Draft PR. Generation
is owned by game-data. No new registry package, independent Luna Kit PR or
resource hosting system is added. This source is GPL-3.0-only like
ATP; Luna Kit is GPL-3.0, Three.js is MIT, NumPy is BSD and Pillow is MIT-CMU.
Third-party code and game assets are not vendored.
