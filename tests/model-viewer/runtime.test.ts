import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as THREE from 'three'

// Execute the actual runtime and attachment bodies with real Three.js math and
// AnimationMixer. Only browser, asset I/O and metadata boundaries are replaced;
// this is a lifecycle test, not a WebGL or native-format validation test.
function sourceModule(filename: string, imports: Record<string, unknown>) {
    const url = new URL(`../../src/components/model-viewer/${filename}`, import.meta.url)
    const source = ts.createSourceFile(filename, readFileSync(url, 'utf8'), ts.ScriptTarget.ES2022, true)
    const body = ts.factory.updateSourceFile(source, source.statements.filter(statement => !ts.isImportDeclaration(statement)))
    const code = ts.transpileModule(ts.createPrinter().printFile(body), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const exports: Record<string, any> = {}
    runInNewContext(code, { exports, AbortController, console, Math, ...imports }, { filename })
    return exports
}

function model(name: string) {
    const scene = new THREE.Group()
    const bone = new THREE.Bone()
    bone.name = `${name}-root`
    scene.add(bone, new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))
    return { name, scene, bone, scenes: [scene], animations: [] }
}

function fixture(mode: 'normal' | 'pending-child' | 'failed-child-animation' = 'normal') {
    const parent = model('parent')
    const child = model('child')
    parent.bone.position.set(1, 4, 2)
    const disposed: string[] = []
    const frames = new Map<number, FrameRequestCallback>()
    const listeners = new Map<string, () => void>()
    const changes: any[] = []
    const renders: { parent: number[], childMatrix?: number[] }[] = []
    let frameId = 0
    let childRequested = false
    let childAborted = false
    const document = {
        hidden: false,
        addEventListener(name: string, listener: () => void) { listeners.set(name, listener) },
        removeEventListener(name: string) { listeners.delete(name) },
    }
    const canvas = { tabIndex: 0, addEventListener() {}, removeEventListener() {}, remove() {} }
    class Renderer {
        domElement = canvas
        setPixelRatio() {}
        setSize() {}
        render() {
            renders.push({ parent: parent.bone.position.toArray(), childMatrix: child.scene.parent?.matrix.toArray() })
        }
        dispose() {}
        forceContextLoss() {}
    }
    class Controls extends THREE.EventDispatcher {
        target = new THREE.Vector3()
        touches = {}
        constructor(private camera: THREE.PerspectiveCamera) { super() }
        update() {}
        dispose() {}
        getPolarAngle() { return 1 }
        getAzimuthalAngle() { return 0 }
        getDistance() { return this.camera.position.distanceTo(this.target) }
    }
    const animation = { id: 'move', name: 'Move', duration: 1, sha256: 'parent-animation' }
    const childAnimation = { id: 'idle', name: 'Idle', duration: 1, sha256: 'child-animation' }
    const childRef = { rigKey: 'child-rig', animations: [childAnimation] }
    const ref = {
        rigKey: 'parent-rig', animations: [animation],
        additionalActor: {
            model: childRef, parentRoot: 0, controller: 'native-first-then-random-v1',
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1],
        },
    }
    async function loadGLB(asset: unknown, signal: AbortSignal) {
        signal.throwIfAborted()
        if (asset === ref) return parent
        if (asset === childRef) {
            childRequested = true
            if (mode === 'pending-child') {
                return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
                    childAborted = true
                    reject(signal.reason)
                }, { once: true }))
            }
            return child
        }
        if (asset === childAnimation && mode === 'failed-child-animation') throw new Error('Child animation unavailable')
        return { name: asset === animation ? 'parent-animation' : 'child-animation' }
    }
    const injected = {
        THREE: { ...THREE, WebGLRenderer: Renderer },
        loadGLB,
        disposeGLTF(value: { name: string }) { disposed.push(value.name) },
        rigMetadata(value: unknown) { return { key: value === parent ? ref.rigKey : childRef.rigKey, jointNodes: [1] } },
        jointObjects(value: typeof parent) { return new Map([[1, value.bone]]) },
        checkAdditionalActor() {},
        applyNativeDepth() {},
        nativeUVClock() { return { active: false, update() {}, snapshot() { return undefined } } },
        async bindAnimation(value: typeof parent) {
            const track = new THREE.VectorKeyframeTrack(`${value.bone.uuid}.position`, [0, 1],
                value === parent ? [3, 9, 5, 3, 9, 5] : [0, 0, 0, 1, 0, 0], THREE.InterpolateLinear)
            return new THREE.AnimationClip(value === parent ? 'Move' : 'Idle', 1, [track])
        },
    }
    const additional = sourceModule('additional.ts', injected)
    const runtime = sourceModule('runtime.ts', {
        ...injected, ...additional, OrbitControls: Controls, document, devicePixelRatio: 1,
        ResizeObserver: class { observe() {} disconnect() {} },
        requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++frameId, callback); return frameId },
        cancelAnimationFrame(id: number) { frames.delete(id) },
    })
    const viewer = runtime.mountViewer({ clientWidth: 400, clientHeight: 300, appendChild() {} }, ref,
        (state: unknown) => changes.push(state))
    return {
        viewer, parent, child, animation, disposed, frames, changes, renders, listeners,
        childRequested: () => childRequested,
        childAborted: () => childAborted,
        tick(time: number) {
            assert.equal(frames.size, 1, 'the viewer must own exactly one animation frame')
            const [id, callback] = frames.entries().next().value!
            frames.delete(id)
            callback(time)
        },
        hidden(value: boolean) { document.hidden = value; listeners.get('visibilitychange')!() },
        close() {
            viewer.dispose()
            for (const value of [parent, child]) value.scene.traverse(object => {
                if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose() }
            })
        },
    }
}

