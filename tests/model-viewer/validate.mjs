import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import validator from 'gltf-validator'

const root = path.resolve(process.argv[2] || 'tests/model-viewer/generated')
const catalogue = JSON.parse(await fs.readFile(path.join(root, 'models_3d.json'), 'utf8'))
const references = new Map()
for (const model of Object.values(catalogue.models)) {
    for (const ref of [model, ...model.animations]) references.set(ref.path, ref)
}
if (!references.size) throw new Error('No model or animation resources to validate')
const results = []
for (const [key, ref] of references) {
    if (key !== `models/3d/${ref.sha256}.glb`) throw new Error('Invalid resource key')
    const bytes = await fs.readFile(path.join(root, key))
    if (bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error(`Integrity mismatch: ${key}`)
    const report = await validator.validateBytes(bytes, { uri: key })
    results.push({ path: key, errors: report.issues.numErrors, warnings: report.issues.numWarnings, messages: report.issues.messages })
}
console.log(JSON.stringify(results, null, 2))
if (results.some(result => result.errors || result.warnings)) process.exitCode = 1
