import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, AnimationMixer, BufferAttribute, InterpolateDiscrete, LoopOnce, Object3D, Quaternion, QuaternionKeyframeTrack, Scene, Vector3, VectorKeyframeTrack } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { bindAnimation, rigMetadata } from '../../src/components/model-viewer/animation';
import type { AnimationRef } from '../../src/components/model-viewer/assets';

/** Synthetic GLTFLoader output; browser tests separately use real parsed GLBs. */
function fixture() {
    const rig = {version: 1, key: 'a'.repeat(64), parents: [-1, 0], jointNodes: [1, 2], coordinateSystem: 'native-Y-down-to-glTF-Y-up-RxPi'}
    function make() {
        const scene = new Scene()
        const root = new Object3D()
        const first = new Object3D()
        const second = new Object3D()
        first.name = 'shared_name'
        second.name = 'shared_name_2'
        root.add(first)
        first.add(second)
        scene.add(root)
        const nodes = [root, first, second]
        const associations = new Map(nodes.map((node, index) => [node, {nodes: index}]))
        const json: any = {
            nodes: [{children: [1]}, {children: [2]}, {}],
            extras: {atpRig: structuredClone(rig)},
        }
        const gltf = {scene, scenes: [scene], animations: [], parser: {json, associations, getDependency: async (_: string, index: number) => nodes[index]}} as unknown as GLTF
        return {gltf, nodes, json}
    }
    const model = make()
    const source = make()
    const times = [0, .5, 1]
    source.json.extras.atpClip = {fps: 2, frameCount: 2, duration: 1, events: []}
    source.json.accessors = [{count: 3}, {count: 3}]
    const channels = [1, 2].flatMap(node => ['translation', 'rotation'].map(path => ({sampler: 0, target: {node, path}})))
    source.json.animations = [{channels, samplers: [{input: 0, output: 1, interpolation: 'STEP'}]}]
    source.gltf.animations = [new AnimationClip('motion', 1, [1, 2].flatMap(index => [
        new VectorKeyframeTrack(`${source.nodes[index].name}.position`, times, [0, 0, 0, 1, 0, 0, 1, 0, 0], InterpolateDiscrete),
        new QuaternionKeyframeTrack(`${source.nodes[index].name}.quaternion`, times, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], InterpolateDiscrete),
    ]))]
    const ref: AnimationRef = {path: `models/3d/${'b'.repeat(64)}.glb`, sha256: 'b'.repeat(64), bytes: 100, id: 'motion', name: 'Motion', rigKey: rig.key, duration: 1}
    return {model, source, ref}
}

test('binds each track to destination UUID and preserves STEP sampling', async () => {
    const {model, source, ref} = fixture()
    model.nodes[1].name = model.nodes[2].name = 'duplicate_destination_name'
    const clip = await bindAnimation(model.gltf, source.gltf, ref)
    assert.equal(clip.tracks[0].name, `${model.nodes[1].uuid}.position`)
    assert.equal(clip.tracks[2].name, `${model.nodes[2].uuid}.position`)
    assert.equal(clip.tracks[0].getInterpolation(), InterpolateDiscrete)
    const mixer = new AnimationMixer(model.gltf.scene)
    mixer.clipAction(clip).play()
    mixer.update(.75)
    assert.equal(model.nodes[1].position.x, 1)
    assert.equal(model.nodes[2].position.x, 1)
    mixer.stopAllAction()
    assert.equal(model.nodes[1].position.x, 0)
    mixer.uncacheRoot(model.gltf.scene)
})

test('rejects a different rig even when the bone count is equal', async () => {
    const {model, source, ref} = fixture()
    source.json.extras.atpRig.key = 'c'.repeat(64)
    await assert.rejects(bindAnimation(model.gltf, source.gltf, ref), /rig is incompatible/)
})

test('rejects inconsistent hierarchy and duplicate joint indices', () => {
    const {model} = fixture()
    model.json.nodes[1].children = []
    assert.throws(() => rigMetadata(model.gltf), /hierarchy mismatch/)
    model.json.extras.atpRig.jointNodes = [1, 1]
    assert.throws(() => rigMetadata(model.gltf), /Duplicate joint/)
})

test('rejects native events rather than silently playing without their props', async () => {
    const {model, source, ref} = fixture()
    source.json.extras.atpClip.events = [{frame: 0, type: 'subObject', target: 'cloud', value: true}]
    await assert.rejects(bindAnimation(model.gltf, source.gltf, ref), /events are not supported/)
})

test('rejects duplicate channels, unsupported interpolation and duration mismatches', async () => {
    for (const mutation of ['duplicate', 'interpolation', 'duration']) {
        const {model, source, ref} = fixture()
        if (mutation === 'duplicate') source.json.animations[0].channels[1] = source.json.animations[0].channels[0]
        if (mutation === 'interpolation') source.json.animations[0].samplers[0].interpolation = 'LINEAR'
        if (mutation === 'duration') ref.duration = 2
        await assert.rejects(bindAnimation(model.gltf, source.gltf, ref), /Duplicate animation channel|Unsupported animation channel|timing mismatch|duration mismatch/)
    }
})

test('rejects a loader track that does not correspond to its declared channel', async () => {
    const {model, source, ref} = fixture()
    source.gltf.animations[0].tracks[0].name = 'wrong.position'
    await assert.rejects(bindAnimation(model.gltf, source.gltf, ref), /Loader channel order mismatch/)
})

