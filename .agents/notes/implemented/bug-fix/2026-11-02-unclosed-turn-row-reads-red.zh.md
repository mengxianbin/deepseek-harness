# Agent Note: 未闭合轮次的行不重开 Session 即读红

Status: implemented

[English](2026-11-02-unclosed-turn-row-reads-red.md) | 中文

## Problem

Host 重启后，被进程留在半途的会话在有人打开之前一直显示静默行、甚至残留的绿色行。`lastTurnOutcome` 只折叠已提交的 `turn/end` 事件，而关闭这种轮次的 `interrupted` 收尾事件只在会话被 resume 时才写入，因此只读 header 的列表路径永远产不出它。本机 2026-11-02 22:29 对 1401 条已存投影记录的实测：`turnBoundary.openTurnStartSeq` 仍被置位的 12 个冷会话中，7 个折叠出 `lastTurnOutcome = null`、行面完全没有点，1 个折叠出崩溃前的 `completed`、显示绿点，只有 4 个（其上一轮也曾被打断）显示红点。逐个打开这些会话会写入收尾事件并转为红点，正是这一点让缺陷看起来像逐行的手工活。

## Decision

`turnBoundary` 以 `wire` 注册，因而进入 `summaryKeys()`、随每一行列表下发。它的 `stateVersion` 保持 2，而存量行本就写的是 2，所以没有任何行被判失配、不会排程冷重折，部署后的第一次列表拉取就能直接供出这个事实。`UiSession.publishStatus` 推导 `diedMidTurn = openTurnStartSeq != null && running === false` 并并入 `durableFailed`——与 `interrupted` 收尾事件走的是同一条链，于是行首红点、已阅勾标与队列优先级继续共用一套词汇。

这一对判据是精确的而非启发式的。Host 只在 `wakeDriver` 发布 running 转变之后才追加 `turn/start`，而 `kick` 在 phase 回到 idle 之前就已追加 `turn/end`，所以只要会话挂着活的 Agent，它在自己轮次敞开期间始终报告 running；冷行则由 `summarizeCold` 报告 `running: false`。于是一个未闭合轮次出现在未运行的会话上，就意味着没有任何东西会再去关闭它。fork 种子到不了这个状态，因为 `buildForkSeed` 会用 `forked` 原因关闭其继承来的轮次。

## Alternatives considered

**把 `interruptedTurnClosers` 折进冷重折。** `repairColdRow` 经 `SessionHandle.read` 读取已存日志，若在 `coldSnapshot` 前用合成收尾事件配平它，`lastTurnOutcome` 就能直接产出 `interrupted`。但合成收尾事件的 seq 超出已存日志末尾，检查点会认领日志尚未接受的事件——这正是该函数自身 JSDoc 写明的不变量，也是写路径 flush 所保护的顺序。崩溃留下的撕裂尾随后被写路径补写回来时，会落在检查点已认领的 seq 上，下一次折叠将跳过这些真实事件。因一条数据丢失路径而否决，不是因为工作量。

**扩展 `lastTurnOutcome` 使其能表达未闭合轮次，并把 `stateVersion` 升到 2→3。** 折叠将保持单一事实源，行首红点、安康盾与未来的 nudge 都只读同一个 key。但升版会让每一条存量行同时失效，列表将在串行修复泵逐条读日志重折之前，把全部 1191 条都按空白下发——等于在部署当天支付本改动要消除的那次大面积熄灭。否决理由是部署窗口，不是设计本身。

**用 `agentAvailable` 而非 `running` 作闸。** Host 的列表行带这个字段，但客户端的 `SessionSummary` 不带：`lineage` 在构造 `SessionListEntry` 时把它剥掉了，而为表达一个 `running` 已经证明的事实去加宽线上契约并不值。因冗余而否决。

## Consequences

- 末轮未闭合的冷会话在部署后的第一次列表拉取即读红，无重折、无空白窗口；打开它仍会写入真实收尾事件，已携带的标记保持不变。
- 每一行列表多出四个小字段，`turnBoundary` 也会在每次轮次与步骤边界变化时发布一个控制帧。控制流本就承载每步变化的单元，因此这里增加的是量，不是一种新流量。
- 运行中判定依赖 `agent-loop` 里的一处顺序。若 `turn/start` 改为在发布 running 转变之前追加，活会话会在开轮瞬间闪红；本改动没有任何其他环节会捕捉到这一点。
- 安康盾仍只读 `lastTurnOutcome`、且只扫挂着活 Agent 的会话，因此被打断的冷会话由行首红点计入、不被盾计入。两者口径一致（都把 `interrupted` 与未闭合轮次当作同一种停止结局），但统计的集合并不相同。
- [`ui-session.client.spec.ts`](../../../../packages/client/ui-session/tests/ui-session.client.spec.ts) 覆盖未闭合轮次的红点、它压过的崩溃前绿值，以及运行中闸门。[`session-projections.host.spec.ts`](../../../../packages/api/session-controller/tests/session-projections.host.spec.ts) 现在只按它断言的 key 计数，无关单元的帧无法再挤掉它的断言帧。
- 自动 nudge 若须判定「这个会话是否中途停了」，在 Host 侧读 `turnBoundary.openTurnStartSeq` 加 `running` 即可，两者都已无需打开会话即可获得。
