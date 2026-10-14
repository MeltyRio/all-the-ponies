import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModel } from '../../src/components/model-viewer/assets'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const asset = (key: string, rig: string) => ({ path: `models/3d/${key.repeat(64)}.glb`, sha256: key.repeat(64), bytes: 100, rigKey: rig.repeat(64) })
const actor = (key: string, rig: string) => ({ ...asset(key, rig), animations: [{ ...asset('b', rig), id: 'first', name: 'first', duration: 1 }] })
const additional = () => ({ model: actor('c', 'd'), parentRoot: 2, controller: 'native-first-then-random-v1',
    transform: [2,0,0,0, 0,2,0,0, 0,0,2,0, 3,4,5,1] })
async function resolve(schemaVersion: number, child: unknown) {
    const model = { ...actor('a', 'a'), additionalActor: child }
    globalThis.fetch = async input => Response.json(String(input).includes('manifest.json')
        ? { 'models_3d.json': 'f'.repeat(64) } : { schemaVersion, models: { Pony_Test: model } })
    return resolveModel('Pony_Test', new AbortController().signal)
}

test('schema 2 resolves independent child rigs and a native scene transform', async () => {
    assert.deepEqual((await resolve(2, additional()))?.additionalActor, additional())
})

test('schema 3 preserves the same independent child contract', async () => {
    const row = await resolve(3, additional())
    assert.deepEqual(row.additionalActor, additional())
})

test('schema 1 cannot silently omit a child; null and nested children reject', async () => {
    await assert.rejects(resolve(1, additional()), /version 2/)
    await assert.rejects(resolve(1, null), /version 2/)
    await assert.rejects(resolve(2, null), /controller/)
    await assert.rejects(resolve(2, { ...additional(), model: { ...additional().model, additionalActor: null } }), /Nested/)
})

test('child controller and complete playable animation sequence are required', async () => {
    for (const child of [
        { ...additional(), controller: 'guess' },
        { ...additional(), parentRoot: -1 },
        { ...additional(), parentRoot: .5 },
        { ...additional(), parentRoot: Number.MAX_SAFE_INTEGER + 1 },
        { ...additional(), model: { ...additional().model, animations: [] } },
        { ...additional(), model: { ...additional().model, animations: [{ ...additional().model.animations[0], duration: 0 }] } },
        { ...additional(), model: { ...additional().model, animations: [{ ...additional().model.animations[0], rigKey: 'a'.repeat(64) }] } },
    ]) await assert.rejects(resolve(2, child))
})

test('perspective, reflected, sheared, collapsed and nonuniform child matrices reject', async () => {
    for (const [index, value] of [[0,-2], [0,0], [0,3], [1,.5], [3,.1], [15,2], [12,Infinity]]) {
        const child = additional(); child.transform[index] = value
        await assert.rejects(resolve(2, child))
    }
})


test('anonymous additional model keeps its flat key while its animations use native names', async () => {
    const child = additional()
    const animation = child.model.animations[0]
    animation.path = `models/3d/${animation.sha256}/${animation.id}.glb`
    assert.deepEqual((await resolve(2, child))?.additionalActor, child)
    child.model.path = `models/3d/${child.model.sha256}/Invented_ID.glb`
    await assert.rejects(resolve(2, child), /additional actor model path/)
})
