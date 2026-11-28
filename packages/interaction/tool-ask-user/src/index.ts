/**
 * Model-facing Consumer of the `ctx.userQuestions` capability seam.
 * The tool pauses until a UI provider returns a human answer, then feeds that
 * answer back into the agent loop as an ordinary tool result.
 *
 * @module @deepseek-ai/dsh-tool-ask-user
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { registerTimedAskUser, skippedAnswerGuidance } from './timed.ts'
import '@deepseek-ai/dsh-user-questions'

/** Cordis row selecting the tool schema and its default foreground wait. */
export interface Config {
  /** Tool definition selected by this Cordis row. Defaults to the blocking legacy tool. */
  mode?: 'legacy' | 'timed'
  /** Foreground wait before automatic continuation. Defaults to 120 seconds. */
  timeout?: number
}

export const Config: z<Config> = z.object({
  mode: z.union(['legacy', 'timed']).default('legacy'),
  timeout: z.union([-1, z.number().step(1).min(1).max(2_147_483)]).default(120),
})

export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']

const description = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + skippedAnswerGuidance
  // FORK dsh-local (ask-panel-retire-1127 刀②): the option-card presentation is
  // retired for intent-less questions — the answer surface shows a one-line
  // hint, so brevity matters even more; kept identical to the timed description.
  + ' Keep every question field brief — the answer surface shows a one-line hint; '
  + 'put long reports in a file and reference its path instead. '
  // FORK dsh-local (ask-long-stem, 2026-11-17 裁定 D): the stem must fit one
  // line of the card, and background belongs to the conversation before the
  // call — kept identical in the timed description below.
  + 'The question field itself must fit on one line — at most 36 CJK characters (or 72 half-width units). '
  + 'Put background or long context into a regular conversation message sent before calling this tool, not into the question. '
  // FORK dsh-local (ask-panel-retire-1127 刀②): pending state is structural —
  // a decision that only lives in conversation prose never reads as pending;
  // kept identical in the timed description below.
  + 'Any pending decision the user must rule on (a decision brief, a confirmation) must be asked through this tool: '
  + 'the pending state is read structurally from this registration, never from conversation prose.'
  // FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 D): kept
  // identical to the timed description below — the card-level remark rides
  // the result as a top-level `note`.
  + ' The answer may also carry a top-level note: a card-level remark the user typed that belongs to no single question.'

export function apply(ctx: Context, config: Config = {}): void {
  if (config.mode === 'timed') {
    registerTimedAskUser(ctx, config.timeout)
    return
  }
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
          // FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 D): kept
          // identical to the timed schema's note below.
          note: {
            type: 'string',
            description: 'Optional card-level remark the user typed outside any single question; omitted when none was given.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const result = await ctx.userQuestions.ask({
        questions: args.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header !== undefined ? { header: question.header } : {},
          ...question.options !== undefined ? { options: question.options } : {},
          ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
        })),
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        signal: exec.signal,
      })
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
        ...result.note !== undefined ? { note: result.note } : {},
      }
    },
  }))
}
