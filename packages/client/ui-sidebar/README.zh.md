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

展开的品牌行把 `sidebar.brand.mark` 与 `sidebar.brand.name` 渲染为两个独立的 single slot；收起轨道则渲染同一个 mark slot。在 Web 和 Windows 桌面端，点击展开态的品牌会新建会话，悬停或聚焦时不显示 tooltip。没有占位者时，外壳只显示鱼形标记（FORK dsh-local：品牌行的本地构建标签已去掉）。FORK dsh-local（usage glance v2，2026-10-15）：展开态 logo 行**不再有品牌/新建会话按钮**——新建会话走 ⋯ 菜单（与 rail 图标），其前是常驻的 MiMo 登录首项（FORK mimo-login-cta 迁移，2026-10-30 用户指示：菜单第一项为 `panels.mimoLogin`——`登录MiMo`——新标签页打开重登工具页 `/api/mimo-relogin/page`，任何余额状态下恒显），`sidebar.brand.name` 占位者仅有内容时渲染在控件之前，整行由 `UsageGlance` 占据：**每个配额窗口各占一行（FORK usage glance v2.4，2026-10-22，行序 月 → 周 → 5h）**——每行 = 窗口短标签（`glance.window.*.label`，月/周/5h）+ 等长左对齐进度条 + **两列右对齐读数（FORK usage glance v2.4.1，2026-10-22 用户指示拆列：百分比列 `33%`、天数/小时列 `5/31d`，无时间对显 `—`，列宽固定右缘对齐）**：fill 为该窗口用量占比，条上 1px 竖向刻度线为时间进度（连续比例，起点由 `resetsAt` 回推：月 −1 月、周 −7 天、5h −5 小时），用量越过刻度的区段以警示色渲染（`--dsw-alias-state-warn-primary`，消耗快于时间即配速超前）；月/周读数为天数对、5h 为小时对；provider 未报的窗口（或无 percent）整行省略，rolling 无日结构不上屏；三行 12px 行高零间距、连同按钮 padding 恰合 40px（Windows 标题栏 logo 行上限），**其右另起一列是今/周期 token 用量两行（FORK usage glance v2.3，2026-10-22）：`今日 321.7M` 与 `周期 4.21B`，各为「小字标签 + 紧凑数字」一行，标签取 locale（`glance.today.label` / `glance.cycle.label`），数字取 overview 四个不重叠桶之和——周期值按 `pickWindow` 主窗口（month 优先 = 月行同窗；2026-10-22 三窗口拆分后二次裁定维持）对逐日序列求和（2026-10-22 裁定：套餐周期，非日历月；周期起始日整天计入，故重置日带上一周期在当天的残留），序列被 30 天窗口截断时（`availableDays` 证明周期内有键不在序列）以 `≥` 标为下限；原小字数据刷新时间戳（`26.10.15 21:30`，本地时区，即 overview 最近一次成功加载的时刻）移入该列 tooltip**；数据来自 dsh-usage 宿主 overview（`/api/dsh-usage/overview`，标签页可见时每 60s 刷新，宿主半区 404 时整体隐藏），点击后重放用户路径打开设置的使用统计分区。FORK usage glance v3（2026-10-24）：窗口同时携带绝对水位对（`used`/`limit`；宿主 OpenCode Go 取数已切 console `go/status`）时，`used / limit >= 0.85` 即触发扳机——触发行的读数数字转为 state-error 红，周/月行（A 方案切换窗）另将填充整条转红并在 tooltip 追加 `glance.trigger.hint`，5 小时行只红读数，无水位对的窗口（他家 provider、或重启生效前的宿主）绝不触发；读数列按 2026-10-24 裁定保持纯百分比。FORK usage-glance v3.5 / 自动路由，异常才现身 v2（2026-10-30 重做原 2026-10-25 徽标 `66b78fb3aa`，同日按用户设计裁定再改：常显点在 auto-route 可信时属冗余、且挤占校准列宽）：控件读取自动路由控制器（`dsh-auto-route`，裁定乙案，2026-10-30 起实跑）策略层状态 `/api/auto-route/status`（同源、同 60s 节拍；404 即读作无），**只渲染布局说不出来的信息**——控制器轮询失败出小号 error 红点（策略读数已陈旧）、95–99 死区（默认源与在途源分叉）出警示点并在 tooltip 追加「新会话默认」行、触发态不画点而是将 Go 窗口行**整体降透明度**（三行读数不再是 dsh 当前开销）并由按钮 tooltip 写明已自动切换；常态零渲染、原貌即徽标前布局；扳机提示文案为双层口径（85% 预警，95%/99% 自动线）。完整构建会显示代码徽标 `version[-commit][-dirty]`；该徽标使用 `DSH_CLIENT_VERSION`、可选的 7 位 `DSH_CLIENT_COMMIT_HASH` 与 `DSH_CLIENT_GIT_DIRTY=true` 组装，缺少版本元数据时不显示徽标。FORK dsh-local（usage glance v2）：徽标与版本读取路径都不复存在于该行——构建元数据查 fork 表，不再上屏。New Session 优先使用作用域操作明确指定的 Workspace，否则使用当前 Session 所属 Workspace，再否则使用最近活跃 Workspace；一个 Workspace 都没有时则清空选择，进入空白 New Session 页面。 展开态的新建会话按钮在悬停或键盘聚焦时于右侧以灰色文字显示当前有效绑定。快捷键可见且空间较窄时，居中的图标与文字在快捷键之前渐隐；CSS 为快捷键保留宽度，无需测量按钮。纯图标控件保留使用平台键位样式的 tooltip，侧栏隐藏时常驻的 macOS 头部控件也保持一致。所有控件均提供 `aria-keyshortcuts`。

