import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveModel, verifiedBytes, disposeGLTF, loadGLB } from '../../src/components/model-viewer/assets.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const signal = () => new AbortController().signal
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const bytes = Buffer.from('binary fixture')
const ref = { path: `models/3d/${hash(bytes)}.glb`, sha256: hash(bytes), bytes: bytes.length, rigKey: 'a'.repeat(64) }
const model = { ...ref, animations: [{ ...ref, id: 'move', name: 'Move', duration: 1e-9 }] }

test('CDN assets use ATP resolver and verify binary size and digest', async () => {
    globalThis.fetch = async (input, options) => {
        assert.equal(String(input), `https://assets.all-the-ponies.com/${ref.path}`)
        assert.equal(options.credentials, 'omit')
        assert.equal(options.redirect, 'error')
        return new Response(bytes)
    }
    assert.deepEqual(Buffer.from(await verifiedBytes(ref, signal())), bytes)
})

test('semantic catalogue survives uploader JSON formatting and uses uploaded manifest version', async () => {
    // Python's uploader also changes exponent spelling; these two JSON payloads
    // have the same data but different raw hashes, intentionally not compared.
    const source = JSON.stringify({ schemaVersion: 1, models: { Pony_Test: model } }) + '\n'
    const uploaded = source.replace('1e-9', '1e-09').trim()
    assert.notEqual(hash(source), hash(uploaded))
    const requests: URL[] = []
    globalThis.fetch = async input => {
        const url = new URL(String(input)); requests.push(url)
        return new Response(url.pathname === '/manifest.json'
            ? JSON.stringify({ 'models_3d.json': hash(uploaded) }) : uploaded)
    }
    assert.deepEqual(await resolveModel('Pony_Test', signal()), model)
    assert.equal(requests[1].origin, 'https://assets.all-the-ponies.com')
    assert.equal(requests[1].pathname, '/models_3d.json')
    assert.equal(requests[1].searchParams.get('v'), hash(uploaded))
})

test('old ATP manifest without optional 3D data makes no catalogue request', async () => {
    let requests = 0
    globalThis.fetch = async () => { requests++; return Response.json({}) }
    assert.equal(await resolveModel('Pony_Test', signal()), null)
    assert.equal(requests, 1)
})

test('unknown identities do not substitute a model', async () => {
    globalThis.fetch = async input => new Response(String(input).includes('manifest.json')
        ? JSON.stringify({ 'models_3d.json': 'b'.repeat(64) })
        : JSON.stringify({ schemaVersion: 1, models: { Pony_Test: model } }))
    assert.equal(await resolveModel('Pony_Missing', signal()), null)
    assert.equal(await resolveModel('toString', signal()), null)
})

test('absolute and traversing resource keys reject before any fetch', async () => {
    globalThis.fetch = async () => { throw new Error('Unexpected fetch') }
    for (const path of ['https://elsewhere.invalid/a.glb', '//elsewhere.invalid/a.glb', '../private.glb', 'models/3d/%2e%2e/private.glb']) {
        await assert.rejects(verifiedBytes({ ...ref, path }, signal()), /resource path/)
    }
})

test('changed binary bytes at the same key and wrong size cannot be silently accepted', async () => {
    globalThis.fetch = async () => new Response(Buffer.alloc(bytes.length, 1))
    await assert.rejects(verifiedBytes(ref, signal()), /digest mismatch/)
    globalThis.fetch = async () => new Response('short')
    await assert.rejects(verifiedBytes(ref, signal()), /size mismatch/)
})

test('malformed data, mismatched rigs and duplicate action IDs reject', async () => {
    for (const value of [
        { schemaVersion: 99, models: {} },
        { schemaVersion: 1, models: { Pony_Test: { ...model, animations: [{ ...model.animations[0], rigKey: 'c'.repeat(64) }] } } },
        { schemaVersion: 1, models: { Pony_Test: { ...model, animations: [model.animations[0], model.animations[0]] } } },
    ]) {
        globalThis.fetch = async input => Response.json(String(input).includes('manifest.json')
            ? { 'models_3d.json': 'b'.repeat(64) } : value)
        await assert.rejects(resolveModel('Pony_Test', signal()))
    }
})

test('aborted requests do not start or publish a result', async () => {
    const abort = new AbortController(); abort.abort()
    globalThis.fetch = async () => { throw new Error('Unexpected fetch') }
    await assert.rejects(resolveModel('Pony_Test', abort.signal), { name: 'AbortError' })
    await assert.rejects(verifiedBytes(ref, abort.signal), { name: 'AbortError' })
    const late = new AbortController()
    globalThis.fetch = async () => { late.abort(); return new Response(bytes) }
    await assert.rejects(verifiedBytes(ref, late.signal), { name: 'AbortError' })
})

test('embedded profile rejects external image URIs before invoking GLTFLoader', async () => {
    let json = JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'https://elsewhere.invalid/private.png' }] })
    json = json.padEnd(Math.ceil(json.length / 4) * 4, ' ')
    const glb = Buffer.alloc(20 + json.length)
    glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
    glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); glb.write(json, 20)
    const sha256 = hash(glb)
    globalThis.fetch = async () => new Response(glb)
    await assert.rejects(loadGLB({ ...ref, path: `models/3d/${sha256}.glb`, sha256, bytes: glb.length }, signal()), /External GLB/)
})

test('shared GPU objects and image bitmaps are each released once across scenes', () => {
    const counts = { geometry: 0, skeleton: 0, material: 0, texture: 0, bitmap: 0 }
    const texture = { isTexture: true, source: { data: { close() { counts.bitmap++ } } }, dispose() { counts.texture++ } }
    const object = {
        geometry: { dispose() { counts.geometry++ } }, skeleton: { dispose() { counts.skeleton++ } },
        material: [{ map: texture, dispose() { counts.material++ } }],
    }
    disposeGLTF({ scenes: [0, 1].map(() => ({ traverse(fn) { fn(object) } })) } as any)
    assert.deepEqual(counts, { geometry: 1, skeleton: 1, material: 1, texture: 1, bitmap: 1 })
})