test('rejects incomplete accessor output rather than accepting truncated tracks', async () => {
    const {model, source, ref} = fixture()
    source.json.accessors[1].count = 4
    await assert.rejects(bindAnimation(model.gltf, source.gltf, ref), /accessor mismatch/)
})


test('rejects metadata and sample times that disagree with the native frame rate', async () => {
    const {model, source, ref} = fixture()
    source.gltf.animations[0].tracks[0].times[1] = .6
    await assert.rejects(bindAnimation(model.gltf, source.gltf, ref), /sample timing mismatch/)
})

test('accepts the basic converter profile that omits event metadata', async () => {
    const {model, source, ref} = fixture()
    delete source.json.extras.atpClip.events
    const clip = await bindAnimation(model.gltf, source.gltf, ref)
    assert.equal(clip.tracks.length, 4)
})

function nativeFixture() {
    const f = fixture(), half = Math.SQRT1_2
    const translations = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0])
    // Unequal packed lengths, and the equivalent negative quaternion at the
    // second root sample: tests normalization order and shortest-path choice.
    const rotations = new Float32Array([0, 0, 0, .8, 0, 0, 0, .9,
        0, 0, -half * .95, -half * .95, 0, 0, 0, .9])
    f.source.json.extras.atpClip.nativeSampling = {version: 1, translations: 2, rotations: 3}
    f.source.json.accessors.push({componentType: 5126, type: 'VEC3', count: 4}, {componentType: 5126, type: 'VEC4', count: 4})
    const attributes = [new BufferAttribute(translations, 3), new BufferAttribute(rotations, 4)]
    const dependency = f.source.gltf.parser.getDependency.bind(f.source.gltf.parser)
    f.source.gltf.parser.getDependency = async (type: string, index: number) => type === 'accessor' ? attributes[index - 2] : dependency(type, index)
    const tracks = f.source.gltf.animations[0].tracks
    tracks[0].values.set([0, 0, 0, 0, 0, 0, 0, 0, 0])
    tracks[1].values.set([0, 0, 0, 1, 0, 0, half, half, 0, 0, half, half])
    tracks[2].values.set([1, 0, 0, 0, -1, 0, 0, -1, 0])
    tracks[3].values.set([0, 0, 0, 1, 0, 0, -half, half, 0, 0, -half, half])
    return {...f, translations, rotations}
}

test('native sampling interpolates raw global quaternions before deriving local joints', async () => {
    const {model, source, ref, rotations} = nativeFixture()
    const clip = await bindAnimation(model.gltf, source.gltf, ref)
    const mixer = new AnimationMixer(model.gltf.scene)
    let finished = 0
    mixer.addEventListener('finished', () => finished++)
    const action = mixer.clipAction(clip).setLoop(LoopOnce, 1)
    action.clampWhenFinished = true
    action.play()
    mixer.update(.25)
    model.gltf.scene.updateMatrixWorld(true)
    const native = new Quaternion(0, 0, -rotations[10] / 2, (.8 - rotations[11]) / 2).normalize()
    assert.ok(1 - Math.abs(model.nodes[1].quaternion.dot(native)) < 1e-10)
    assert.ok(model.nodes[2].getWorldPosition(new Vector3()).distanceTo(new Vector3(1, 0, 0)) < 1e-6,
        'Global child translation stays constant despite the rotating parent')
    assert.ok(1 - Math.abs(model.nodes[2].getWorldQuaternion(new Quaternion()).w) < 1e-6)
    assert.ok(Math.abs(model.nodes[1].quaternion.z - Math.sin(Math.PI / 8)) > .01,
        'Unequal raw lengths are preserved, not pre-normalized or local SLERP')
    mixer.update(.5)
    const tail = model.nodes[1].quaternion.clone()
    mixer.update(.25)
    assert.equal(finished, 1)
    assert.equal(action.paused, true)
    assert.ok(1 - Math.abs(tail.dot(model.nodes[1].quaternion)) < 1e-6)
    mixer.stopAllAction()
    assert.deepEqual(model.nodes[1].position.toArray(), [0, 0, 0])
    assert.deepEqual(model.nodes[1].quaternion.toArray(), [0, 0, 0, 1])
    mixer.uncacheRoot(model.gltf.scene)
})

test('rejects malformed or inconsistent native sampling rather than falling back to STEP', async () => {
    for (const kind of ['version', 'extra', 'index', 'count', 'component', 'normalized', 'sparse', 'zero', 'nan', 'disagreement']) {
        const f = nativeFixture(), profile = f.source.json.extras.atpClip.nativeSampling
        if (kind === 'version') profile.version = 2
        if (kind === 'extra') profile.space = 'local'
        if (kind === 'index') profile.translations = -1
        if (kind === 'count') f.source.json.accessors[2].count--
        if (kind === 'component') f.source.json.accessors[2].componentType = 5123
        if (kind === 'normalized') f.source.json.accessors[2].normalized = true
        if (kind === 'sparse') f.source.json.accessors[2].sparse = {}
        if (kind === 'zero') f.rotations.fill(0, 0, 4)
        if (kind === 'nan') f.translations[0] = NaN
        if (kind === 'disagreement') f.translations[0] = 10
        await assert.rejects(bindAnimation(f.model.gltf, f.source.gltf, f.ref), /native sampling/i, kind)
    }
})
