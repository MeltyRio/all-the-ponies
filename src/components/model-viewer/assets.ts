import { createAssetUrl } from '../../scripts/assets'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'

export interface AssetRef {
    path: string
    sha256: string
    bytes: number
    rigKey: string
}

export interface AnimationRef extends AssetRef {
    id: string
    name: string
    duration: number
}

export interface ModelRef extends AssetRef {
    animations: AnimationRef[]
}

const cataloguePath = 'models_3d.json'
const digestPattern = /^[a-f0-9]{64}$/

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

function checkAsset(value: AssetRef) {
    check(value && digestPattern.test(value.sha256) && digestPattern.test(value.rigKey), 'Invalid 3D resource identity')
    // Asset keys, never URLs: createAssetUrl also accepts absolute URLs, which
    // must not let a catalogue choose a different host or a private endpoint.
    check(value.path === `models/3d/${value.sha256}.glb`, 'Invalid 3D resource path')
    check(Number.isSafeInteger(value.bytes) && value.bytes > 0, 'Invalid 3D resource size')
}

async function fetchJson(path: string, signal: AbortSignal, version?: string) {
    signal.throwIfAborted()
    const url = new URL(createAssetUrl(path))
    if (version) url.searchParams.set('v', version)
    const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', cache: 'no-cache' })
    check(response.ok, `3D catalogue request failed (${response.status})`)
    const value: unknown = await response.json()
    signal.throwIfAborted()
    return value
}

/** Use ATP's uploaded manifest version, not a pre-upload JSON byte digest.
 * game-data rewrites JSON before upload; its manifest hashes the final bytes.
 * The JSON describes resources semantically; binary GLBs are verified below.
 */
export async function resolveModel(identity: string, signal: AbortSignal): Promise<ModelRef | null> {
    const manifest = await fetchJson('manifest.json', signal) as Record<string, unknown>
    check(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Invalid asset manifest')
    if (!Object.prototype.hasOwnProperty.call(manifest, cataloguePath)) return null
    const version = manifest[cataloguePath]
    check(typeof version === 'string' && digestPattern.test(version), 'Invalid 3D catalogue version')
    const catalogue = await fetchJson(cataloguePath, signal, version) as {
        schemaVersion: number
        models: Record<string, ModelRef>
    }
    check(catalogue?.schemaVersion === 1 && catalogue.models && typeof catalogue.models === 'object'
        && !Array.isArray(catalogue.models), 'Unsupported 3D catalogue')
    if (!Object.prototype.hasOwnProperty.call(catalogue.models, identity)) return null
    const model = catalogue.models[identity]
    checkAsset(model)
    check(Array.isArray(model.animations), 'Invalid animation list')
    const ids = new Set<string>()
    for (const animation of model.animations) {
        checkAsset(animation)
        check(typeof animation.id === 'string' && animation.id.length > 0 && !ids.has(animation.id), 'Invalid animation identity')
        check(typeof animation.name === 'string' && animation.name.length > 0, 'Invalid animation name')
        check(Number.isFinite(animation.duration) && animation.duration >= 0, 'Invalid animation duration')
        check(animation.rigKey === model.rigKey, 'Animation rig is incompatible')
        ids.add(animation.id)
    }
    return model
}

export async function verifiedBytes(ref: AssetRef, signal: AbortSignal): Promise<ArrayBuffer> {
    checkAsset(ref)
    signal.throwIfAborted()
    const response = await fetch(createAssetUrl(ref.path), { signal, credentials: 'omit', redirect: 'error' })
    check(response.ok, `3D resource request failed (${response.status})`)
    const bytes = await response.arrayBuffer()
    signal.throwIfAborted()
    check(bytes.byteLength === ref.bytes, '3D resource size mismatch')
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    signal.throwIfAborted()
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    check(hash === ref.sha256, '3D resource digest mismatch')
    return bytes
}

export function disposeGLTF(gltf: GLTF) {
    const geometries = new Set<any>(), materials = new Set<any>(), textures = new Set<any>()
    const skeletons = new Set<any>(), images = new Set<ImageBitmap>()
    for (const scene of gltf.scenes) scene.traverse((object: any) => {
        if (object.geometry) geometries.add(object.geometry)
        if (object.skeleton) skeletons.add(object.skeleton)
        for (const material of [object.material].flat().filter(Boolean)) {
            materials.add(material)
            for (const value of Object.values(material) as any[]) if (value?.isTexture) textures.add(value)
        }
    })
    for (const texture of textures) {
        if (typeof texture.source?.data?.close === 'function') images.add(texture.source.data)
        texture.dispose()
    }
    for (const image of images) image.close()
    for (const item of [...geometries, ...materials, ...skeletons]) item.dispose()
}

export async function loadGLB(ref: AssetRef, signal: AbortSignal): Promise<GLTF> {
    const bytes = await verifiedBytes(ref, signal)
    // This profile embeds all buffers and images. Reject external dependencies
    // before GLTFLoader can fetch anything beyond the verified catalogue key.
    const header = new DataView(bytes)
    check(bytes.byteLength >= 20 && header.getUint32(0, true) === 0x46546c67
        && header.getUint32(4, true) === 2 && header.getUint32(8, true) === bytes.byteLength
        && header.getUint32(16, true) === 0x4e4f534a, 'Invalid GLB header')
    const length = header.getUint32(12, true)
    check(length <= bytes.byteLength - 20, 'Truncated GLB JSON')
    const document = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)))
    check([...(document.buffers ?? []), ...(document.images ?? [])].every(item => item.uri === undefined),
        'External GLB resources are unsupported')
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    signal.throwIfAborted()
    const gltf = await new GLTFLoader().parseAsync(bytes, '')
    if (signal.aborted) {
        disposeGLTF(gltf)
        signal.throwIfAborted()
    }
    return gltf
}
