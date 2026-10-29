---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-29-persistence-debt-catchup

[English](2026-10-29-persistence-debt-catchup.md) | 中文

## 概述

一次性补录六项待认领的持久化类型变更：新的 ignorable 事件 agent/claim-deferred、可合并扩展的 tool-degradation 消息来源 kind（进入 user、developer、inbox/spliced 与标题请求消息），以及 turn/end 中用户取消原因上的可选停止入口字段 entry。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

agent/claim-deferred 是新增的普通事件，信封带 ignorable: true：认识该跳过安全标记的读者将其当作不透明记录保留、不触碰 surface 状态而不是失败；既有日志中根本不存在该事件，且「新增普通事件」本身是既定的 same-version 案例。tool-degradation 来源 kind 只是拓宽了可合并扩展的 MessageSourceMap 并集：user/message、developer/message、agent/inbox/spliced、session/title-llm-request 的字面量 diff 显示恰好只新增这一个字面量、零移除、policy 零变化，既有 kind 的 schema 全部不变；未知生产者的 kind 及其元数据按契约经解码、采纳、消息推导全程保留，消费方对未知 kind 直接回落，因此旧读者仅凭消息内容即可呈现该 notice 行，而更旧的日志从未包含该 kind。turn/end 在用户取消原因上新增可选 entry：旧记录缺省该字段且当前读者保持逐字节一致的 {kind:'user'} 形态，旧读者按字段名读取原因、看到不变的 kind、从不读取这个额外可选字段（该字段不承载任何决策语义）。SESSION_FORMAT_VERSION 保持 4；六个根全部记录 decision: same-version。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent/tests/degradation-notice.spec.ts packages/core/agent-loop/tests/deferred-claim.spec.ts packages/core/agent-loop/tests/cancel.spec.ts packages/session/session-title/tests/persistence.spec.ts packages/session/session-format-v3-to-v4/tests/attribution.spec.ts：5 个文件、65 个用例全部通过——覆盖退化 notice 生产、ignorable claim-deferred 恢复记录、turn/end entry 与旧形态并列的往返、标题请求持久化、未知来源归因经编解码/采纳/推导的保留。catalog 再生（gen-persistence-catalog）exit 0，且新旧 schema 清单已逐根 diff：受影响来源根各自恰好一个新增字面量、turn/end 为 entry 及其四个变体、零移除。

<a id="dev-note"></a>
## 开发备注

无。
