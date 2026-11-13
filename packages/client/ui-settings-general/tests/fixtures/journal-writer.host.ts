/**
 * Journal fan-out fixture (test-only CLI): append N lines through the REAL
 * seq-protocol sink so the parent spec can prove gapless monotonic seq across
 * genuinely concurrent processes. Never imported by production code — it is
 * spawned by `tests/auto-build-journal.spec.ts` through tsx.
 *
 * Usage: tsx journal-writer.ts <repositoryRoot> <writer> <count>
 */
import { defaultAutoBuildJournalLine } from '../../src/auto-build-journal.ts'

const [, , root, writer, countRaw] = process.argv
if (root === undefined || writer === undefined || countRaw === undefined) {
  process.stderr.write('usage: journal-writer.ts <repositoryRoot> <writer> <count>\n')
  process.exit(2)
}
const count = Number.parseInt(countRaw, 10)
if (!Number.isInteger(count) || count < 1) {
  process.stderr.write(`invalid count: ${countRaw}\n`)
  process.exit(2)
}

const sink = defaultAutoBuildJournalLine(root, { writer, fallbackPath: `${root}/journal-writer-fallback.log` })
for (let index = 0; index < count; index += 1) {
  sink(`${writer} line ${String(index)}`)
}
await sink.flush()
