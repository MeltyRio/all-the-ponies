import test from 'node:test'
import assert from 'node:assert/strict'
import { Object3D, Scene, SkinnedMesh, Vector3, Vector4 } from 'three'
import { loadGLB, disposeGLTF } from '../../src/components/model-viewer/assets'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { downloadModel } from '../../src/components/model-viewer/download'

for (const [vertices, componentType] of [[65535, 5123], [65536, 5125], [65537, 5125]]) {
    test(`GLB download preserves ${vertices} retained vertices with index component type ${componentType}`, async () => {
        // One unused source vertex also checks that the boundary uses retained geometry.
        const positionBytes = (vertices + 1) * 12, indexCount = Math.ceil(vertices / 3) * 3
        const binary = new ArrayBuffer(positionBytes + indexCount * 4)
        const indices = new Uint32Array(binary, positionBytes, indexCount)
        for (let i = 0; i < indexCount; i++) indices[i] = i % vertices
        const scene = new Scene(), root = new Object3D(), joint = new Object3D()
        root.add(joint); scene.add(root)
        const json = {
            nodes: [{children: [1]}, {}, {mesh: 0}],
            meshes: [{name: 'boundary', primitives: [{attributes: {POSITION: 0}, indices: 1}]}],
            bufferViews: [{byteOffset: 0, byteLength: positionBytes}, {byteOffset: positionBytes, byteLength: indexCount * 4}],
            accessors: [
                {bufferView: 0, componentType: 5126, count: vertices + 1, type: 'VEC3'},
                {bufferView: 1, componentType: 5125, count: indexCount, type: 'SCALAR'},
            ],
            extras: {atpRig: {version: 1, key: 'a'.repeat(64), parents: [-1], jointNodes: [1],
                coordinateSystem: 'native-Y-down-to-glTF-Y-up-RxPi'}},
        }
        const model = {scene, parser: {json,
            associations: new Map([[root, {nodes: 0}], [joint, {nodes: 1}]]),
            getDependency: async (type: string, index: number) => {
                assert.equal(type, 'buffer'); assert.equal(index, 0)
                return binary
            },
        }} as unknown as GLTF
        const result = await downloadModel(model, new Set([2]), [], new AbortController().signal, () => {})
        const jsonLength = new DataView(result).getUint32(12, true)
        const document = JSON.parse(new TextDecoder().decode(new Uint8Array(result, 20, jsonLength)))
        const primitive = document.meshes[0].primitives[0]
        const index = document.accessors[primitive.indices]
        // glTF reserves the maximum component value: Uint16 must never emit 65535.
        assert.equal(index.componentType, componentType)
        assert.equal(document.accessors[primitive.attributes.POSITION].count, vertices)
        const Type = componentType === 5125 ? Uint32Array : Uint16Array
        const output = new Type(result, 28 + jsonLength + document.bufferViews[index.bufferView].byteOffset, index.count)
        assert.deepEqual(Array.from(output), Array.from(indices))
    })
}