test('parent frame zero moves the additional actor before the first render, following only root X/Z', async () => {
    const f = fixture()
    try {
        await f.viewer.ready
        assert.equal(f.viewer.snapshot().ready, true)
        assert.equal(f.viewer.snapshot().additional.matrix[12], 10)
        await f.viewer.play(f.animation)
        assert.deepEqual(f.parent.bone.position.toArray(), [3, 9, 5])
        // Rest root [1,4,2] -> frame zero [3,9,5], so the child's translation
        // changes by [2,0,3] immediately, without waiting for the next RAF.
        assert.deepEqual(f.renders.at(-1)!.childMatrix!.slice(12, 15), [12, 0, 3])
        f.tick(100)
        assert.deepEqual(f.renders.at(-1)!.childMatrix!.slice(12, 15), [12, 0, 3])
    } finally { f.close() }
    assert.equal(f.frames.size, 0)
})

test('disposing during a child model request aborts it and releases the parent exactly once', async () => {
    const f = fixture('pending-child')
    try {
        for (let attempts = 0; attempts < 100 && !f.childRequested(); attempts++) await Promise.resolve()
        assert.equal(f.childRequested(), true, 'the asynchronous child request must have started')
        f.viewer.dispose()
        await f.viewer.ready
        assert.equal(f.childAborted(), true)
        assert.equal(f.disposed.filter(name => name === 'parent').length, 1)
        assert.equal(f.changes.some(state => state.ready), false)
        assert.equal(f.frames.size, 0)
        assert.equal(f.listeners.size, 0)
    } finally { f.close() }
    assert.equal(f.disposed.filter(name => name === 'parent').length, 1)
})

test('hidden viewers pause the independent child clock and resume without elapsed wall time', async () => {
    const f = fixture()
    try {
        await f.viewer.ready
        f.tick(100)
        f.tick(200)
        assert.ok(Math.abs(f.child.bone.position.x - .1) < 1e-7)
        f.hidden(true)
        assert.equal(f.frames.size, 0)
        f.hidden(false)
        f.tick(5000)
        assert.ok(Math.abs(f.child.bone.position.x - .1) < 1e-7)
        f.tick(5100)
        assert.ok(Math.abs(f.child.bone.position.x - .2) < 1e-7)
        assert.equal(f.viewer.snapshot().playing, false, 'the parent can remain static while its child animates')
    } finally { f.close() }
    assert.equal(f.frames.size, 0)
    assert.equal(f.disposed.filter(name => name === 'parent').length, 1)
    assert.equal(f.disposed.filter(name => name === 'child').length, 1)
})

test('a failed initial child animation releases both models and never publishes a partial ready scene', async () => {
    const f = fixture('failed-child-animation')
    try {
        await f.viewer.ready
        assert.match(f.viewer.snapshot().error, /Child animation unavailable/)
        assert.equal(f.changes.some(state => state.ready), false)
        assert.equal(f.frames.size, 0)
        assert.equal(f.disposed.filter(name => name === 'parent').length, 1)
        assert.equal(f.disposed.filter(name => name === 'child').length, 1)
    } finally { f.close() }
    assert.equal(f.disposed.filter(name => name === 'parent').length, 1)
    assert.equal(f.disposed.filter(name => name === 'child').length, 1)
})
