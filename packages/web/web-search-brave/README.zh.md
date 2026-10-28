---
description: "面向 ctx.web 的 Brave 搜索提供方：部署如何装配密钥逐次经凭据服务解析的 Brave 原生网页搜索。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-brave`，harness 通过 Brave Search API 搜索 web，获得 Brave 原生结果，附带纯文本摘要片段与提供方计算的日期。当部署持有 Brave Search API 令牌时选择它：密钥每次搜索时解析——配置字面量、凭据服务引用 `apiKeyEnv`、或启动环境——换 key 免重启，下次搜索即生效。Brave 不返回生成式答案，因此结果只有可引用来源。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与搁置工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `brave` 搜索提供方身份注册，当它是唯一可用的搜索后端时 `ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: brave` 显式钉住。

### 何时选择它

当部署持有 Brave Search API 令牌、希望使用 Brave 索引与逐条描述片段和页面日期时选择此后端。当任何凭据来源都解析不到 key、端点基址无法解析、或 `count` 超出 1–20 时，提供方不可用——每次搜索调用都以结构化错误失败。

### 最小配置

加载 web 服务与提供方；所有设置均有安全默认值，密钥不需要写进配置文件。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brave'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Brave 令牌；建议改用 `apiKeyEnv`，避免密钥进入配置文件 |
| `apiKeyEnv` | `BRAVE_API_KEY` | 凭据引用，每次搜索经凭据服务解析（网页搜索设置页可写入），无凭据服务时回退到启动环境 |
| `baseURL` | `https://api.search.brave.com/res` | 端点基址；追加 `/v1/web/search`。无法解析的值使提供方不可用 |
| `count` | `10` | 每次搜索请求的结果条数，1–20 的整数；请求侧更小的上限胜出 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-brave)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每条 Brave 条目映射为一个 `WebSearchSource`：`url`、`title`、`description` 作为 `snippet`、ISO 的 `page_age` 作为 `publishedAt`；缺少 URL 的条目被丢弃，空白可选字段被省略，人类可读的 `age` 散文串绝不映射进 `publishedAt`。请求用 `result_filter=web` 只要网页结果块，并以 `text_decorations=false` 要求无装饰文本，因此片段以纯文本到达。配置的 `count` 与请求的 `maxResults` 取更小者；最终截断由服务在返回途中施加。Brave 不返回生成式答案，因此结果不携带 `content`。

### 失败与恢复

提供方失败以 `WebError` `WEB_PROVIDER_ERROR` 浮出：HTTP 错误携带状态行与提供方详情，另有网络失败、无法识别或无法处理的响应体。密钥缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 浮出，点名凭据引用及可供给它的三个来源。被中止的请求以 `WEB_ABORTED` 浮出。HTTP 重定向在联系 `Location` 目标之前即被拒绝，订阅令牌绝不会重放到其他主机。调用方按错误码路由；面向模型的 `web_search` 工具在自己的错误包装下向模型呈现失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节解释提供方背后的设计决策；可观测行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计哲学

本提供方是 Brave Web Search API 之上的薄适配器，带三条刻意的规则：

- **只认 ISO 日期。** `page_age` 是 Brave 的 ISO 日期时间；`age` 散文串会违反 seam 的 `publishedAt` 约定，因此绝不映射——错误的时间戳比没有更糟。
- **每次搜索一份设置快照。** 凭据、端点与条数在每次搜索入口读取一次，一次搜索绝不混用两个设置节的内容。
- **不编造答案。** Brave 不返回生成式答案，因此省略 `content`，而不是伪造模型可能信任的提供方行文。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：volatile 配置 schema、逐次凭据解析、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `BraveSearchProvider`：请求派发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Brave 线上类型：响应信封、结果条目、错误信封 |

### 请求与映射流程

`search()` 解析 key（字面量 → 凭据服务 → 启动环境），取配置 `count` 与请求 `maxResults` 中更小者，发出 `GET {baseURL}/v1/web/search?q&count&result_filter=web&text_decorations=false`，携带 `x-subscription-token` 且 `redirect: 'error'`，因此重定向在不联系目标、不重放令牌的情况下使请求失败。解析出的 `web.results[]` 逐条映射、丢弃无 URL 条目，最终 `maxResults` 上限由服务在返回途中施加。已中止的信号或名为 `AbortError` 的 `DOMException` 成为 `WEB_ABORTED`；其余成为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当包级约定不够用时阅读这些页面。它们从共享词汇走到服务、面向模型的工具与设计依据。

- [Web 子系统](../../../docs/subsystems/web.zh.md)——穷尽的搜索请求/结果词汇与错误码。
- [web 包映射](../README.zh.md)——七包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-brave)——每个受支持配置字段及其源声明。
- [Web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——为什么搜索与抓取共享同一个提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地通过 `dsh-tool-web`：它在消费者错误包装下保留本提供方受 `maxResults` 上限约束的 URL、标题、描述片段与页面日期，或保留其精确的 `Brave search aborted`、`Brave search request failed: <error>`、`Brave returned an unprocessable response body: <error>`、`Brave web search has no API key for "<ref>"` 失败。

#### KV 缓存影响

无直接失效；由被命名的消费者拥有其请求前缀变更。

## 已知限制与搁置工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了何时不适合使用本提供方。它们是当前的包约束。

- **`count` 不得超过 20** —— Brave Web Search API 每次查询至多接受 20 条结果（2026-10-20 核实），更大的请求上限会被配置值压回。
- **仅暴露 `apiKey`/`apiKeyEnv`/`baseURL`/`count`** —— Brave 的其他控制（freshness、国家、搜索语言、safesearch、goggles、非网页结果块、summarizer）等待 provider-neutral 服务字段（[seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **没有 `web` 块的响应是空结果而非错误** —— 调用方无法区分「无匹配」与「被过滤的响应」。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与未定方向。它明确不具备权威性——已发布的行为、限制与依据见上文各节与链接的 Agent Note。

#### 未来：更宽的 Brave 控制面

Brave 的 freshness、国家/语言、safesearch、goggles、非网页块与 summarizer 轮询仍未暴露。暴露它们需要先有 provider-neutral 服务字段，这样家族一次增加一个协调控制，而不是一个厂商专属参数。把 `exa` 与 `perplexity` 纳入设置页需要这两个插件各自先长出自己的 settings namespace。

</details>
