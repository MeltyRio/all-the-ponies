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
        assert.equal(options.cache, 'default')
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


test('fixed Object ID models revalidate while native named animations remain shared and cached', async () => {
    const animation = { ...model.animations[0], path: `models/3d/${ref.sha256}/move.glb` }
    const named = (id: string) => ({ ...ref, path: `models/3d/${id}.glb`, animations: [animation] })
    const catalogue = { schemaVersion: 1, models: { Pony_Test: named('Pony_Test'), Pet_Test: named('Pet_Test') } }
    const fetched: string[] = []
    globalThis.fetch = async (input, options) => {
        const path = new URL(String(input)).pathname.slice(1); fetched.push(path)
        if (path === 'manifest.json') return Response.json({ 'models_3d.json': 'b'.repeat(64) })
        if (path === 'models_3d.json') return Response.json(catalogue)
        assert.ok([catalogue.models.Pony_Test.path, catalogue.models.Pet_Test.path, animation.path].includes(path))
        assert.equal(options.cache, path === animation.path ? 'default' : 'no-cache')
        return new Response(bytes)
    }
    const pony = await resolveModel('Pony_Test', signal())
    const pet = await resolveModel('Pet_Test', signal())
    assert.deepEqual(pony, catalogue.models.Pony_Test)
    assert.deepEqual(pet, catalogue.models.Pet_Test)
    assert.equal(pony!.animations[0].path, pet!.animations[0].path)
    for (const resource of [pony!, pet!, animation]) {
        assert.deepEqual(Buffer.from(await verifiedBytes(resource, signal())), bytes)
    }
    assert.equal(fetched.filter(path => path.endsWith('.glb')).length, 3)
})

test('named catalogue filenames must match the object or animation identity', async () => {
    for (const resource of [
        { ...model, path: 'models/3d/Pony_Other.glb' },
        { ...model, path: `models/3d/${ref.sha256}/Pony_Other.glb` },
        { ...model, animations: [{ ...model.animations[0], path: `models/3d/${ref.sha256}/other.glb` }] },
        { ...model, animations: [{ ...model.animations[0], path: 'models/3d/move.glb' }] },
    ]) {
        globalThis.fetch = async input => {
            const path = new URL(String(input)).pathname
            assert.ok(path === '/manifest.json' || path === '/models_3d.json')
            return Response.json(path === '/manifest.json'
                ? { 'models_3d.json': 'b'.repeat(64) }
                : { schemaVersion: 1, models: { Pony_Test: resource } })
        }
        await assert.rejects(resolveModel('Pony_Test', signal()), /resource path/)
    }
})

test('nested paths reject wrong digest, separators, escapes and empty filenames before fetch', async () => {
    globalThis.fetch = async () => { throw new Error('Unexpected fetch') }
    for (const path of [
        `models/3d/${'c'.repeat(64)}/Pony_Test.glb`,
        ...['', '..', 'a/b', 'a\\b', '%2e%2e', 'Pony_Test?x', 'Pony_Test#x', 'Pony_Test.glb', 'Pony_Test\n']
            .map(name => `models/3d/${ref.sha256}/${name}.glb`),
        `models/3d/${ref.sha256}/Pony_Test.glb\n`,
        ...['', '..', 'a/b', 'a\\b', '%2e%2e', 'Pony_Test?x', 'Pony_Test#x', 'Pony_Test.glb']
            .map(name => `models/3d/${name}.glb`),
        'models/3d/Pony_Test.glb\n',
    ]) await assert.rejects(verifiedBytes({ ...ref, path }, signal()), /resource path/)
})

test('overwritten fixed models reject stale references and load after resolving the new catalogue', async () => {
    const fixed = { ...model, path: 'models/3d/Pony_Test.glb' }
    const newer = Buffer.alloc(bytes.length, 1)
    const updated = { ...fixed, sha256: hash(newer) }
    let current = fixed
    globalThis.fetch = async (input, options) => {
        const path = new URL(String(input)).pathname
        if (path === '/manifest.json') return Response.json({ 'models_3d.json': 'b'.repeat(64) })
        if (path === '/models_3d.json') return Response.json({ schemaVersion: 1, models: { Pony_Test: current } })
        assert.equal(path, '/models/3d/Pony_Test.glb')
        assert.equal(options.cache, 'no-cache')
        return new Response(newer)
    }
    const previous = await resolveModel('Pony_Test', signal())
    await assert.rejects(verifiedBytes(previous!, signal()), /digest mismatch/)
    current = updated
    const latest = await resolveModel('Pony_Test', signal())
    assert.equal(latest!.path, previous!.path)
    assert.deepEqual(Buffer.from(await verifiedBytes(latest!, signal())), newer)
})

test('old flat keys and two named revisions remain independently verifiable', async () => {
    const newer = Buffer.from('changed binary fixture')
    const previous = { ...ref, path: `models/3d/${ref.sha256}/Pony_Test.glb` }
    const next = { ...previous, sha256: hash(newer), path: `models/3d/${hash(newer)}/Pony_Test.glb`, bytes: newer.length }
    const storage = new Map([[ref.path, bytes], [previous.path, bytes], [next.path, newer]])
    globalThis.fetch = async input => {
        const found = storage.get(new URL(String(input)).pathname.slice(1))
        assert.ok(found)
        return new Response(found)
    }
    assert.deepEqual(Buffer.from(await verifiedBytes(next, signal())), newer)
    assert.deepEqual(Buffer.from(await verifiedBytes(previous, signal())), bytes)
    assert.deepEqual(Buffer.from(await verifiedBytes(ref, signal())), bytes)
})

test('catalogue v3 explicitly enables only exported native click and dizzy identities', async () => {
    const interactions = {version: 1, clickAnimations: ['move'], dizzyAnimation: 'move'}
    let catalogue: any = {schemaVersion: 3, models: {Pony_Test: {...model, interactions}}}
    globalThis.fetch = async input => Response.json(String(input).includes('manifest.json')
        ? {'models_3d.json': 'b'.repeat(64)} : catalogue)
    assert.deepEqual((await resolveModel('Pony_Test', signal()))!.interactions, interactions)
    for (const invalid of [
        {...interactions, version: 2}, {...interactions, clickAnimations: ['missing']},
        {...interactions, clickAnimations: ['move', 'move']}, {...interactions, dizzyAnimation: 'missing'},
        {...interactions, inventedAction: 'move'},
    ]) {
        catalogue.models.Pony_Test.interactions = invalid
        await assert.rejects(resolveModel('Pony_Test', signal()))
    }
    catalogue.models.Pony_Test.interactions = interactions
    for (const version of [1, 2]) {
        catalogue.schemaVersion = version
        await assert.rejects(resolveModel('Pony_Test', signal()), /Unsupported interaction controller/)
    }
})
