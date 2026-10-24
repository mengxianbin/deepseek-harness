---
description: "dsh Web 客户端的侧边栏外壳插件：品牌行、New Session 操作、折叠控件、可感知滚动的区域席位与底部固定的 Settings 席位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

dsh Web 客户端的侧边栏让用户识别当前构建、启动新会话、将导航折叠为 56px 轨道、浏览 Workspace 与 Session，以及打开 Settings。它会将 Settings 入口固定在底部，并在隐藏空闲滚动条时避免浏览器行发生位移。New Session 优先使用显式选择的 Workspace，其次使用当前 Session 所属的 Workspace，再其次使用最近活跃的 Workspace；如果都不存在，则打开空白的 New Session 页面。部署可以替换品牌标记或名称，同时保留导航控件和轨道几何。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

侧边栏是导航外壳：用户看到品牌、启动新会话、折叠轨道并到达 Settings。功能插件填充它的席位——ui-workspace 填充 `sidebar.workspaces`，ui-settings 在 `sidebar.settings` 注册触发行与设置面板。

### 品牌与 New Session

展开的品牌行把 `sidebar.brand.mark` 与 `sidebar.brand.name` 渲染为两个独立的 single slot；收起轨道则渲染同一个 mark slot。在 Web 和 Windows 桌面端，点击展开态的品牌会新建会话，悬停或聚焦时不显示 tooltip。没有占位者时，外壳只显示鱼形标记（FORK dsh-local：品牌行的本地构建标签已去掉）。FORK dsh-local（usage glance v2，2026-10-15）：展开态 logo 行**不再有品牌/新建会话按钮**——新建会话走 ⋯ 菜单首位（与 rail 图标），`sidebar.brand.name` 占位者仅有内容时渲染在控件之前，整行由 `UsageGlance` 占据：**每个配额窗口各占一行（FORK usage glance v2.4，2026-10-22，行序 月 → 周 → 5h）**——每行 = 窗口短标签（`glance.window.*.label`，月/周/5h）+ 等长左对齐进度条 + **两列右对齐读数（FORK usage glance v2.4.1，2026-10-22 用户指示拆列：百分比列 `33%`、天数/小时列 `5/31d`，无时间对显 `—`，列宽固定右缘对齐）**：fill 为该窗口用量占比，条上 1px 竖向刻度线为时间进度（连续比例，起点由 `resetsAt` 回推：月 −1 月、周 −7 天、5h −5 小时），用量越过刻度的区段以警示色渲染（`--dsw-alias-state-warn-primary`，消耗快于时间即配速超前）；月/周读数为天数对、5h 为小时对；provider 未报的窗口（或无 percent）整行省略，rolling 无日结构不上屏；三行 12px 行高零间距、连同按钮 padding 恰合 40px（Windows 标题栏 logo 行上限），**其右另起一列是今/周期 token 用量两行（FORK usage glance v2.3，2026-10-22）：`今日 321.7M` 与 `周期 4.21B`，各为「小字标签 + 紧凑数字」一行，标签取 locale（`glance.today.label` / `glance.cycle.label`），数字取 overview 四个不重叠桶之和——周期值按 `pickWindow` 主窗口（month 优先 = 月行同窗；2026-10-22 三窗口拆分后二次裁定维持）对逐日序列求和（2026-10-22 裁定：套餐周期，非日历月；周期起始日整天计入，故重置日带上一周期在当天的残留），序列被 30 天窗口截断时（`availableDays` 证明周期内有键不在序列）以 `≥` 标为下限；原小字数据刷新时间戳（`26.10.15 21:30`，本地时区，即 overview 最近一次成功加载的时刻）移入该列 tooltip**；数据来自 dsh-usage 宿主 overview（`/api/dsh-usage/overview`，标签页可见时每 60s 刷新，宿主半区 404 时整体隐藏），点击后重放用户路径打开设置的使用统计分区。FORK usage glance v3（2026-10-24）：窗口同时携带绝对水位对（`used`/`limit`；宿主 OpenCode Go 取数已切 console `go/status`）时，`used / limit >= 0.85` 即触发扳机——触发行的读数数字转为 state-error 红，周/月行（A 方案切换窗）另将填充整条转红并在 tooltip 追加 `glance.trigger.hint`，5 小时行只红读数，无水位对的窗口（他家 provider、或重启生效前的宿主）绝不触发；读数列按 2026-10-24 裁定保持纯百分比。FORK usage-glance v3.5 / 自动路由（2026-10-25）：窗口行左侧新增**当前生效源状态点**——读取自动路由控制器（`dsh-auto-route`，裁定乙案）策略层状态 `/api/auto-route/status`（同源、同 60s 节拍；404 或无 `policy` 即整体隐藏，随特性同进退；刻意不读 overview 的 `current{provider,model,source}`——那是「最后请求路由」语义，双家混跑会抖），常态为次级灰、策略 triggered（控制器已把活跃会话集切至 MiMo 官方）时转警示色，tooltip 写明源名、相位与最近决策时间；状态点只占宽度，40px 标题栏预算不变。完整构建会显示代码徽标 `version[-commit][-dirty]`；该徽标使用 `DSH_CLIENT_VERSION`、可选的 7 位 `DSH_CLIENT_COMMIT_HASH` 与 `DSH_CLIENT_GIT_DIRTY=true` 组装，缺少版本元数据时不显示徽标。FORK dsh-local（usage glance v2）：徽标与版本读取路径都不复存在于该行——构建元数据查 fork 表，不再上屏。New Session 优先使用作用域操作明确指定的 Workspace，否则使用当前 Session 所属 Workspace，再否则使用最近活跃 Workspace；一个 Workspace 都没有时则清空选择，进入空白 New Session 页面。 展开态的新建会话按钮在悬停或键盘聚焦时于右侧以灰色文字显示当前有效绑定。快捷键可见且空间较窄时，居中的图标与文字在快捷键之前渐隐；CSS 为快捷键保留宽度，无需测量按钮。纯图标控件保留使用平台键位样式的 tooltip，侧栏隐藏时常驻的 macOS 头部控件也保持一致。所有控件均提供 `aria-keyshortcuts`。

