import test from 'node:test'
import assert from 'node:assert/strict'
import { Bone, BoxGeometry, BufferAttribute, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Skeleton, SkinnedMesh } from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { hitsModel, nativeEvents, nativeGestures, prepareNativeEyes } from '../../src/components/model-viewer/interactions'
import { disposeGLTF } from '../../src/components/model-viewer/assets'

function fixture() {
    const scene = new Group()
    const meshes = Array.from({length: 4}, () => new Mesh(new BoxGeometry(), new MeshBasicMaterial()))
    scene.add(meshes[0], meshes[1])
    const json: any = {
        nodes: meshes.map((_, i) => ({extras: {atpNativeMeshIndex: i + 10, atpDefaultVisible: i < 2}})),
        scenes: [{nodes: [0, 1]}],
        extras: {atpInteractions: {version: 1, hiddenNodes: [2, 3], eyes: {Open: [11], Closed: [12], Happy: [13], Frown: [11]}}},
    }
    const model = {scene, scenes: [scene], parser: {json,
        associations: new Map(meshes.map((mesh, i) => [mesh, {nodes: i}])),
        getDependency: async (_: string, index: number) => meshes[index],
    }} as unknown as GLTF
    return {model, json, meshes}
}

test('orphan eyes join the main scene hidden; defaults and native timing survive EyeSet and Reset', async () => {
    const f = fixture(), random = Math.random
    Math.random = () => 0
    try {
        const eyes = (await prepareNativeEyes(f.model, new AbortController().signal))!
        assert.equal(f.model.scene.children.length, 4)
        assert.deepEqual(eyes.snapshot().visible, [10, 11])
        eyes.update(0) // first native tick opens and schedules 2 seconds
        assert.equal(eyes.snapshot().remaining, 2)
        eyes.update(2)
        assert.deepEqual(eyes.snapshot().visible, [10, 11], 'zero crossing switches on the next update')
        eyes.update(0)
        assert.deepEqual(eyes.snapshot().visible, [10, 12])
        eyes.set({frame: 0, type: 'EyeSet', state: 'Happy', enableBlink: false})
        const phase = eyes.snapshot().remaining
        eyes.update(10)
        assert.deepEqual(eyes.snapshot().visible, [10, 13])
        assert.equal(eyes.snapshot().remaining, phase)
        eyes.reset()
        assert.deepEqual(eyes.snapshot().visible, [10, 11])
        assert.equal(eyes.snapshot().remaining, phase, 'native reset restores expression without restarting timer')
        eyes.set({frame: 0, type: 'EyeSet', state: 'None', enableBlink: false})
        assert.deepEqual(eyes.snapshot().visible, [10])
    } finally { Math.random = random; disposeGLTF(f.model) }
})

test('empty Open is valid static data, shared expression groups are not guessed into blinking', async () => {
    for (const kind of ['empty', 'alias']) {
        const f = fixture()
        f.json.extras.atpInteractions.eyes.Open = kind === 'empty' ? [] : [12]
        try {
            const eyes = (await prepareNativeEyes(f.model, new AbortController().signal))!
            assert.equal(eyes.active, false)
            eyes.update(10)
            assert.deepEqual(eyes.snapshot().visible, [10, 11])
        } finally { disposeGLTF(f.model) }
    }
})

test('a click-only model without orphan eyes stays static and empty native eye events remain explicit no-ops', async () => {
    const f = fixture()
    for (const mesh of f.meshes) f.model.scene.add(mesh)
    for (const node of f.json.nodes) node.extras.atpDefaultVisible = true
    f.json.extras.atpInteractions = {version: 1, eyes: {Open: [], Closed: [], Happy: [], Frown: []}}
    try {
        const eyes = (await prepareNativeEyes(f.model, new AbortController().signal))!
        assert.equal(eyes.active, false)
        const event = {frame: 0, type: 'EyeSet', state: 'Happy', enableBlink: true} as const
        assert.deepEqual(nativeEvents(f.model, {frameCount: 1, eventProfile: 'ponybook-v1', events: [event]}, true), [event])
        eyes.set(event)
        assert.deepEqual(eyes.snapshot().visible, [10, 11, 12, 13])
    } finally { disposeGLTF(f.model) }
})

