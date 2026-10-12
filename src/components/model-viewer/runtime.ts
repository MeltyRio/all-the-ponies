import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bindAnimation, jointObjects, rigMetadata } from './animation';
import { disposeGLTF, loadGLB, type AnimationRef, type ModelRef } from './assets';

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

function applyNativeDepth(model: GLTF) {
    model.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return
        for (const material of [object.material].flat()) {
            const depth = material.userData.atpNativeDepth
            if (depth === undefined) continue
            if (!depth || typeof depth.write !== 'boolean' || typeof depth.test !== 'boolean') {
                throw new Error('Invalid native depth state')
            }
            material.depthWrite = depth.write
            material.depthTest = depth.test
        }
    })
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
    let mixer: THREE.AnimationMixer | undefined
    let rest: {object: THREE.Object3D, position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3}[] = []
    let initial: {position: THREE.Vector3, target: THREE.Vector3, polar: number} | undefined
    let frameId = 0
    let lastTime: number | undefined
    let generation = 0
    let finished = false
    const modelAbort = new AbortController()
    let animationAbort: AbortController | undefined
    const clips = new Map<string, THREE.AnimationClip>()
    const notify = () => changed({...state})
    const render = () => { if (!disposed && model) renderer.render(scene, camera) }

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
    }
    function stop() {
        generation++
        animationAbort?.abort()
        animationAbort = undefined
        cancelFrame()
        mixer?.stopAllAction()
        restore()
        state.playing = false
        state.loading = !state.ready
        state.activeAnimation = ''
        finished = false
    }
    function frame(time: number) {
        frameId = 0
        if (disposed || document.hidden || !state.playing) return
        const delta = lastTime === undefined ? 0 : Math.min((time - lastTime) / 1000, .1)
        lastTime = time
        mixer!.update(delta)
        // Restore after mixer.update has applied its bindings, not from inside
        // the mixer's finished event, where it is still updating this frame.
        if (finished) {
            stop()
            notify()
        }
        render()
        resume()
    }
    function resume() {
        if (!disposed && !document.hidden && state.playing && !frameId) frameId = requestAnimationFrame(frame)
    }
    function visibility() {
        if (document.hidden) cancelFrame()
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
        state.error = ''
        resetCamera()
        notify()
    }
    function setFree(free: boolean) {
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
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    controls.addEventListener('change', render)
    canvas.addEventListener('keydown', keydown)
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
                try { clip = await bindAnimation(model, source, animation) }
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
            mixer!.clipAction(clip).reset().setLoop(THREE.LoopOnce, 1).play()
            mixer!.update(0)
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
        observer.disconnect()
        controls.removeEventListener('change', render)
        controls.dispose()
        canvas.removeEventListener('keydown', keydown)
        document.removeEventListener('visibilitychange', visibility)
        mixer?.removeEventListener('finished', onFinished)
        if (model) { mixer?.uncacheRoot(model.scene); disposeGLTF(model) }
        clips.clear()
        rest = []
        renderer.dispose()
        renderer.forceContextLoss()
        canvas.remove()
    }
    function snapshot() {
        return {
            ...state, disposed, cachedAnimations: clips.size,
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
        try {
            const loaded = await loadGLB(ref, modelAbort.signal)
            if (disposed) { disposeGLTF(loaded); return }
            model = loaded
            if (rigMetadata(model).key !== ref.rigKey) throw new Error('Model rig identity mismatch')
            if (model.animations.length) throw new Error('Static model unexpectedly contains animations')
            applyNativeDepth(model)
            scene.add(model.scene)
            rest = [...jointObjects(model).values()].map(object => ({
                object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(),
            }))
            mixer = new THREE.AnimationMixer(model.scene)
            mixer.addEventListener('finished', onFinished)
            const box = visibleBounds(model.scene)
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
        } catch (error) {
            if (model) { disposeGLTF(model); scene.remove(model.scene); model = undefined }
            if (disposed || modelAbort.signal.aborted) return
            state.loading = false
            state.error = error instanceof Error ? error.message : String(error)
            notify()
        }
    })()
    return {ready, play, reset, setFree, dispose, snapshot}
}
