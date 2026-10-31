/** Scoped tool that declares filesystem deliveries in their owning Session. */
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PresentedFile } from './types.ts'

/** Stable Loader identity. */
export const name = 'tool-present'
/** Per-call delivery limit. */
export interface Config {
  /** Maximum number of files in one call. */
  maxFiles: number
}

/** Validated delivery limit. */
export const Config: z<Config> = z.object({
  maxFiles: z.number().default(8),
})

/** Services used by the scoped delivery tool. */
export const inject = ['tools', 'fs', 'agents', 'workingDirectory']

/**
 * Register present with durable file references in its tool result.
 * @param ctx - agent-scoped services.
 * @param config - maximum files per call.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.maxFiles) || config.maxFiles < 1) {
    throw new Error('present requires a positive integer maxFiles')
  }
  const pending = new WeakMap<ToolExecution, { session: Session; turn: number; files: PresentedFile[] }>()
  ctx.tools.register(defineTool({
    name: 'present',
    description: 'Declare existing files as final deliverables for the user. '
      + 'Hosts may show presented files only after your turn ends, so call it once the files are final. '
      + 'If the user needs to review files earlier, such as before a tool call that waits for their answer, link them in your message instead. '
      + 'Use it when the user needs a separate file, especially Office documents, spreadsheets, and slide decks; '
      + 'prefer your final response when that suffices. The user opens the current files; their contents are not copied.',
    parameters: {
      files: {
        type: 'array', required: true,
        // 4 is the recommended per-call count; `maxFiles` is the enforced ceiling above it.
        description: 'Usually the 1-2 most important deliverables; at most 4 per call.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Path of an existing regular file. Relative paths use the Session working directory.' },
            description: { type: 'string', description: 'Brief description for the user.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          turn: { type: 'integer', required: true },
          files: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.files.map(file => `Presented ${file.path}`).join('\n') }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('present requires an agent Session')
      const boundary = ctx.agents.turnBoundaryOf(exec.agent.session)
      if (boundary.openTurnStartSeq === null) throw new Error('present requires an open turn')
      if (args.files.length === 0 || args.files.length > config.maxFiles) throw new Error(`present accepts 1 to ${config.maxFiles} files`)
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const options = { cwd, signal: exec.signal }
      const files: PresentedFile[] = []
      for (const file of args.files) {
        if (file.path.trim().length === 0) throw new Error('present requires a non-empty file path')
        const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal)
        if (entry !== undefined && entry.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
        const target = await ctx.fs.resolve(file.path, options)
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new FsError(`Cannot present ${file.path}: file not found. Check the path, create the file if needed, and retry.`, 'FS_NOT_FOUND')
        if (info.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
        files.push({ ...file, path: ctx.fs.processPath(target) })
      }
      exec.signal.throwIfAborted()
      pending.set(exec, { session: exec.agent.session, turn: boundary.lastTurn, files })
      return { turn: boundary.lastTurn, files }
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    const delivery = pending.get(exec)
    pending.delete(exec)
    if (delivery === undefined || result.isError) return
    const { session, turn, files } = delivery
    session.append('deliverables/presented', {
      turn, callId: exec.callId, files,
    })
  })

  // FORK dsh-local (collab-step4b-a, marker: doneReceipt): the done-receipt
  // light layer (collab step2 §二 ①). The Session declares its work 收口 —
  // save done plus the 判据自证 — so the Host lights 待收讫 (绿✓ / 红！) in
  // real time; the board row `[x]` stays the authority layer (②). The event
  // rides the transcript, so restarts never drift the light.
  const receiptPending = new WeakMap<ToolExecution, {
    session: Session
    turn: number
    verdict: 'pass' | 'exception'
    summary: string
    evidence: readonly string[] | undefined
  }>()
  ctx.tools.register(defineTool({
    name: 'receipt',
    description: 'Declare this Session\'s task done: the work is saved (landed/committed) and its stated criteria proved themselves. '
      + 'Call it once at close-out, after the save commit succeeds, with a one-line self-certification (what landed + how it proved itself, e.g. commit hash and gate results). '
      + 'The verdict marks whether AI pre-verification passed (`pass`) or an acceptance exception needs a human ruling (`exception`). '
      + 'This is the real-time 待收讫 light; the task-board row checkbox remains the authoritative record.',
    parameters: {
      verdict: {
        type: 'string', required: true,
        description: 'AI pre-verification result: "pass" (初验通过) or "exception" (验收例外, a human must rule).',
        enum: ['pass', 'exception'] as const,
      },
      summary: {
        type: 'string', required: true,
        description: 'One-line 判据自证: what landed and how it proved itself (e.g. "commit 1a2b3c4; build exit 0; vitest 1706 passed").',
      },
      evidence: {
        type: 'array',
        description: 'Structured evidence anchors (commit hashes, gate names); shown on hover.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          turn: { type: 'integer' },
          verdict: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.verdict === 'pass'
          ? `Receipt recorded: 待收讫·通过 — ${value.summary}`
          : `Receipt recorded: 待收讫·例外 (needs your ruling) — ${value.summary}`,
      }],
    },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('receipt requires an agent Session')
      const boundary = ctx.agents.turnBoundaryOf(exec.agent.session)
      if (boundary.openTurnStartSeq === null) throw new Error('receipt requires an open turn')
      receiptPending.set(exec, {
        session: exec.agent.session,
        turn: boundary.lastTurn,
        verdict: args.verdict,
        summary: args.summary,
        evidence: args.evidence,
      })
      return Promise.resolve({ turn: boundary.lastTurn, verdict: args.verdict, summary: args.summary })
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    const receipt = receiptPending.get(exec)
    receiptPending.delete(exec)
    if (receipt === undefined || result.isError) return
    receipt.session.append('deliverables/receipt', {
      turn: receipt.turn,
      callId: exec.callId,
      verdict: receipt.verdict,
      summary: receipt.summary,
      ...(receipt.evidence === undefined || receipt.evidence.length === 0
        ? {}
        : { evidence: [...receipt.evidence] }),
    })
  })
}
