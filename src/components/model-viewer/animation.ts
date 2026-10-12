import { AnimationClip, Object3D } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { AnimationRef } from './assets';

type Rig = {
    version: 1,
    key: string,
    parents: number[],
    jointNodes: number[],
    coordinateSystem: 'native-Y-down-to-glTF-Y-up-RxPi',
}

function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message)
}

export function rigMetadata(gltf: GLTF): Rig {
    const json = gltf.parser.json
    const rig = json.extras?.atpRig as Rig
    check(rig?.version === 1 && /^[a-f0-9]{64}$/.test(rig.key)
        && rig.coordinateSystem === 'native-Y-down-to-glTF-Y-up-RxPi', 'Unsupported rig metadata')
    check(Array.isArray(rig.parents) && rig.parents.length > 0
        && rig.parents.length === rig.jointNodes?.length, 'Invalid rig layout')
    check(new Set(rig.jointNodes).size === rig.parents.length, 'Duplicate joint nodes')
    for (let i = 0; i < rig.parents.length; i++) {
        const parent = rig.parents[i]
        const node = rig.jointNodes[i]
        check(Number.isInteger(parent) && parent >= -1 && parent < i
            && Number.isInteger(node) && node > 0 && json.nodes[node], 'Invalid joint index')
        const expectedParent = parent < 0 ? 0 : rig.jointNodes[parent]
        check(json.nodes[expectedParent]?.children?.includes(node), 'Rig hierarchy mismatch')
    }
    return rig
}

export function jointObjects(gltf: GLTF) {
    const rig = rigMetadata(gltf)
    const objects = new Map<number, Object3D>()
    gltf.scene.traverse(object => {
        const index = gltf.parser.associations.get(object)?.nodes
        if (rig.jointNodes.includes(index)) {
            check(!objects.has(index), 'Ambiguous joint association')
            objects.set(index, object)
        }
    })
    check(objects.size === rig.jointNodes.length, 'Missing model joints')
    return objects
}

/** Bind by verified node indices, never bone names or bone count alone. */
export async function bindAnimation(model: GLTF, animation: GLTF, ref: AnimationRef) {
    const targetRig = rigMetadata(model)
    const sourceRig = rigMetadata(animation)
    const json = animation.parser.json
    check(ref.rigKey === targetRig.key && sourceRig.key === targetRig.key
        && JSON.stringify(targetRig.parents) === JSON.stringify(sourceRig.parents)
        && JSON.stringify(targetRig.jointNodes) === JSON.stringify(sourceRig.jointNodes), 'Animation rig is incompatible')
    check(json.animations?.length === 1 && animation.animations.length === 1, 'Expected one independent animation')
    const metadata = json.extras?.atpClip
    check(Number.isInteger(metadata?.frameCount) && metadata.frameCount > 0
        && Number.isFinite(metadata.fps) && metadata.fps > 0, 'Invalid animation metadata')
    check(metadata.events === undefined || Array.isArray(metadata.events) && metadata.events.length === 0,
        'Animation events are not supported by the basic viewer')
    check(Math.abs(metadata.frameCount / metadata.fps - ref.duration) < 1e-4
        && Math.abs(metadata.duration - ref.duration) < 1e-4, 'Native animation timing mismatch')
    const source = animation.animations[0]
    const definition = json.animations[0]
    const joints = jointObjects(model)
    const seen = new Set<string>()
    check(source.tracks.length === definition.channels.length
        && source.tracks.length === targetRig.parents.length * 2, 'Animation track layout mismatch')
    const tracks = []
    for (let index = 0; index < definition.channels.length; index++) {
        const channel = definition.channels[index]
        const sampler = definition.samplers[channel.sampler]
        const targetIndex = channel.target.node
        const path = channel.target.path
        check(joints.has(targetIndex) && (path === 'translation' || path === 'rotation')
            && sampler?.interpolation === 'STEP', 'Unsupported animation channel')
        const key = `${targetIndex}:${path}`
        check(!seen.has(key), 'Duplicate animation channel')
        seen.add(key)
        const sourceNode = await animation.parser.getDependency('node', targetIndex)
        check(animation.parser.associations.get(sourceNode)?.nodes === targetIndex, 'Animation target association mismatch')
        const property = path === 'translation' ? 'position' : 'quaternion'
        const track = source.tracks[index]
        // GLTFLoader emits these non-morph tracks in channel order. Verify its
        // output before replacing names with the destination object's UUID.
        check(track.name === `${sourceNode.name || sourceNode.uuid}.${property}`
            && track.getValueSize() === (path === 'translation' ? 3 : 4), 'Loader channel order mismatch')
        check(track.times.length === json.accessors[sampler.input]?.count
            && track.values.length / track.getValueSize() === json.accessors[sampler.output]?.count, 'Animation accessor mismatch')
        check(track.times.length === metadata.frameCount + 1
            && track.times.every((time, frame) => Math.abs(time - frame / metadata.fps) < 1e-4), 'Native animation sample timing mismatch')
        const cloned = track.clone()
        cloned.name = `${joints.get(targetIndex)!.uuid}.${property}`
        tracks.push(cloned)
    }
    check(Math.abs(source.duration - ref.duration) < 1e-4, 'Animation duration mismatch')
    return new AnimationClip(ref.name, source.duration, tracks)
}
