// Test/demo infrastructure only: production still uses ATP's asset resolver.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../../', import.meta.url))
const generated = path.resolve(process.env.MODEL_VIEWER_ASSETS || path.join(root, 'tests/model-viewer/generated'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export async function startDemo(port = 5195) {
    const raw = await fs.readFile(path.join(generated, 'models_3d.json'))
    // As with ATP's uploader, JSON may be serialized again. Catalogue identity
    // comes from the final manifest; only immutable binary resources use SHA.
    const catalogue = Buffer.from(JSON.stringify(JSON.parse(raw)))
    const manifest = Buffer.from(JSON.stringify({ 'models_3d.json': digest(catalogue) }))
    const requests = []
    const assets = http.createServer(async (request, response) => {
        const key = new URL(request.url, 'http://localhost').pathname.slice(1)
        requests.push(key)
        response.setHeader('Access-Control-Allow-Origin', '*')
        response.setHeader('Cache-Control', 'no-cache')
        try {
            if (key === 'manifest.json' || key === 'models_3d.json') {
                response.setHeader('Content-Type', 'application/json')
                response.end(key === 'manifest.json' ? manifest : catalogue)
            } else if (/^models\/3d\/[a-f0-9]{64}\.glb$/.test(key)) {
                response.setHeader('Content-Type', 'model/gltf-binary')
                response.end(await fs.readFile(path.join(generated, key)))
            } else {
                response.writeHead(404).end()
            }
        } catch {
            response.writeHead(404).end()
        }
    })
    await new Promise((resolve, reject) => {
        assets.once('error', reject)
        assets.listen(0, '127.0.0.1', resolve)
    })
    const assetOrigin = `http://127.0.0.1:${assets.address().port}`
    let vite
    try {
        vite = await createServer({
            root, configFile: false, publicDir: path.join(root, 'public'),
            resolve: { alias: { '@': path.join(root, 'src') } },
            optimizeDeps: { include: ['vue', 'vue-i18n', 'vike-vue/usePageContext', 'vike-vue/ClientOnly', 'three', 'three/addons/loaders/GLTFLoader.js', 'three/addons/controls/OrbitControls.js'] },
            plugins: [vue(), {
                name: 'model-viewer-test-cdn',
                enforce: 'pre',
                configureServer(server) {
                    server.middlewares.use(async (request, response, next) => {
                        if (new URL(request.url, 'http://localhost').pathname !== '/') return next()
                        const source = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>ATP 3D synthetic demo</title></head><body><div id="app"></div><script type="module" src="/tests/model-viewer/demo.ts"></script></body></html>'
                        response.setHeader('Content-Type', 'text/html')
                        response.end(await server.transformIndexHtml(request.url, source))
                    })
                },
                resolveId(source, importer) {
                    if (source === '../../scripts/assets' && importer?.split('?')[0].endsWith('/model-viewer/assets.ts')) {
                        return '\0model-viewer-test-assets'
                    }
                },
                load(id) {
                    if (id === '\0model-viewer-test-assets') {
                        return `export const createAssetUrl = key => new URL(key, ${JSON.stringify(assetOrigin + '/')}).href`
                    }
                },
            }],
            server: { host: '127.0.0.1', port, strictPort: true },
        })
        await vite.listen()
    } catch (error) {
        await vite?.close()
        await new Promise(resolve => assets.close(resolve))
        throw error
    }
    return {
        vite, assetOrigin, requests,
        url: `http://127.0.0.1:${port}`,
        async close() {
            await vite.close()
            await new Promise(resolve => assets.close(resolve))
        },
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const server = await startDemo(Number(process.env.MODEL_VIEWER_PORT || 5195))
    console.log(`Self-authored RK → GLB demo: ${server.url}`)
    console.log('Model/animation assets are served by a separate local CORS-enabled origin.')
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, async () => { await server.close(); process.exit(0) })
}
