import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bindAnimation, jointObjects, rigMetadata, type BoundAnimation } from './animation';
import { disposeGLTF, loadGLB, type AnimationRef, type ModelRef } from './assets';
import { loadAdditionalActor, type AdditionalActor } from './additional';
import { applyNativeDepth, nativeUVClock } from './native-materials';
import { hitsModel, nativeGestures, prepareNativeEyes } from './interactions';
import { createNativeEmitters } from './emitter';

export type ViewerState = {
    ready: boolean,
    loading: boolean,
    playing: boolean,
    free: boolean,
    activeAnimation: string,
    error: string,
}

/** Shared position buffers can contain unused vertices; fit rendered triangles. */
function visibleBounds(root: THREE.Object3D) {
    const box = new THREE.Box3()
    const point = new THREE.Vector3()
    root.updateMatrixWorld(true)
    root.traverseVisible(object => {
        if (!(object instanceof THREE.Mesh)) return
        const position = object.geometry.attributes.position
        const indices = object.geometry.index
        const used = new Set<number>()
        for (let i = 0; i < (indices?.count ?? position.count); i++) {
            used.add(indices ? indices.getX(i) : i)
        }
        for (const index of used) {
            point.fromBufferAttribute(position, index)
            if (object instanceof THREE.SkinnedMesh) object.applyBoneTransform(index, point)
            box.expandByPoint(point.applyMatrix4(object.matrixWorld))
        }
    })
    if (box.isEmpty()) throw new Error('Model has no visible geometry')
    return box
}