### 全局面板入口

插件在 root 作用域的 `sidebar.panellist` list 中注册图标组件，提供 `id`、可选 `order`，以及字符串或 locale-aware 的 `label`。同一个 id 寻址布局中 root 作用域 `main` keyed slot 的组件；选择不存在的主面板条目会抛错，并保留当前选中态。标签提供普通可见文字、无障碍名称和折叠提示。展开态导航行的间距为 2px。每一行通过 `usePanelInfo` 读取自己的选中态；DOM 焦点移到搜索框或目录选择器时，显示的面板及其列表项选中态不变。没有面板注册项时，列表及其间距均不渲染。产品随附的组合不注册示例面板。

root 作用域的 `sidebar.panellist.actions` list 有注册项时，导航区域的面板行之后显示面板行样式的**更多**按钮；收起的窄栏以提示框显示其名称。它打开的菜单以该 list 的注册项为菜单行。每个注册项接收 `entries`（按注册顺序的可自定义面板，含 `id`、`label`、`pinned` 与 `active`；不含插件管理）、选中面板的 `onOpen(id)`、`onPinnedChange(id, pinned)`，以及关闭菜单的 `onDismiss()`。侧边栏在内存中保存所有会话共用的已收起面板 id 列表；插件管理入口始终显示。默认更多菜单只提供插件浏览和创建，不列出面板或 Pin 控件。其他注册项仍可调用 Pin 回调，但插件重新加载时选择重置，不读取旧 localStorage 值。收起只隐藏导航行，主面板、其注册和当前选中态不变。未注册面板的 id 保留在内存列表中，直到插件重新加载。

### 折叠行为

侧栏及会话头部的开关从命令目录读取当前有效快捷键，用于悬停、键盘聚焦提示和 `aria-keyshortcuts`。未绑定的命令只显示操作名称。

侧栏收起时，顶部展开按钮承载可选、不可交互的 `sidebar.toggle.badge` slot。占用方提供状态和提示内容，不增加操作，也不改变按钮的导航行为。

实时收起时，展开内容在当前宽度淡出，上方控件共用同一段透明度渐变，并向左平移进入 56px 轨道，由布局的栏滑动结束整段动画。页面初始即为收起状态时会静态渲染轨道；减少动态效果模式会禁用两段过渡。固定在底部的 `sidebar.settings` 控件共用相同的透明度渐变时序，但不发生横向位移。