test('native weights survive GLTFLoader normalization and client download', async () => {
    const json: any = {asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0, 2]}],
        nodes: [{children: [1]}, {}, {mesh: 0, skin: 0}], skins: [{joints: [1]}],
        meshes: [], accessors: [], bufferViews: [], buffers: [],
        extras: {atpRig: {version: 1, key: 'a'.repeat(64), parents: [-1], jointNodes: [1],
            coordinateSystem: 'native-Y-down-to-glTF-Y-up-RxPi'}}}
    const chunks: Uint8Array[] = []
    let length = 0
    function attribute(values: Float32Array | Uint16Array, type: string, width: number) {
        const bytes = new Uint8Array(values.buffer)
        json.bufferViews.push({buffer: 0, byteOffset: length, byteLength: bytes.length})
        chunks.push(bytes); length += bytes.length
        json.accessors.push({bufferView: json.bufferViews.length - 1, componentType: values instanceof Float32Array ? 5126 : 5123,
            count: values.length / width, type})
        return json.accessors.length - 1
    }
    const weights = new Float32Array([16048 / 65535, 8845 / 65535, 13012 / 65535, 4287 / 65535,
        1, 0, 0, 0, 1, 0, 0, 0])
    const attributes = {POSITION: attribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 'VEC3', 3),
        JOINTS_0: attribute(new Uint16Array(12), 'VEC4', 4),
        WEIGHTS_0: attribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4', 4),
        _NATIVE_JOINTS: attribute(new Uint16Array(12), 'VEC4', 4),
        _NATIVE_WEIGHTS: attribute(weights, 'VEC4', 4)}
    const indices = attribute(new Uint16Array([0, 1, 2, 0]), 'SCALAR', 1)
    json.accessors[indices].count = 3
    json.accessors[attributes.POSITION].min = [0, 0, 0]
    json.accessors[attributes.POSITION].max = [1, 1, 1]
    json.meshes.push({name: 'native', primitives: [{attributes, indices}]})
    json.skins[0].inverseBindMatrices = attribute(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 'MAT4', 16)
    json.buffers.push({byteLength: length})
    const text = new TextEncoder().encode(JSON.stringify(json)), jsonSize = Math.ceil(text.length / 4) * 4
    const data = new ArrayBuffer(28 + jsonSize + length), bytes = new Uint8Array(data), view = new DataView(data)
    view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, data.byteLength, true)
    view.setUint32(12, jsonSize, true); view.setUint32(16, 0x4e4f534a, true)
    bytes.fill(32, 20, 20 + jsonSize); bytes.set(text, 20)
    view.setUint32(20 + jsonSize, length, true); view.setUint32(24 + jsonSize, 0x004e4942, true)
    let offset = 28 + jsonSize
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length}
    const fetch = globalThis.fetch
    globalThis.fetch = async () => new Response(data)
    let model: GLTF | undefined
    try {
        model = await loadGLB({path: 'models/3d/native.glb', bytes: data.byteLength, sha256: 'a'.repeat(64), rigKey: 'a'.repeat(64)}, new AbortController().signal)
        const mesh = model.scene.children.find(object => object instanceof SkinnedMesh) as SkinnedMesh
        assert.deepEqual(Array.from(mesh.geometry.attributes.skinWeight.array), Array.from(weights))
        mesh.skeleton.bones[0].position.x = 2
        model.scene.updateMatrixWorld(true)
        const point = mesh.applyBoneTransform(0, new Vector3(1, 0, 0))
        assert.ok(Math.abs(point.x - 3 * weights.slice(0, 4).reduce((a, b) => a + b, 0)) < 1e-6)
        // Additional-actor placement moves both the rig and mesh. CPU bounds
        // must agree with GPU skinning when the native weight sum is not one.
        model.scene.position.set(4, 5, 6)
        model.scene.updateMatrixWorld(true)
        const placed = mesh.applyBoneTransform(0, new Vector3(1, 0, 0)).applyMatrix4(mesh.matrixWorld)
        assert.ok(placed.distanceTo(new Vector3(point.x + 4, 5, 6)) < 1e-6)
        const homogeneous = mesh.applyBoneTransform(0, new Vector4(1, 0, 0, 1)).applyMatrix4(mesh.matrixWorld)
        assert.ok(new Vector3(homogeneous.x, homogeneous.y, homogeneous.z).distanceTo(placed) < 1e-6)
        const downloaded = await downloadModel(model, new Set([2]), [], new AbortController().signal, () => {})
        const size = new DataView(downloaded).getUint32(12, true)
        const output = JSON.parse(new TextDecoder().decode(new Uint8Array(downloaded, 20, size)))
        const attrs = output.meshes[0].primitives[0].attributes
        const accessor = output.accessors[attrs._NATIVE_WEIGHTS]
        const raw = new Float32Array(downloaded, 28 + size + output.bufferViews[accessor.bufferView].byteOffset, 12)
        assert.deepEqual(Array.from(raw), Array.from(weights))
        assert.ok(attrs._NATIVE_JOINTS !== undefined && attrs.WEIGHTS_0 !== undefined)
    } finally {globalThis.fetch = fetch; if (model) disposeGLTF(model)}
})
