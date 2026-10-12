import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, AnimationMixer, InterpolateDiscrete, Object3D, QuaternionKeyframeTrack, Scene, VectorKeyframeTrack } from 'three';
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
