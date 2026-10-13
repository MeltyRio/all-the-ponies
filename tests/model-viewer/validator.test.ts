import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const json = JSON.stringify({ asset: { version: '2.0' } })
const padded = json.padEnd(Math.ceil(json.length / 4) * 4, ' ')
const bytes = Buffer.alloc(20 + padded.length)
bytes.writeUInt32LE(0x46546c67, 0)
bytes.writeUInt32LE(2, 4)
bytes.writeUInt32LE(bytes.length, 8)
bytes.writeUInt32LE(padded.length, 12)
bytes.writeUInt32LE(0x4e4f534a, 16)
bytes.write(padded, 20)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const ref = { path: `models/3d/${sha256}.glb`, sha256, bytes: bytes.length,
    rigKey: 'a'.repeat(64), animations: [] }

function validate(models: Record<string, unknown>) {
    const root = mkdtempSync(path.join(tmpdir(), 'atp-validator-'))
    try {
        mkdirSync(path.join(root, 'models/3d'), { recursive: true })
        writeFileSync(path.join(root, ref.path), bytes)
        writeFileSync(path.join(root, 'models_3d.json'), JSON.stringify({ schemaVersion: 1, models }))
        return spawnSync(process.execPath, [fileURLToPath(new URL('./validate.mjs', import.meta.url)), root],
            { encoding: 'utf8' })
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

test('GLB validator checks shared resources once when references agree', () => {
    const result = validate({ Pony_First: ref, Pony_Second: ref })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).length, 1)
})

for (const field of ['bytes', 'rigKey'] as const) {
    for (const conflictingFirst of [true, false]) {
        test(`GLB validator rejects conflicting ${field}, conflicting reference first: ${conflictingFirst}`, () => {
            const conflicting = { ...ref, [field]: field === 'bytes' ? bytes.length + 1 : 'b'.repeat(64) }
            const result = validate(conflictingFirst
                ? { Pony_First: conflicting, Pony_Second: ref }
                : { Pony_First: ref, Pony_Second: conflicting })
            assert.notEqual(result.status, 0)
            assert.match(result.stderr, /Conflicting resource reference/)
        })
    }
}