/** Created only after Vue mounts; this module performs no work during SSR. */
export function mountViewer(host: HTMLElement, ref: ModelRef, changed: (state: ViewerState) => void) {
    const state: ViewerState = {ready: false, loading: true, playing: false, free: false, activeAnimation: '', error: ''}
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, .01, 1000)
    const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true})
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
    const canvas = renderer.domElement
    canvas.tabIndex = 0
    host.appendChild(canvas)
    const controls = new OrbitControls(camera, canvas)
    controls.enablePan = false
    controls.enableZoom = false
    controls.enableDamping = false
    controls.touches.TWO = undefined
    let disposed = false
    let model: GLTF | undefined
    let additional: AdditionalActor | undefined
    let materialClock: ReturnType<typeof nativeUVClock> | undefined
    let eyes: Awaited<ReturnType<typeof prepareNativeEyes>>
    let effects: Awaited<ReturnType<typeof createNativeEmitters>> | undefined
    let mixer: THREE.AnimationMixer | undefined
    let rest: {object: THREE.Object3D, position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3}[] = []
    let initial: {position: THREE.Vector3, target: THREE.Vector3, polar: number} | undefined
    let frameId = 0
    let lastTime: number | undefined
    let generation = 0
    let finished = false
    const modelAbort = new AbortController()
    let animationAbort: AbortController | undefined
    const clips = new Map<string, BoundAnimation>()
    let activeClip: BoundAnimation | undefined
    let elapsed = 0, eventCursor = 0
    const gestures = nativeGestures()
    const notify = () => changed({...state})
    const render = () => { if (!disposed && model) { effects?.render(); renderer.render(scene, camera) } }

    function cancelFrame() {
        cancelAnimationFrame(frameId)
        frameId = 0
        lastTime = undefined
    }
    function restore() {
        for (const item of rest) {
            item.object.position.copy(item.position)
            item.object.quaternion.copy(item.quaternion)
            item.object.scale.copy(item.scale)
        }
        model?.scene.updateMatrixWorld(true)
        additional?.place()
        eyes?.reset()
    }
    function stop(keepEffects = false) {
        generation++
        animationAbort?.abort()
        animationAbort = undefined
        cancelFrame()
        mixer?.stopAllAction()
        restore()
        activeClip = undefined
        elapsed = eventCursor = 0
        if (!keepEffects) effects?.reset()
        state.playing = false
        state.loading = !state.ready
        state.activeAnimation = ''
        finished = false
        resume()
    }
    function applyEvents() {
        if (!activeClip) return
        const events = activeClip.nativeEvents
        // Walk every crossed event, including frame zero and same-frame order.
        while (eventCursor < events.length && events[eventCursor].frame <= Math.floor(elapsed * activeClip.nativeFPS)) {
            const event = events[eventCursor++]
            if (event.type === 'EyeSet') eyes!.set(event)
            else effects!.trigger(event.effect, Math.max(0, elapsed - event.frame / activeClip.nativeFPS))
        }
    }
    const ticking = () => state.playing || additional?.running() || materialClock?.active || eyes?.active || effects?.active
    function frame(time: number) {
        frameId = 0
        if (disposed || document.hidden || !ticking()) return
        const delta = lastTime === undefined ? 0 : Math.min((time - lastTime) / 1000, .1)
        lastTime = time
        effects?.update(delta)
        if (state.playing) {
            elapsed += delta
            mixer!.update(delta)
            applyEvents()
        }
        // Restore after mixer.update has applied its bindings, not from inside
        // the mixer's finished event, where it is still updating this frame.
        if (finished) {
            stop(true)
            notify()
        }
        additional?.update(delta)
        materialClock?.update(delta)
        eyes?.update(delta)
        render()
        resume()
    }
    function resume() {
        if (!disposed && state.ready && !document.hidden && ticking() && !frameId) {
            frameId = requestAnimationFrame(frame)
        }
    }
    function visibility() {
        if (document.hidden) { cancelFrame(); gestures.clear() }
        else { resume(); render() }
    }
    function resize() {
        const width = Math.max(1, host.clientWidth)
        const height = Math.max(1, host.clientHeight)
        renderer.setSize(width, height, false)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        render()
    }
    function resetCamera() {
        if (!initial) return
        controls.minPolarAngle = 0
        controls.maxPolarAngle = Math.PI
        camera.position.copy(initial.position)
        controls.target.copy(initial.target)
        controls.update()
        if (!state.free) controls.minPolarAngle = controls.maxPolarAngle = initial.polar
        controls.update()
        render()
    }
    function reset() {
        stop()
        gestures.clear(true)
        state.error = ''
        additional?.restart()
        resetCamera()
        notify()
    }
    function setFree(free: boolean) {
        gestures.clear(true)
        state.free = free
        controls.enableZoom = free
        controls.touches.TWO = free ? THREE.TOUCH.DOLLY_PAN : undefined
        if (free) {
            controls.minPolarAngle = 0
            controls.maxPolarAngle = Math.PI
            controls.update()
            render()
        } else {
            stop()
            resetCamera()
        }
        notify()
    }
    function keydown(event: KeyboardEvent) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const offset = camera.position.clone().sub(controls.target)
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), event.key === 'ArrowLeft' ? .1 : -.1)
        camera.position.copy(controls.target).add(offset)
        controls.update()
    }
    function pointerdown(event: PointerEvent) {
        if (!state.ready || disposed || document.hidden) return
        gestures.down(event, controls.enabled && controls.enableRotate)
    }
    function pointermove(event: PointerEvent) {
        if (controls.enabled) gestures.move(event, canvas.clientHeight, controls.rotateSpeed)
    }
    function pointerup(event: PointerEvent) {
        const intent = gestures.up(event, canvas.clientHeight, controls.rotateSpeed,
            state.ready && !disposed && !document.hidden && controls.enabled)
        if (!intent || !model || !ref.interactions) return
        if (intent === 'dizzy') {
            const animation = ref.animations.find(item => item.id === ref.interactions!.dizzyAnimation)
            if (animation) void play(animation)
        } else if (hitsModel(model, camera, canvas, event)) {
            let candidates = ref.animations.filter(item => ref.interactions!.clickAnimations.includes(item.id))
            if (candidates.length > 1) candidates = candidates.filter(item => item.id !== state.activeAnimation)
            const animation = candidates[Math.floor(Math.random() * candidates.length)]
            if (animation) void play(animation)
        }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    controls.addEventListener('change', render)
    canvas.addEventListener('keydown', keydown)
    canvas.addEventListener('pointerdown', pointerdown)
    canvas.addEventListener('pointermove', pointermove)
    canvas.addEventListener('pointerup', pointerup)
    canvas.addEventListener('pointercancel', pointerup)
    document.addEventListener('visibilitychange', visibility)
    const onFinished = () => { finished = true }

    async function play(animation: AnimationRef) {
        if (!model || disposed) return
        stop()
        const token = generation
        const abort = new AbortController()
        animationAbort = abort
        state.error = ''
        state.loading = true
        notify()
        try {
            if (!ref.animations.includes(animation)) throw new Error('Animation is not in this model catalogue')
            let clip = clips.get(animation.sha256)
            if (!clip) {
                const source = await loadGLB(animation, abort.signal)
                try { clip = await bindAnimation(model, source, animation, true) }
                finally { disposeGLTF(source) }
                if (disposed || abort.signal.aborted || token !== generation) return
                clips.set(animation.sha256, clip)
            }
            if (disposed || abort.signal.aborted || token !== generation) return
            if (Math.abs(clip.duration - animation.duration) > 1e-4) throw new Error('Animation duration mismatch')
            animationAbort = undefined
            state.loading = false
            state.playing = true
            state.activeAnimation = animation.id
            activeClip = clip
            mixer!.clipAction(clip).reset().setLoop(THREE.LoopOnce, 1).play()
            mixer!.update(0)
            applyEvents()
            additional?.place()
            notify()
            render()
            resume()
        } catch (error) {
            if (disposed || abort.signal.aborted || token !== generation) return
            stop()
            state.error = error instanceof Error ? error.message : String(error)
            notify()
            render()
        }
    }

    function dispose() {
        if (disposed) return
        disposed = true
        stop()
        modelAbort.abort()
        additional?.dispose()
        effects?.dispose()
        effects = undefined
        eyes = undefined
        gestures.clear(true)
        observer.disconnect()
        controls.removeEventListener('change', render)
        controls.dispose()
        canvas.removeEventListener('keydown', keydown)
        canvas.removeEventListener('pointerdown', pointerdown)
        canvas.removeEventListener('pointermove', pointermove)
        canvas.removeEventListener('pointerup', pointerup)
        canvas.removeEventListener('pointercancel', pointerup)
        document.removeEventListener('visibilitychange', visibility)
        mixer?.removeEventListener('finished', onFinished)
        if (model) { mixer?.uncacheRoot(model.scene); disposeGLTF(model); scene.remove(model.scene); model = undefined }
        materialClock = undefined
        clips.clear()
        rest = []
        renderer.dispose()
        renderer.forceContextLoss()
        canvas.remove()
    }
    function snapshot() {
        return {
            ...state, disposed, cachedAnimations: clips.size,
            ...(additional ? { additional: additional.snapshot() } : {}),
            ...(materialClock?.active ? { nativeMaterial: materialClock.snapshot() } : {}),
            ...(eyes ? {eyes: eyes.snapshot()} : {}),
            ...(effects ? {effects: effects.snapshot()} : {}),
            spins: gestures.spins,
            polar: controls.getPolarAngle(), azimuth: controls.getAzimuthalAngle(), distance: controls.getDistance(),
            position: camera.position.toArray(), target: controls.target.toArray(),
            atRest: rest.every(item => item.object.position.distanceTo(item.position) < 1e-7
                && 1 - Math.abs(item.object.quaternion.dot(item.quaternion)) < 1e-7
                && item.object.scale.distanceTo(item.scale) < 1e-7),
        }
    }
    resize()
    notify()
    const ready = (async () => {
        let preparing: GLTF | undefined
        try {
            const loaded = await loadGLB(ref, modelAbort.signal)
            if (disposed) { disposeGLTF(loaded); return }
            preparing = loaded
            const nativeEyes = await prepareNativeEyes(loaded, modelAbort.signal)
            const nativeEffects = await createNativeEmitters(loaded, scene, camera)
            if (disposed || modelAbort.signal.aborted) { nativeEffects.dispose(); return }
            model = loaded
            preparing = undefined
            eyes = nativeEyes
            effects = nativeEffects
            if (rigMetadata(model).key !== ref.rigKey) throw new Error('Model rig identity mismatch')
            if (model.animations.length) throw new Error('Static model unexpectedly contains animations')
            applyNativeDepth(model)
            materialClock = nativeUVClock(model)
            scene.add(model.scene)
            rest = [...jointObjects(model).values()].map(object => ({
                object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(),
            }))
            mixer = new THREE.AnimationMixer(model.scene)
            mixer.addEventListener('finished', onFinished)
            if (ref.additionalActor) {
                additional = await loadAdditionalActor(ref.additionalActor, model, modelAbort.signal,
                    () => { if (state.ready) { resume(); render() } },
                    error => {
                        if (disposed) return
                        stop()
                        state.error = error instanceof Error ? error.message : String(error)
                        notify()
                        render()
                    })
                if (disposed) { additional.dispose(); return }
                scene.add(additional.group)
            }
            const box = visibleBounds(model.scene)
            if (additional) box.union(visibleBounds(additional.group))
            const center = box.getCenter(new THREE.Vector3())
            const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, .001)
            const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * Math.min(1, camera.aspect))
            const distance = radius / Math.sin(halfFov) * 1.12
            controls.target.copy(center)
            camera.position.copy(center).add(new THREE.Vector3(.75, .35, 1.2).normalize().multiplyScalar(distance))
            camera.near = radius / 1000
            camera.far = radius * 1000
            camera.updateProjectionMatrix()
            controls.minDistance = radius * .5
            controls.maxDistance = radius * 12
            controls.update()
            initial = {position: camera.position.clone(), target: center.clone(), polar: controls.getPolarAngle()}
            controls.minPolarAngle = controls.maxPolarAngle = initial.polar
            state.ready = true
            state.loading = false
            notify()
            render()
            resume()
        } catch (error) {
            additional?.dispose()
            effects?.dispose()
            effects = undefined
            eyes = undefined
            materialClock = undefined
            mixer?.removeEventListener('finished', onFinished)
            if (model) { mixer?.uncacheRoot(model.scene); disposeGLTF(model); scene.remove(model.scene); model = undefined }
            if (disposed || modelAbort.signal.aborted) return
            state.loading = false
            state.error = error instanceof Error ? error.message : String(error)
            notify()
        } finally {
            if (preparing) disposeGLTF(preparing)
        }
    })()
    return {ready, play, reset, setFree, dispose, snapshot}
}
