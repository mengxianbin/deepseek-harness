---
description: "宿主审计日志助手：向进程 stdout 直写一条带本地时间前缀的访问、resume 或 profile patch 行，让 dsh-web.log 留下可取证痕迹。"
kind: "package-library"
---

# @deepseek-ai/dsh-audit-line

[English](README.md) | 中文

## Summary

`dsh-audit-line` 为每个宿主审计动作向进程 stdout 追加一条带时间戳的行，启动器重定向捕获后即 `dsh-web.log`。宿主 webserver、session-controller 与 config-editor 都引入 `auditLine()`，使访问、会话 resume 与 profile patch 记录共享同一 `[yyyy-MM-dd HH:mm:ss]` 本地时间前缀。库本身无状态、不拥有记录词表：由调用方格式化行体（`access …`、`resumed session …`、`patch written …`）并传入一行文本。它直写 stdout，因为随附 profile 未挂载 logger console exporter，经 `ctx.logger` 发出的行永远到不了日志文件。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

凡是宿主侧审计事实需要在启动器捕获的日志里留存，就用这个助手：webserver 请求出口的 `access` 行、session-controller 在 `ctx.agents.resume` 成功后的 `resumed session` 行、config-editor 在 profile patch 提交后的 `patch written` 行。本来经 `ctx.logger` 走的记录继续走 `ctx.logger`；本包只为轮转日志必须留存的 stdout 审计行而生。

### Entry point

```ts
import { auditLine } from '@deepseek-ai/dsh-audit-line'

auditLine('access GET /api/probe 401 127.0.0.1 3')
```

成功即进程 stdout 流上的一行——`[2026-11-04 18:09:59] access GET /api/probe 401 127.0.0.1 3`——由启动器重定向捕获进 `dsh-web.log`；没有失败模式、返回值或抛错。消息内换行会被折叠为空格，一次调用恒产出恰好一行。精确细节见 [`src/index.ts`](src/index.ts) 中的契约。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内幕 — 点击展开</summary>

`auditTimestamp` 把本地墙钟渲染为零填充的 `yyyy-MM-dd HH:mm:ss`，与启动器日志自身的前缀一致，事故时间线可互相对时。`auditLine` 给前缀加方括号、归一化内嵌换行，再经 `process.stdout.write` 追加 `message` 与换行；无缓冲、无批量。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 时间戳渲染与单行 stdout 写入 |
| [`tests/audit-line.spec.ts`](tests/audit-line.spec.ts) | 前缀格式、单行保证与带括号输出 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [工具包索引](../README.zh.md) — 共享原语。
- [Webserver 路由注册](../../host/webserver/src/index.ts) — `access` 行的生产调用点。

-----

<a id="model-experience"></a>
## Model Experience

None, as this journal helper appends Host log lines that no request assembles into model context.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅限启动器捕获的 stdout** — 只有启动器重定向宿主 stdout 时该行才留在 `dsh-web.log`；未被重定向的进程只把行打到自己的控制台，无轮转的退出即丢失。
- **记录词表归调用方** — 助手无法阻止调用方漏掉时间戳或错排字段；行形由各调用点的测试各自钉死。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

随 N1/N2+N3 审计缺口批引入，让访问、resume 与 profile patch 写入共享同一种 stdout 日志行格式。

</details>
