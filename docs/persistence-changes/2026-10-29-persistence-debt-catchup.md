---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-29-persistence-debt-catchup

English | [中文](2026-10-29-persistence-debt-catchup.zh.md)

## Summary

Acknowledges six pending persistence transitions in one batch: the new ignorable agent/claim-deferred event, the merge-extensible tool-degradation message-source kind reaching user, developer, inbox/spliced, and title-request messages, and the optional stop-entry field on the user cancellation reason of turn/end.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-29-persistence-debt-catchup
baseline: false
changes:
  - root: "event:agent/claim-deferred"
    previous: null
    after: "e7ba40f596c1c7ac5b71b6771bbbff94ff6aa15b707b428e6a9ae4eb23a288af"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "881b52a84f5e13a8ff3703758598ad7e6983cb1be39ee91ee3999f32242b97b5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "ab19fe7c704c018e8eecf88e0b2a28a955cc5305cc8ce3aa889e02d240097824"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "e0b6cd7032482775aad7db3938d76ff82d4ad0e68985afbe7c436078d61ddd28"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "646fdf2b4a68177bcfd78cdd68e0a70dd74bcdabfa5665967639a7467b92ffc8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "7d522e4456b1f60bdb8aeeeb9b0f85fda07bcdb330653501a0749bf8dd1bda80"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Agent/claim-deferred is a new ordinary event whose envelope carries ignorable: true, so readers that know the skip-safe marker keep it opaque without touching surface state instead of failing; existing logs never contain it, and adding an ordinary event is an established same-version case. The tool-degradation source kind only widens the merge-extensible MessageSourceMap union: the literal-kind diff on user/message, developer/message, agent/inbox/spliced, and session/title-llm-request shows exactly that one added literal with no removals and no policy change, every existing kind keeps its schema, unknown producer kinds and their metadata survive decoding, adoption, and message derivation, and consumers fall through unknown kinds by contract, so an older reader keeps the notice row through its message content alone while older logs simply never contain the kind. turn/end gains an optional entry on the user cancellation reason: old records omit it and current readers keep the byte-identical {kind:'user'} shape, while older readers address reason fields by name, see the unchanged kind, and never read the extra optional field, which carries no decision semantics. SESSION_FORMAT_VERSION stays at 4; all six roots record decision: same-version.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent/tests/degradation-notice.spec.ts packages/core/agent-loop/tests/deferred-claim.spec.ts packages/core/agent-loop/tests/cancel.spec.ts packages/session/session-title/tests/persistence.spec.ts packages/session/session-format-v3-to-v4/tests/attribution.spec.ts: 5 files, 65 tests passed — covering degradation-notice production, the ignorable claim-deferred recovery record, the turn/end entry round trip beside the pre-entry shape, title-request persistence, and unknown-attribution preservation through codec, adoption, and derivation. Catalog regeneration (gen-persistence-catalog) exits 0, and the old/new schema inventories were diffed per root: exactly one added literal per affected source root, entry plus its four variants on turn/end, no removals.

<a id="dev-note"></a>
## Dev Note

None.
