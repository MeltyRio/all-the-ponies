import { Mesh, Raycaster, SkinnedMesh, Vector2 } from 'three'
import type { Camera } from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'

const eyeStates = ['Open', 'Closed', 'Happy', 'Frown'] as const
type EyeState = typeof eyeStates[number] | 'None'
export type NativeEvent = {frame: number} & (
    {type: 'EyeSet', state: EyeState, enableBlink: boolean}
    | {type: 'Emitter', effect: string}
)

function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message)
}

/** Hidden eye nodes are outside the default glTF scene so generic readers still
 * show the static appearance. Load them explicitly, sharing the same bones.
 * Attach before material setup and bounds, and before checking cancellation so
 * the caller can release every completed dependency through disposeGLTF.
 */
export async function prepareNativeEyes(model: GLTF, signal: AbortSignal) {
    const json = model.parser.json
    const profile = json.extras?.atpInteractions
    if (profile === undefined) return undefined
    check(profile?.version === 1 && Object.keys(profile).every(key => ['version', 'eyes', 'hiddenNodes', 'effects'].includes(key)),
        'Unsupported model interaction profile')
    const hidden: number[] = profile.hiddenNodes ?? []
    check(Array.isArray(hidden) && new Set(hidden).size === hidden.length
        && hidden.every(index => Number.isSafeInteger(index) && index >= 0 && json.nodes?.[index]), 'Invalid hidden eye nodes')
    for (const index of hidden) {
        check(!json.scenes?.some((scene: any) => scene.nodes?.includes(index))
            && !json.nodes.some((node: any) => node.children?.includes(index)), 'Hidden eye node is not independent')
        signal.throwIfAborted()
        const object = await model.parser.getDependency('node', index)
        object.visible = false
        model.scene.add(object)
        signal.throwIfAborted()
    }
    const meshes = new Map<number, Mesh>()
    const defaults = new Map<Mesh, boolean>()
    model.scene.traverse(object => {
        if (!(object instanceof Mesh)) return
        const nodeIndex = model.parser.associations.get(object)?.nodes
        const node = json.nodes?.[nodeIndex]
        const index = node?.extras?.atpNativeMeshIndex
        const visible = node?.extras?.atpDefaultVisible
        check(Number.isSafeInteger(index) && index >= 0 && !meshes.has(index)
            && typeof visible === 'boolean' && (hidden.includes(nodeIndex) === !visible), 'Invalid native mesh visibility')
        meshes.set(index, object)
        defaults.set(object, visible)
        object.visible = visible
    })
    const groups = profile.eyes as Partial<Record<typeof eyeStates[number], number[]>> | undefined
    if (groups !== undefined) {
        check(groups && typeof groups === 'object' && !Array.isArray(groups)
            && Object.keys(groups).every(key => eyeStates.includes(key as typeof eyeStates[number])), 'Invalid eye groups')
        for (const indices of Object.values(groups)) check(Array.isArray(indices)
            && new Set(indices).size === indices.length && indices.every(index => meshes.has(index)), 'Invalid eye mesh reference')
    }
    const allEyes = new Set(Object.values(groups ?? {}).flat())
    check(hidden.every(index => allEyes.has(json.nodes[index].extras.atpNativeMeshIndex)), 'Hidden node is not an eye mesh')
    // An empty Open group is a legal static appearance, not enough evidence to
    // invent blinking. Other expressions may share native subobjects.
    const canBlink = Boolean(groups?.Open?.length && groups?.Closed?.length
        && [...allEyes].filter(index => defaults.get(meshes.get(index)!)).length === groups.Open.length
        && groups.Open.every(index => defaults.get(meshes.get(index)!))
        && groups.Closed.every(index => !defaults.get(meshes.get(index)!) && !groups.Open!.includes(index)))
    let expression: EyeState = 'Open', enabled = true, open = false, remaining = 0
    function show(state: EyeState) {
        for (const index of allEyes) meshes.get(index)!.visible = false
        if (state !== 'None') for (const index of groups?.[state] ?? []) meshes.get(index)!.visible = true
    }
    return {
        get active() { return canBlink && enabled },
        update(delta: number) {
            if (!canBlink || !enabled) return
            if (remaining > 0) { remaining = Math.fround(remaining - Math.fround(delta)); return }
            show(open ? 'Closed' : expression)
            remaining = open ? Math.fround(.1) : 2 + Math.floor(Math.random() * 4)
            open = !open
        },
        set(event: Extract<NativeEvent, {type: 'EyeSet'}>) {
            expression = event.state
            enabled = event.enableBlink
            show(expression)
            // The native eye setter does not restart the blink phase/timer.
        },
        reset() {
            for (const [mesh, visible] of defaults) mesh.visible = visible
            expression = 'Open'
            enabled = true
        },
        snapshot() {
            return {canBlink, expression, enabled, open, remaining,
                visible: [...meshes].filter(([, mesh]) => mesh.visible).map(([index]) => index)}
        },
    }
}

