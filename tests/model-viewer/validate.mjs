import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import validator from 'gltf-validator'

const root = path.resolve(process.argv[2] || 'tests/model-viewer/generated')
const catalogue = JSON.parse(await fs.readFile(path.join(root, 'models_3d.json'), 'utf8'))
const references = new Map()
function record(ref, name, allowFixedModel = false) {
    const legacy = ref.path === `models/3d/${ref.sha256}.glb`
    const named = typeof name === 'string' && name.length > 0 && !/[^A-Za-z0-9_-]/.test(name)
        && ref.path === `models/3d/${ref.sha256}/${name}.glb`
    const fixed = allowFixedModel && typeof name === 'string' && name.length > 0 && !/[^A-Za-z0-9_-]/.test(name)
        && ref.path === `models/3d/${name}.glb`
    if (!/^[a-f0-9]{64}$/.test(ref.sha256) || (!legacy && !named && !fixed)) throw new Error('Invalid resource key')
    const previous = references.get(ref.path)
    if (previous && ['sha256', 'bytes', 'rigKey'].some(field => previous[field] !== ref[field])) {
        throw new Error(`Conflicting resource reference: ${ref.path}`)
    }
    references.set(ref.path, ref)
}
for (const [identity, model] of Object.entries(catalogue.models)) {
    record(model, identity, true)
    for (const animation of model.animations) record(animation, animation.id)
    if (model.additionalActor) {
        record(model.additionalActor.model, undefined)
        for (const animation of model.additionalActor.model.animations) record(animation, animation.id)
    }
}
if (!references.size) throw new Error('No model or animation resources to validate')
const results = []
for (const [key, ref] of references) {
    const bytes = await fs.readFile(path.join(root, key))
    if (bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error(`Integrity mismatch: ${key}`)
    const report = await validator.validateBytes(bytes, { uri: key })
    results.push({ path: key, errors: report.issues.numErrors, warnings: report.issues.numWarnings, messages: report.issues.messages })
}
console.log(JSON.stringify(results, null, 2))
if (results.some(result => result.errors || result.warnings)) process.exitCode = 1