test('extra default-visible expression geometry disables blink without changing that verified appearance', async () => {
    const f = fixture()
    f.json.nodes[3].extras.atpDefaultVisible = true
    f.json.extras.atpInteractions.hiddenNodes = [2]
    f.json.scenes[0].nodes.push(3)
    f.model.scene.add(f.meshes[3])
    try {
        const eyes = (await prepareNativeEyes(f.model, new AbortController().signal))!
        assert.equal(eyes.active, false)
        eyes.update(10)
        assert.deepEqual(eyes.snapshot().visible, [10, 11, 13])
    } finally { disposeGLTF(f.model) }
})

test('ambiguous native indices, dangling eyes and hidden scene roots reject', async () => {
    for (const kind of ['duplicate', 'missing', 'scene', 'parent', 'body']) {
        const f = fixture()
        if (kind === 'duplicate') f.json.nodes[1].extras.atpNativeMeshIndex = 10
        if (kind === 'missing') f.json.extras.atpInteractions.eyes.Open = [99]
        if (kind === 'scene') f.json.scenes[0].nodes.push(2)
        if (kind === 'parent') f.json.nodes[0].children = [2]
        if (kind === 'body') f.json.extras.atpInteractions.eyes.Closed = []
        try { await assert.rejects(prepareNativeEyes(f.model, new AbortController().signal)) }
        finally { for (const mesh of f.meshes) f.model.scene.add(mesh); disposeGLTF(f.model) }
    }
})

test('aborting a pending hidden dependency still leaves it reachable for disposal', async () => {
    const f = fixture(), abort = new AbortController()
    let complete!: (value: Mesh) => void
    f.model.parser.getDependency = () => new Promise(resolve => { complete = resolve })
    const pending = prepareNativeEyes(f.model, abort.signal)
    abort.abort()
    complete(f.meshes[2])
    await assert.rejects(pending, {name: 'AbortError'})
    assert.equal(f.meshes[2].parent, f.model.scene)
    for (const mesh of f.meshes) f.model.scene.add(mesh)
    disposeGLTF(f.model)
})

test('event validation preserves same-frame order and rejects unknown events or missing dependencies', () => {
    const f = fixture()
    f.json.extras.atpInteractions.effects = {stars: {}}
    const rows = [
        {frame: 0, type: 'EyeSet', state: 'Frown', enableBlink: false},
        {frame: 0, type: 'Emitter', effect: 'stars'},
        {frame: 1, type: 'EyeSet', state: 'None', enableBlink: true},
    ]
    const metadata = {frameCount: 2, eventProfile: 'ponybook-v1', events: rows}
    assert.deepEqual(nativeEvents(f.model, metadata, true), rows)
    assert.throws(() => nativeEvents(f.model, metadata, false), /not supported/)
    for (const row of [
        {...rows[0], frame: 2}, {...rows[0], state: 'Unknown'}, {...rows[0], enableBlink: 'false'},
        {...rows[1], effect: 'other'}, {frame: 0, type: 'SubObject', id: 'cloud'}, {...rows[1], extra: true},
    ]) assert.throws(() => nativeEvents(f.model, {...metadata, events: [row]}, true))
    assert.throws(() => nativeEvents(f.model, {...metadata, events: [rows[2], rows[0]]}, true), /frame/)
    delete f.json.extras.atpInteractions.eyes.Happy
    assert.throws(() => nativeEvents(f.model, {...metadata, events: [{...rows[0], state: 'Happy'}]}, true), /eye event/)
    disposeGLTF(f.model)
})

const pointer = (x: number, props: Partial<PointerEvent> = {}) => ({type: 'pointerup', pointerId: 1, pointerType: 'mouse',
    clientX: x, clientY: 0, pageX: x, button: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...props}) as PointerEvent