/** A supported event profile is opt-in. Other callers (including independent
 * companions) keep rejecting eventful clips until they have a controller.
 */
export function nativeEvents(model: GLTF, metadata: any, allow: boolean): NativeEvent[] {
    const events = metadata.events
    if (events === undefined || Array.isArray(events) && events.length === 0) {
        check(metadata.eventProfile === undefined || metadata.eventProfile === 'ponybook-v1', 'Unsupported animation event profile')
        return []
    }
    check(allow && metadata.eventProfile === 'ponybook-v1' && Array.isArray(events), 'Animation events are not supported by this viewer')
    const profile = model.parser.json.extras?.atpInteractions
    check(profile?.version === 1, 'Model has no native interaction profile')
    let previous = -1
    for (const event of events) {
        check(event && Number.isSafeInteger(event.frame) && event.frame >= previous
            && event.frame >= 0 && event.frame < metadata.frameCount, 'Invalid native event frame')
        previous = event.frame
        if (event.type === 'EyeSet') {
            check(Object.keys(event).sort().join(',') === 'enableBlink,frame,state,type'
                && [...eyeStates, 'None'].includes(event.state) && typeof event.enableBlink === 'boolean'
                && profile.eyes && (event.state === 'None' || Array.isArray(profile.eyes[event.state])), 'Unsupported eye event')
        } else if (event.type === 'Emitter') {
            check(Object.keys(event).sort().join(',') === 'effect,frame,type'
                && typeof event.effect === 'string' && Object.prototype.hasOwnProperty.call(profile.effects ?? {}, event.effect),
            'Unresolved native emitter event')
        } else throw new Error('Unsupported native animation event')
    }
    return events.map(event => ({...event}))
}

/** Test the current skinned pose, never rest-pose bounds or companion meshes. */
export function hitsModel(model: GLTF, camera: Camera, canvas: HTMLCanvasElement, event: Pick<PointerEvent, 'clientX' | 'clientY'>) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) return false
    camera.updateMatrixWorld(true)
    model.scene.updateMatrixWorld(true)
    const meshes: Mesh[] = []
    model.scene.traverseVisible(object => {
        if (!(object instanceof Mesh)) return
        if (object instanceof SkinnedMesh) { object.computeBoundingSphere(); object.computeBoundingBox() }
        meshes.push(object)
    })
    const ray = new Raycaster()
    ray.setFromCamera(new Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
        1 - (event.clientY - rect.top) / rect.height * 2), camera)
    return ray.intersectObjects(meshes, false).length > 0
}

/** Book uses signed horizontal displacement modulo one turn. Four releases
 * strictly over 220 degrees trigger defeat; returning to the start is not a tap.
 */
export function nativeGestures() {
    const pointers = new Map<number, {x: number, startX: number, startY: number, moved: boolean, angle: number, rotating: boolean, multiple: boolean}>()
    let spins = 0
    function move(event: PointerEvent, height: number, speed: number) {
        const pointer = pointers.get(event.pointerId)
        if (!pointer) return
        if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 4) pointer.moved = true
        const x = event.pointerType === 'touch' ? event.pageX : event.clientX
        if (pointer.rotating && !pointer.multiple && Number.isFinite(x) && Number.isFinite(pointer.x))
            pointer.angle += (x - pointer.x) * 360 * speed / Math.max(1, height)
        pointer.x = x
    }
    return {
        down(event: PointerEvent, enabled: boolean) {
            for (const pointer of pointers.values()) pointer.multiple = true
            const touch = event.pointerType === 'touch'
            pointers.set(event.pointerId, {x: touch ? event.pageX : event.clientX,
                startX: event.clientX, startY: event.clientY, moved: false, angle: 0,
                rotating: enabled && (touch || event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey),
                multiple: pointers.size > 0})
        },
        move,
        up(event: PointerEvent, height: number, speed: number, enabled: boolean): 'click' | 'dizzy' | undefined {
            const pointer = pointers.get(event.pointerId)
            move(event, height, speed) // Include the final pointerup displacement.
            pointers.delete(event.pointerId)
            if (!pointer || event.type === 'pointercancel' || !enabled || !pointer.rotating || pointer.multiple) return
            if (!pointer.moved) return 'click'
            if (Math.abs(pointer.angle % 360) > 220 && ++spins >= 4) { spins = 0; return 'dizzy' }
        },
        clear(resetSpins = false) { pointers.clear(); if (resetSpins) spins = 0 },
        get spins() { return spins },
    }
}
