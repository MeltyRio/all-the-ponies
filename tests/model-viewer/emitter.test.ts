import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createEmitterSimulation, createNativeEmitters, type NativeEmitterProfile } from '../../src/components/model-viewer/emitter'

// Hand-authored numeric/blank-texture fixture, not native artwork.
function fixture(): NativeEmitterProfile {
    const row = (position: number, alpha: number, rotation: number) => [position, position, 0, rotation, 1, .5, .25, alpha, 2, 2]
    return {version: 1, coordinateSpace: 'native-world-2d', anchor: 'model-origin', texture: 0,
        particle: {rate: -1, count: 3, lifetime: 3, timeWarp: 1, speed: 1, force: [0, 0, 0, 0], uv: [0, 0, 1, 1],
            min: [row(-1, 1, 0), row(-1, 1, 90), row(-1, 0, 270)],
            max: [row(1, 1, 0), row(1, 1, 90), row(1, 0, 270)],
            portions: [0, 1, 2], positionModes: [5, 6, 6], blend: 'add'}}
}
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

function fakeGLTF(profile = fixture()) {
    const texture = new THREE.Texture(), body = new THREE.Group()
    const calls = {dispose: 0, close: 0}
    texture.source.data = {close() { calls.close++ }}
    texture.addEventListener('dispose', () => { calls.dispose++ })
    return {texture, calls, gltf: {scene: body, scenes: [body], parser: {json: {
        extras: {atpInteractions: {version: 1, effects: {mlp_arena_pony_defeat_02: profile}}},
        nodes: [{scale: [1, 1, 1]}], textures: [{source: 0}], images: [{mimeType: 'image/png', bufferView: 0}],
    }, async getDependency() { return texture }}} as any}
}

test('burst emits once on positive update and retains native disk/ring targets and weighted durations', () => {
    const sim = createEmitterSimulation(fixture(), () => .5)
    sim.trigger(); sim.update(0)
    assert.equal(sim.snapshot().particles.length, 0)
    sim.update(1 / 60)
    assert.equal(sim.snapshot().particles.length, 3)
    const first = sim.snapshot().particles[0]!
    close(first.value[0]!, Math.sqrt(.5) / Math.sqrt(2.5))
    close(first.value[1]!, 0)
    close(first.targets[1]![0]!, Math.cos(-2.356194496154785))
    assert.deepEqual(first.durations, [1, 2])
    sim.update(1)
    assert.equal(first.segment, 1)
    close(first.value[7]!, 1)
    sim.update(1)
    close(first.value[7]!, .5)
    sim.update(1)
    assert.equal(sim.active, false)
    assert.equal(sim.snapshot().particles.length, 0)
})

test('billboard uses model origin, original particle coordinates, additive depth-free quads and releases owned dependencies', async () => {
    const {gltf, calls} = fakeGLTF(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera()
    scene.add(gltf.scene); gltf.scene.position.set(2, 3, 4); camera.rotation.y = .4
    const emitter = await createNativeEmitters(gltf, scene, camera)
    emitter.trigger('mlp_arena_pony_defeat_02'); emitter.update(.01); emitter.render()
    const group = scene.children.find(child => child !== gltf.scene)!
    assert.deepEqual(group.position.toArray(), [2, 3, 4])
    group.quaternion.toArray().forEach((value, i) => close(value, camera.quaternion.toArray()[i]!))
    const mesh = group.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
    const values = emitter.snapshot()[0]!.particles[0]!.value
    close(mesh.position.x, values[0]!); close(mesh.position.y, -values[1]!)
    assert.equal(mesh.material.blending, THREE.AdditiveBlending)
    assert.equal(mesh.material.map!.colorSpace, THREE.SRGBColorSpace)
    assert.equal(mesh.material.map!.flipY, false)
    assert.equal(mesh.material.map!.generateMipmaps, false)
    assert.equal(mesh.material.depthWrite, false); assert.equal(mesh.material.depthTest, false)
    emitter.reset(); assert.equal(scene.children.length, 1)
    emitter.dispose(); assert.deepEqual(calls, {dispose: 1, close: 1})
    emitter.dispose(); assert.deepEqual(calls, {dispose: 1, close: 1})
    assert.throws(() => emitter.trigger('mlp_arena_pony_defeat_02'))
})