在 Windows Electron 中，`html[data-windows-titlebar]` 将两种状态下的侧栏开关固定在顶栏左上角，仅在展开态与新建会话按钮左边缘对齐。展开态品牌位于顶栏下方、新建会话按钮上方，按钮上方额外留出 8px。收起后，品牌和侧栏内容隐藏，新建会话按钮排在侧栏开关与 Desktop 菜单之间。侧栏在收起态将根元素的 `--dsh-windows-menu-start` 设为 84px；Desktop preload 使用它将菜单放在新建会话之后，展开态默认为 48px。顶栏图标按钮采用紧凑控件圆角的 28px 控件，图标为居中 16px，并从窗口拖拽区域中排除。侧栏开关与新建会话的悬停提示在顶栏下方展开，Desktop 菜单文字不会盖住它们；占用 `sidebar.toggle.badge` 的控件自行决定气泡展开方向。

### macOS 桌面

在 `html[data-platform='darwin']`（仅由桌面 preload 设置）下，展开的侧边栏列顶部有一条 52px 的顶部条：避开 hiddenInset 红绿灯并承载收起按钮；顶部条与其下的 logo 行各自打上 `data-window-drag`，于是每行自己的盒子就是窗口的拖拽区（唯一的 darwin drag 规则由 ui-web base.css 声明），因此品牌 wordmark 在 macOS 上不再是 New Session 快捷入口——专用的 New Session 按钮保留该操作；收起时整列隐藏而非保留轨道。本包向框架的 `shell.leading` 窗口 chrome 座（ui-layout）注册 `HeaderLeadingControls`——打开侧边栏与 New Session 两个控件，由框架仅在列隐藏时挂载于红绿灯旁，覆盖所有主面板。[Desktop 参考](../../../apps/desktop/README.zh.md)负责窗口集成。

### 滚动条

栏内的滚动条是一种指针可供性：只要指针不在栏内，外壳就把滚动条间接层重新绑定为 `transparent`；指针离开后滑块再保留 2 秒，因此没人指向的列表不会带着滚动条。避免行位移的空间预留属于滚动区域本身（ui-workspace），所以显示滑块不会引起重排。

### 点击埋点

在桌面端，官方导航控件在执行操作前上报 `sidebar_menu_click`，携带 `menu_name` 与 `position`。没有埋点服务时，这些控件只执行导航。通过其他途径选中面板不上报，侧边栏也不上报曝光事件。

- 展开态品牌与新建会话按钮上报 `menu_name=new_session`、`position=sidebar`。Windows 顶栏承载收起态新建会话按钮时，该按钮上报 `position=titlebar`；macOS 红绿灯旁的新建会话控件同样上报 `position=titlebar`。
- **插件**与**自动化任务**面板行分别上报 `menu_name=plugin` 与 `menu_name=cron`，`position=sidebar`。其他面板行不上报。
- 每次点击**更多**按钮都上报 `menu_name=more`、`position=sidebar`，无论打开还是关闭菜单。
- 第三方注册的更多菜单行通过 `onOpen(id)` 打开插件或自动化任务时，上报 `menu_name=plugin` 或 `menu_name=cron`，`position=sidebar_more`。随产品提供的更多菜单只浏览和创建插件，不会调用 `onOpen`。上报先于注册检查，因此所请求的面板已注销时仍会计数，但不会选中任何面板。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

外壳是纯组合：`SidebarRootComponentProps` 组合布局 owner share、全局 `useSessions` 与 `useWorkspaces` 钩子、已声明的品牌、`sidebar.workspaces` 与 `sidebar.settings` 子 slot，以及注入的导航回调。侧边栏声明 `sidebar.panellist`，并直接渲染各面板注册的图标。面板元数据由列表注册和 locale 变化派生；选中态属于布局存储。注入的 `trackEntryClick(attributes)` 转发到 `ctx.get('productAnalytics')?.track('sidebar_menu_click', attributes)`；`selectPanel` 只负责选中，因此由各控件自行提供入口与位置。

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
