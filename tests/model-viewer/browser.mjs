// Browser regression against a caller-supplied game-data output directory.
// Generated game assets stay outside this repository; no download is performed.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'
import { startDemo } from './server.mjs'

if (!process.env.MODEL_VIEWER_ASSETS) throw new Error('Set MODEL_VIEWER_ASSETS to a game-data dist directory')
const catalogue = JSON.parse(await fs.readFile(path.join(process.env.MODEL_VIEWER_ASSETS, 'models_3d.json'), 'utf8')).models
const identities = Object.keys(catalogue).sort()
const identity = process.env.MODEL_VIEWER_ID || identities.find(id => id.startsWith('Pony_') && catalogue[id].animations.length) || identities.find(id => catalogue[id].animations.length)
if (!identity || !catalogue[identity]?.animations.length) throw new Error('MODEL_VIEWER_ID must identify a generated model with animations')
const animation = [...catalogue[identity].animations].filter(a => a.duration > .3).sort((a, b) => a.duration - b.duration)[0] || catalogue[identity].animations[0]
const extraIds = (process.env.MODEL_VIEWER_EXTRA_IDS || '').split(',').filter(Boolean)
for (const id of extraIds) if (!catalogue[id]) throw new Error(`Requested test identity is not in the catalogue: ${id}`)
const representatives = [...new Set([
    identities.find(id => id.startsWith('Pet_')),
    identities.find(id => !id.startsWith('Pony_') && !id.startsWith('Pet_')),
    identities.find(id => catalogue[id].additionalActor),
    ...extraIds,
].filter(Boolean))].filter(id => id !== identity)
const output = path.resolve(process.env.MODEL_VIEWER_RESULTS || 'tests/model-viewer/generated/browser')
await fs.mkdir(output, { recursive: true })
const passed = [], skipped = [], errors = [], samples = []
const server = await startDemo(Number(process.env.MODEL_VIEWER_PORT || 5196))
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} differs from ${b}`)
const snapshot = page => page.evaluate(() => window.viewerTest.controller.snapshot())
const url = (id, runtime = false) => `${server.url}/?identity=${encodeURIComponent(id)}${runtime ? '&runtime' : ''}`
async function open(page) {
    await page.getByRole('button', { name: 'View 3D model', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Reset view', exact: true })).toBeEnabled()
    await expect(page.locator('canvas')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
}
async function ready(page, id) {
    await page.goto(url(id, true))
    await page.waitForFunction(() => window.viewerTest?.controller.snapshot().ready || window.viewerTest?.controller.snapshot().error)
    assert.equal((await snapshot(page)).error, '')
    assert.equal(await page.evaluate(() => window.viewerTest.model.path), catalogue[id].path)
}
async function drag(page, target, dx, dy) {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 10 })
    await page.mouse.up()
}
const context = await browser.newContext({ viewport: { width: 1000, height: 900 } })
context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
const page = await context.newPage()
try {
    await page.goto(server.url)
    await expect(page.locator('#model-identity option')).toHaveCount(identities.length)
    await page.locator('#model-search').fill(identity)
    const matches = await page.locator('#model-identity option').evaluateAll(options => options.map(option => option.value))
    assert.ok(matches.includes(identity))
    assert.ok(matches.every(id => id.toLowerCase().includes(identity.toLowerCase())))
    await page.locator('#model-identity').selectOption(identity)
    await expect(page.locator('h2')).toHaveText(identity)
    assert.equal(new URL(page.url()).searchParams.get('identity'), identity)
    passed.push('catalogue picker searches actual identities and preserves the selected Object ID in the URL')
    await open(page)
    const clipButton = page.getByRole('button', { name: animation.name, exact: true })
    await expect(clipButton).toBeVisible()
    await clipButton.click()
    await expect(clipButton).toHaveAttribute('aria-pressed', 'true')
    if (animation.duration <= 15) {
        await expect(clipButton).toHaveAttribute('aria-pressed', 'false', { timeout: (animation.duration + 5) * 1000 })
        passed.push('native animation plays once and ends through the production Vue controls')
    } else skipped.push('automatic completion: shortest selected animation exceeds 15 seconds')
    await clipButton.click()
    await expect(clipButton).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Reset view', exact: true }).click()
    await expect(clipButton).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('button', { name: 'Unlock rotation', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Lock rotation', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Lock rotation', exact: true }).click()
    await page.screenshot({ path: path.join(output, 'pony-desktop.png') })
    await page.keyboard.press('Escape')
    await expect(page.locator('canvas')).toHaveCount(0)
    passed.push('real model opens, replays, resets, toggles rotation and closes in the ATP dialog')

    let missing = 'Missing_Model_For_Browser_Check'
    while (catalogue[missing]) missing += '_'
    const beforeMissing = server.requests.length
    await page.goto(url(missing))
    await expect(page.getByRole('alert')).toContainText(missing)
    await expect(page.getByRole('button', { name: 'View 3D model', exact: true })).toHaveCount(0)
    assert.equal(server.requests.slice(beforeMissing).filter(key => key.endsWith('.glb')).length, 0)
    passed.push('an explicit missing identity reports absence without loading a replacement model')

    for (const id of representatives) {
        await page.goto(url(id))
        await expect(page.locator('h2')).toHaveText(id)
        await expect(page.locator('#model-identity')).toHaveValue(id)
        await open(page)
        const clip = catalogue[id].animations.find(a => a.duration > .3) || catalogue[id].animations[0]
        if (clip) {
            await page.getByRole('button', { name: clip.name, exact: true }).click()
            await expect(page.getByRole('button', { name: clip.name, exact: true })).toHaveAttribute('aria-pressed', 'true')
            await page.getByRole('button', { name: 'Reset view', exact: true }).click()
        }
        await page.screenshot({ path: path.join(output, `${id}.png`) })
        await page.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(page.locator('canvas')).toHaveCount(0)
        samples.push({ identity: id, path: catalogue[id].path, animation: clip?.id, additionalActor: Boolean(catalogue[id].additionalActor) })
    }
    passed.push(`opened ${representatives.length} additional catalogue identities with their actual generated assets`)
    if (!representatives.some(id => id.startsWith('Pet_'))) skipped.push('no Pet identity in this catalogue')
    if (!representatives.some(id => !id.startsWith('Pony_') && !id.startsWith('Pet_'))) skipped.push('no non-Pony/Pet identity in this catalogue')

    await ready(page, identity)
    const initial = await snapshot(page)
    await drag(page, page.locator('#runtime-host canvas'), 100, 60)
    const locked = await snapshot(page)
    assert.ok(Math.abs(locked.azimuth - initial.azimuth) > .1)
    near(locked.polar, initial.polar)
    near(locked.distance, initial.distance)
    await page.evaluate(() => window.viewerTest.controller.setFree(true))
    await drag(page, page.locator('#runtime-host canvas'), 30, 60)
    assert.ok(Math.abs((await snapshot(page)).polar - locked.polar) > .05)
    await page.evaluate(() => window.viewerTest.controller.reset())
    near((await snapshot(page)).distance, initial.distance)
    await page.evaluate(() => window.viewerTest.controller.setFree(false))
    assert.equal((await snapshot(page)).free, false)
    passed.push('real runtime horizontal rotation preserves elevation and scale; free rotation and Reset work')
    await page.evaluate(async id => { const { controller, model } = window.viewerTest; await controller.play(model.animations.find(a => a.id === id)) }, animation.id)
    await page.waitForTimeout(Math.min(150, animation.duration * 250))
    assert.equal((await snapshot(page)).playing, true)
    assert.equal((await snapshot(page)).error, '')
    await page.evaluate(() => window.viewerTest.controller.reset())
    assert.equal((await snapshot(page)).atRest, true)
    const cache = (await snapshot(page)).cachedAnimations
    const requests = server.requests.length
    await page.evaluate(async id => { const { controller, model } = window.viewerTest; await controller.play(model.animations.find(a => a.id === id)) }, animation.id)
    assert.equal((await snapshot(page)).cachedAnimations, cache)
    assert.equal(server.requests.length, requests)
    await page.evaluate(() => window.viewerTest.controller.reset())
    passed.push('separate native clip binds, resets to rest and replays from the verified in-memory cache')
    await page.evaluate(async () => { const { controller, model } = window.viewerTest; await controller.play({ ...model.animations[0], rigKey: 'wrong' }) })
    assert.match((await snapshot(page)).error, /not in this model catalogue/)
    await page.evaluate(() => {
        window.viewerTest.gl = document.querySelector('#runtime-host canvas').getContext('webgl2')
        window.viewerTest.controller.dispose()
        window.viewerTest.controller.dispose()
    })
    await expect(page.locator('#runtime-host canvas')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.viewerTest.gl.isContextLost())).toBe(true)
    assert.equal((await snapshot(page)).cachedAnimations, 0)
    passed.push('uncatalogued animation is rejected; repeated disposal releases context, canvas and clip cache')

    let materialCases = 0, additionalCases = 0, depthCases = 0, maskCases = 0
    for (const id of representatives) {
        await ready(page, id)
        const before = await snapshot(page)
        await page.waitForTimeout(250)
        const after = await snapshot(page)
        if (catalogue[id].additionalActor) {
            assert.equal(after.additional.active, true)
            assert.equal(after.additional.currentId, catalogue[id].additionalActor.model.animations[0].id)
            assert.equal(after.additional.matrix.length, 16)
            additionalCases++
        }
        if (before.nativeMaterial) {
            assert.notEqual(after.nativeMaterial.clock, before.nativeMaterial.clock)
            assert.ok(after.nativeMaterial.offsets.every(offset => Math.abs(offset + after.nativeMaterial.clock) < 1e-6))
            materialCases++
        }
        const materials = await page.evaluate(async () => {
            const { loadGLB, disposeGLTF } = await import('/src/components/model-viewer/assets.ts')
            const { applyNativeDepth } = await import('/src/components/model-viewer/native-materials.ts')
            const gltf = await loadGLB(window.viewerTest.model, new AbortController().signal)
            try {
                applyNativeDepth(gltf)
                const materials = new Set()
                gltf.scene.traverse(object => { if (object.isMesh) for (const material of [object.material].flat()) materials.add(material) })
                return [...materials].map(material => ({
                    name: material.name, declaredDepth: material.userData.atpNativeDepth,
                    depthWrite: material.depthWrite, depthTest: material.depthTest, alphaTest: material.alphaTest,
                }))
            } finally { disposeGLTF(gltf) }
        })
        for (const material of materials) {
            if (material.declaredDepth) {
                assert.equal(material.depthWrite, material.declaredDepth.write)
                assert.equal(material.depthTest, material.declaredDepth.test)
                depthCases++
            }
            if (material.alphaTest > 0) maskCases++
        }
        Object.assign(samples.find(sample => sample.identity === id), { runtime: after, materials })
        await page.evaluate(() => window.viewerTest.controller.dispose())
    }
    if (additionalCases) passed.push(`${additionalCases} generated AdditionalObject case(s) load their separate rig and first native animation`)
    else skipped.push('no AdditionalObject identity in the tested catalogue representatives')
    if (materialCases) passed.push(`${materialCases} native material clock case(s) advance while the parent is at rest`)
    else skipped.push('no native material clock in the tested representatives; supply MODEL_VIEWER_EXTRA_IDS to cover it')

    if (depthCases) passed.push(`${depthCases} declared native depth material state(s) match the loaded GLB`)
    else skipped.push('no declared native depth state in the tested representatives')
    if (maskCases) passed.push(`${maskCases} alpha-mask material(s) retained by the GLTF loader`)
    else skipped.push('no alpha-mask material in the tested representatives')

    await ready(page, identity)
    await page.evaluate(async () => {
        const { controller, model } = window.viewerTest
        const clip = model.animations[0], original = clip.rigKey
        clip.rigKey = 'f'.repeat(64)
        try { await controller.play(clip) } finally { clip.rigKey = original }
    })
    assert.match((await snapshot(page)).error, /rig is incompatible/)
    assert.equal((await snapshot(page)).cachedAnimations, 0)
    assert.equal((await snapshot(page)).atRest, true)
    passed.push('downloaded clip with an incompatible declared rig is rejected before playback')
    let release, reached = false
    const blocked = new Promise(resolve => { release = resolve })
    const delayClip = async route => { reached = true; await blocked; await route.continue().catch(() => {}) }
    await page.route(`**/${animation.path}`, delayClip)
    await page.evaluate(id => { const { controller, model } = window.viewerTest; void controller.play(model.animations.find(a => a.id === id)) }, animation.id)
    await expect.poll(() => reached).toBe(true)
    await page.evaluate(() => window.viewerTest.controller.reset())
    release()
    await page.waitForTimeout(250)
    assert.equal((await snapshot(page)).playing, false)
    assert.equal((await snapshot(page)).cachedAnimations, 0)
    assert.equal((await snapshot(page)).atRest, true)
    await page.unroute(`**/${animation.path}`, delayClip)
    passed.push('Reset cancels a pending native clip and ignores its late result')

    await page.goto(url(identity))
    let releaseModel, modelReached = false
    const blockedModel = new Promise(resolve => { releaseModel = resolve })
    const delayModel = async route => { modelReached = true; await blockedModel; await route.continue().catch(() => {}) }
    await page.route(`**/${catalogue[identity].path}`, delayModel)
    await page.getByRole('button', { name: 'View 3D model', exact: true }).click()
    await expect.poll(() => modelReached).toBe(true)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    releaseModel()
    await page.waitForTimeout(250)
    await expect(page.locator('canvas')).toHaveCount(0)
    await expect(page.locator('dialog')).toHaveCount(0)
    await page.unroute(`**/${catalogue[identity].path}`, delayModel)
    passed.push('closing during model download prevents late scene restoration')

    const mobileContext = await browser.newContext({ viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true })
    const mobile = await mobileContext.newPage()
    mobile.on('pageerror', error => errors.push(error.message))
    await mobile.goto(url(identity))
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= 320))
    await open(mobile)
    const dialog = await mobile.locator('dialog').boundingBox()
    assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 320.1)
    await mobile.screenshot({ path: path.join(output, 'pony-mobile.png') })
    await mobile.getByRole('button', { name: 'Close', exact: true }).tap()
    await ready(mobile, identity)
    await mobile.locator('#runtime-host canvas').scrollIntoViewIfNeeded()
    const beforeTouch = await snapshot(mobile)
    const box = await mobile.locator('#runtime-host canvas').boundingBox()
    const cdp = await mobileContext.newCDPSession(mobile)
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + i * 6, y: point.y + i * 2 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const afterTouch = await snapshot(mobile)
    assert.ok(Math.abs(afterTouch.azimuth - beforeTouch.azimuth) > .1)
    near(afterTouch.polar, beforeTouch.polar)
    near(afterTouch.distance, beforeTouch.distance)
    await mobileContext.close()
    passed.push('320px picker and dialog fit; actual touch rotation preserves locked elevation and scale')
    assert.deepEqual(errors, [])
    passed.push('no browser page errors')
} finally {
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ identity, animation: animation.id, passed, skipped, samples, errors, browser: browser.version(), requests: server.requests }, null, 2))
    console.log(JSON.stringify({ passed, skipped, browser: browser.version() }, null, 2))
    await browser.close()
    await server.close()
}