test('four signed modulo rotations strictly over 220 degrees trigger dizzy, including release displacement', () => {
    const gestures = nativeGestures()
    for (const angle of [220, 360, 380, -220]) {
        gestures.down(pointer(0), true)
        assert.equal(gestures.up(pointer(angle), 360, 1, true), undefined)
        assert.equal(gestures.spins, 0)
    }
    for (let i = 0; i < 4; i++) {
        gestures.down(pointer(0), true)
        gestures.move(pointer(210), 360, 1)
        assert.equal(gestures.up(pointer(230), 360, 1, true), i === 3 ? 'dizzy' : undefined)
    }
    assert.equal(gestures.spins, 0)
})

test('drag-return, cancellation, two fingers and modifier buttons cannot become taps or spins', () => {
    const gestures = nativeGestures()
    gestures.down(pointer(0), true)
    gestures.move(pointer(20), 360, 1)
    assert.equal(gestures.up(pointer(0), 360, 1, true), undefined)
    for (const props of [{button: 2}, {ctrlKey: true}, {metaKey: true}, {shiftKey: true}]) {
        gestures.down(pointer(0, props), true)
        assert.equal(gestures.up(pointer(0, props), 360, 1, true), undefined)
    }
    gestures.down(pointer(0), true)
    assert.equal(gestures.up(pointer(230, {type: 'pointercancel'}), 360, 1, true), undefined)
    gestures.down(pointer(0, {pointerType: 'touch'}), true)
    gestures.down(pointer(0, {pointerType: 'touch', pointerId: 2}), true)
    assert.equal(gestures.up(pointer(230), 360, 1, true), undefined)
    assert.equal(gestures.up(pointer(230, {pointerId: 2}), 360, 1, true), undefined)
    assert.equal(gestures.spins, 0)
    gestures.down(pointer(0), true)
    assert.equal(gestures.up(pointer(4), 360, 1, true), 'click')
    gestures.down(pointer(0), true)
    gestures.clear()
    assert.equal(gestures.up(pointer(0), 360, 1, true), undefined)
})

test('touch rotations use page displacement and reset clears accumulated spins', () => {
    const gestures = nativeGestures()
    gestures.down(pointer(0, {pointerType: 'touch'}), true)
    gestures.move(pointer(10, {pointerType: 'touch', pageX: 230}), 360, 1)
    gestures.up(pointer(10, {pointerType: 'touch', pageX: 230}), 360, 1, true)
    assert.equal(gestures.spins, 1)
    gestures.clear(true)
    assert.equal(gestures.spins, 0)
})

test('raycast refreshes a moved skinned pose box as well as its sphere and ignores hidden meshes', () => {
    const geometry = new BoxGeometry()
    const count = geometry.attributes.position.count
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(count * 4), 4))
    const weights = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) weights[i * 4] = 1
    geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4))
    const scene = new Group(), bone = new Bone()
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial())
    scene.add(bone, mesh)
    mesh.bind(new Skeleton([bone]))
    mesh.computeBoundingBox(); mesh.computeBoundingSphere()
    bone.position.x = 3
    const camera = new PerspectiveCamera(35, 1, .01, 100)
    camera.position.set(3, 0, 5); camera.lookAt(3, 0, 0); camera.updateProjectionMatrix()
    const canvas = {getBoundingClientRect: () => ({left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100})} as HTMLCanvasElement
    const model = {scene, scenes: [scene]} as GLTF
    assert.equal(hitsModel(model, camera, canvas, {clientX: 50, clientY: 50}), true)
    assert.ok(mesh.boundingBox!.min.x > 2)
    mesh.visible = false
    assert.equal(hitsModel(model, camera, canvas, {clientX: 50, clientY: 50}), false)
    assert.equal(hitsModel(model, camera, canvas, {clientX: -1, clientY: 50}), false)
    disposeGLTF(model)
})