### 全局面板入口

插件在 root 作用域的 `sidebar.panellist` list 中注册图标组件，提供 `id`、可选 `order`，以及字符串或 locale-aware 的 `label`。同一个 id 寻址布局中 root 作用域 `main` keyed slot 的组件；选择不存在的主面板条目会抛错，并保留当前选中态。标签提供普通可见文字、无障碍名称和折叠提示。每一行通过 `usePanelInfo` 读取自己的选中态；DOM 焦点移到搜索框或目录选择器时，显示的面板及其列表项选中态不变。没有注册项时，列表及其间距均不渲染。产品随附的组合不注册示例面板。

### 折叠行为

侧栏及会话头部的开关从命令目录读取当前有效快捷键，用于悬停、键盘聚焦提示和 `aria-keyshortcuts`。未绑定的命令只显示操作名称。

侧栏收起时，顶部展开按钮承载可选、不可交互的 `sidebar.toggle.badge` slot。占用方提供状态和提示内容，不增加操作，也不改变按钮的导航行为。

实时收起时，展开内容在当前宽度淡出，上方控件共用同一段透明度渐变，并向左平移进入 56px 轨道，由布局的栏滑动结束整段动画。页面初始即为收起状态时会静态渲染轨道；减少动态效果模式会禁用两段过渡。固定在底部的 `sidebar.settings` 控件共用相同的透明度渐变时序，但不发生横向位移。

在 Windows Electron 中，`html[data-windows-titlebar]` 将两种状态下的侧栏开关固定在顶栏左上角，仅在展开态与新建会话按钮左边缘对齐。展开态品牌位于顶栏下方、新建会话按钮上方，按钮上方额外留出 8px。收起后，品牌和侧栏内容隐藏，新建会话按钮排在侧栏开关与 Desktop 菜单之间。侧栏在收起态将根元素的 `--dsh-windows-menu-start` 设为 84px；Desktop preload 使用它将菜单放在新建会话之后，展开态默认为 48px。顶栏图标按钮采用紧凑控件圆角的 28px 控件，图标为居中 16px，并从窗口拖拽区域中排除。侧栏开关与新建会话的悬停提示在顶栏下方展开，Desktop 菜单文字不会盖住它们；占用 `sidebar.toggle.badge` 的控件自行决定气泡展开方向。

### macOS 桌面

在 `html[data-platform='darwin']`（仅由桌面 preload 设置）下，展开的侧边栏列顶部有一条 52px 的顶部条：避开 hiddenInset 红绿灯并承载收起按钮；顶部条与其下的 logo 行各自打上 `data-window-drag`，于是每行自己的盒子就是窗口的拖拽区（唯一的 darwin drag 规则由 ui-web base.css 声明），因此品牌 wordmark 在 macOS 上不再是 New Session 快捷入口——专用的 New Session 按钮保留该操作；收起时整列隐藏而非保留轨道。本包向框架的 `shell.leading` 窗口 chrome 座（ui-layout）注册 `HeaderLeadingControls`——打开侧边栏与 New Session 两个控件，由框架仅在列隐藏时挂载于红绿灯旁，覆盖所有主面板。[Desktop 参考](../../../apps/desktop/README.zh.md)负责窗口集成。

### 滚动条

栏内的滚动条是一种指针可供性：只要指针不在栏内，外壳就把滚动条间接层重新绑定为 `transparent`；指针离开后滑块再保留 2 秒，因此没人指向的列表不会带着滚动条。避免行位移的空间预留属于滚动区域本身（ui-workspace），所以显示滑块不会引起重排。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

外壳是纯组合：`SidebarRootComponentProps` 组合布局 owner share、全局 `useSessions` 与 `useWorkspaces` 钩子、已声明的品牌、`sidebar.workspaces` 与 `sidebar.settings` 子 slot，以及注入的导航回调。面板入口及其可选标题使用相同的组合方式。面板元数据由列表注册和 locale 变化派生；选中态属于布局存储。

### slot 纪律

声明感知的 `slots.inject()` 让替换包无论先于还是后于侧边栏激活都能生效。页脚承载 `sidebar.settings` 席位：侧边栏只渲染固定在底部的布局 slot，并共享其栏状态（`wide`）。`/client` 导出接口只包含插件主体（`apply`/`inject`）及约定类型；SidebarRoot、行组件与树派生仍由 slot 注册封装在包内。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖填充外壳席位的各个界面与组合模型。

- [ui-workspace](../ui-workspace/README.zh.md)——渲染到 `sidebar.workspaces` 的 Workspace 与 Session 浏览器。
- [ui-settings](../ui-settings/README.zh.md)——在 `sidebar.settings` 注册触发行与设置面板的设置领域底座。
- [ui-layout](../ui-layout/README.zh.md)——折叠所使用轨道与栏状态的布局 owner。
- [ui-theme](../ui-theme/README.zh.md)——外壳所重新绑定的滚动条 token 间接层。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——席位背后的组合模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义外壳拥有什么、其占位方拥有什么；它们是当前包约束。

- **Session 状态点渲染由 ui-workspace 持有**：本外壳没有可用的 done/error 通知数据源。
- **Workspace 浏览行为由组合持有**：分组、排序、搜索与行状态都属于 ui-workspace，不属于此外壳。
- **「New task completed」未读标记是本地查看状态**：完成时间 > 上次查看时间这一事实永远不会到达宿主。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
