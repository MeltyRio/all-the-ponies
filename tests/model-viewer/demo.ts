import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { setPageContext } from 'vike-vue/usePageContext'
import type { PageContext } from 'vike/types'
import messages from '../../src/locales/en.json'
import ModelViewerLauncher from '../../src/components/model-viewer/ModelViewerLauncher.vue'
import '../../src/assets/css/main.css'

const parameters = new URLSearchParams(location.search)
const identity = parameters.get('identity') || 'Synthetic_Flag'
const title = identity === 'Synthetic_Flag' ? 'Self-authored animated flag' : identity
const app = createApp({
    render: () => h('main', { style: 'max-width:52rem;margin:4rem auto;padding:1rem' }, [
        h('h1', 'ATP 3D converter and viewer demo'),
        h('p', 'This flag is generated from self-authored RK and ANIM data. No game assets are included.'),
        // ObjectPage sets each right-buttons slot child to this size.
        h(ModelViewerLauncher, { identity, name: title, style: 'width:3rem;height:3rem' }),
    ]),
})
app.use(createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: { en: messages } }))
// Supply the client flags consumed by ATP's existing ClientOnly dialog. The
// production route obtains this context from Vike, not from this demo harness.
setPageContext(app, { isClientSide: true, isHydration: false } as PageContext)
app.mount('#app')

// A test-only entry for exercising the public runtime controller. The ordinary
// demo above uses exactly the production Vue components, without debug globals.
if (parameters.has('runtime')) {
    const { mountViewer } = await import('../../src/components/model-viewer/runtime')
    const { resolveModel } = await import('../../src/components/model-viewer/assets')
    const model = await resolveModel(identity, new AbortController().signal)
    if (!model) throw new Error('Generate the synthetic fixture before running the demo')
    const host = document.createElement('div')
    host.id = 'runtime-host'
    host.style.cssText = 'width:480px;height:480px;max-width:90vw;margin:1rem auto;background:#f0f4f8'
    document.body.append(host)
    const controller = mountViewer(host, model, () => {})
    Object.assign(window, { viewerTest: { controller, model, app } })
}
