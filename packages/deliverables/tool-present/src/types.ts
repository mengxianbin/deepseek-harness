/** Durable file deliveries produced by the present tool. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** A declared filesystem file whose current contents remain at its source path. */
export interface PresentedFile {
  /** Original absolute path or path relative to the Session working directory. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
}

/**
 * The 验章 attribute of a done receipt (collab step2 §二, step3 §3.1): `pass`
 * is AI初验通过 (待收讫·通过), `exception` is an acceptance exception the human
 * must rule on (待收讫·例外).
 */
export type ReceiptVerdict = 'pass' | 'exception'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Declared filesystem files from a successful final present result, including nested calls. */
    'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[] }
    /**
     * The structured done receipt (collab step2 §二 亮灯层): the Session
     * declares its work收口 — save done plus the 判据自证 in `summary` — so the
     * Host can light 待收讫 in real time. The board row `[x]` stays the
     * authority layer (②); this event is the light (①), superseded by the
     * next turn's start and never drifted by restarts (the transcript is the
     * single durable source).
     */
    'deliverables/receipt': {
      turn: number
      callId: ToolCallId
      verdict: ReceiptVerdict
      /** One-line 判据自证: what landed and how it proved itself (e.g. commit hash + gate results). */
      summary: string
      /** Structured evidence anchors (commit hashes, gate names); the light layer carries them for hover. */
      evidence?: string[]
    }
  }
}
