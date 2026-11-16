# Agent Note: 小键盘数字键触发数字行快捷键绑定

Status: proposed

[English](2026-11-16-numpad-digit-shortcuts.md) | 中文

## 问题

快捷键分发把物理键码 `event.code` 对照一份封闭白名单匹配：[`normalizeBinding`](../../../../packages/client/shortcuts/src/binding.ts) 只接受 `Key[A-Z]`、`Digit[0-9]`、`F1`–`F24` 和一张固定的标点、编辑、导航键表，其余一律抛出 `Unsupported shortcut code`。数字小键盘发送的是 `Numpad0`–`Numpad9`，因此小键盘既不能触发快捷键、也无法被录制成绑定——录制编辑器对小键盘按键回答「暂不支持这个按键。」——而快捷键相关包里从来没有任何提交讨论过这次排除（对 `packages/client/shortcuts`、`packages/client/ui-shortcuts` 和 `apps/desktop/src/keyboard.ts` 跑 `git log -S Numpad` 均为空）。

这次排除是未经审视的初始范围，而非有案可查的决策：提交 `efdf8e5b6d`（2026-09-21）引入 `binding.ts` 时白名单就已如此，没有任何测试钉住它，该包的[已知限制清单](../../../../packages/client/shortcuts/README.zh.md)也没有列出它。记录里没有留下任何可供遵循的理由，代价却落在用户身上：用大键盘时小键盘就在右手边，`Ctrl+1`/`Ctrl+2`/`Ctrl+3` 却仍要伸手去够字母上方数字行——同一套绑定在不同设备形态上有了不同的人体工学。

任何修复都必须先越过白名单一直默默承载的五条约束：

- **键帽显示。** [`presentBinding`](../../../../packages/client/shortcuts/src/binding.ts) 只剥离 `Key` 和 `Digit` 前缀；裸的 `Numpad1` 会被原样显示成键帽 `Numpad1`。
- **ARIA。** `aria-keyshortcuts` 按 [UI Events `key` 值](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key)命名按键，而不是按 `code`；小键盘数字的 `key` 值在 NumLock 开启时是 `1`、关闭时是 `End`，所以一等公民的小键盘绑定没有与数字行区分开的稳定名称。
- **持久化。** 存下来的 `Numpad1` 在任何仍是旧白名单的构建上都会让 [`parseBinding`](../../../../packages/client/shortcuts/src/configuration.ts) 抛错，一条坏记录会让整份偏好文档被判为无效，设置编辑被锁死直到手工修复——这种失败即关闭的读取行为记录在[偏好 Agent Note](../../implemented/architecture/2026-09-20-device-local-shortcut-preferences.zh.md) 中。
- **Electron 加速器。** 菜单词表把小键盘键拼作 `num1` 那一套——这是第三种拼法——而且 Electron 不会因小键盘按下而触发数字行的加速器（[electron#3332](https://github.com/electron/electron/issues/3332)）。
- **双键组合。** 双键绑定在 [`keyboard.ts`](../../../../apps/desktop/src/keyboard.ts) 和录制编辑器里对裸键码做排序与比较；两套键码词汇流过同一台状态机容易对不上。

## 提案

在物理键码进入快捷键系统的三处接缝上，把小键盘数字映射到数字行，映射逻辑通过一个由快捷键协议导出的共享辅助函数提供（例如放在 `bindingKey` 旁的 `aliasKeypad`），让两个适配器和编辑器共用一份映射而不是各写一份：

- [`dom.ts`](../../../../packages/client/shortcuts/src/client/dom.ts) —— 在构造手势对象之前映射 `event.code`，覆盖 Web 与 Linux 的分发以及全部固定序列。
- [`keyboard.ts`](../../../../apps/desktop/src/keyboard.ts) —— 在 `before-input-event` 顶部映射一次 `input.code`，使匹配查找、按住键的双键状态、菜单关闭比对、以及转发给渲染进程的键码看到的都是 `Digit*`。
- [`Editor.tsx`](../../../../packages/client/ui-shortcuts/src/client/Editor.tsx) —— 在 `describeBinding` 之前映射 `event.code`，使录制存下 `Digit*` 绑定，双键录制也把两个键一并捕获。

下游的一切——注册表索引、冲突检测、键帽、`aria-keyshortcuts`、偏好文档——继续只消费 `Digit*`，因此显示、ARIA、加速器、schema 四层都不需要改动，偏好文档里也永远不会出现 `Numpad*`。

小键盘数字的 `code` 不依赖 NumLock（NumLock 改变的是 `event.key`），所以映射在 NumLock 开启与关闭时都成立，且未被绑定的小键盘按键仍会送出浏览器默认行为——NumLock 关闭时就是导航。

范围仅限 `Numpad0`–`Numpad9`。`NumpadEnter`、`NumpadDecimal` 和运算键在数字行没有对应物；它们维持不支持，谁需要谁另立提案。

一个绑定、两个触发键：小键盘无法绑定到与数字行不同的命令。这是刻意的取舍。

## 考虑过的替代方案

**把 `Numpad*` 作为一等公民放进白名单。** 这样小键盘可以携带独立于数字行的绑定。否决：它要同时教会三套词汇——键帽显示、`aria-keyshortcuts`（其键值命名根本无法区分小键盘与数字行）、以及 Electron 的 `num*` 加速器拼法——它让每个数字绑定的冲突矩阵翻倍，而且决定性的一点是它把每次保存都变成一次兼容性事件：含 `Numpad1` 的偏好文档在任何旧构建上都会被判为 `invalid`，设置编辑被锁死直到手工修复。换来的是一项没人要求过的能力——同一个动作的第二份绑定。

**只在 DOM 适配器里做别名。** 改动最小，且能立刻修好 Web。否决：Windows 与 macOS 桌面端只从原生 `before-input-event` 输入分发可配置命令（见[包 README](../../../../packages/client/shortcuts/README.zh.md)），而实体小键盘恰恰在那里。

**在 `bindingKey` 里做别名。** 共享的索引构造器看似唯一的咽喉要道。否决：分发确实会开始匹配，但编辑器更早就拒绝了小键盘——`describeBinding` 在任何索引查找之前先跑 `normalizeBinding`——录制依然会失败，功能只完成一半。

**在 `normalizeBinding` 里做别名。** 这是注册与录制都要经过的唯一校验器。否决有两个理由：分发从不调用它——`registry.dispatch` 直接用手势构造查找键——小键盘按键仍然不会触发；而且它会开始接受已存文档里的 `Numpad*`，恰好重新打开入口映射方案所避开的降级锁死面。

**什么都不做、只把缺口记进文档。** 否决：这个缺口背后没有任何有案可查的理由，人体工学抱怨是具体的，而修复只触及输入适配器——拖延保留的是一个没有解释的排除，而不是一个决策。

## 验收标准

- 在 Windows/macOS 桌面端与 Web 上，`Ctrl` 加小键盘 `1`/`2`/`3`（Web：`Ctrl+Alt` 加……）聚焦会话列表、对话区与输入框，效果与数字行完全一致，且 NumLock 开启与关闭皆然。
- 快捷键编辑器把小键盘数字录成对应的 `Digit*` 绑定、显示数字键帽，对 `Numpad0`–`Numpad9` 不再回答不支持按键的提示。
- 在 Windows/macOS 桌面端，小键盘数字可以作为双键绑定的任意一键参与组合，与用数字行键写出的同一组合匹配。
- 录制小键盘按键只把 `Digit*` 写进 `dsh.keybindings.v1`（Web）与 `keybindings.json`（桌面端）；有测试断言已存文档不含任何 `Numpad*`。
- 单元测试覆盖三处接缝各一处映射、外加一次分发往返，既有测试套件保持全绿，`doc-sync` 通过。

## 风险

- 别名把两行熔为一体：想在小键盘上绑到*不同*命令的用户得不到满足。若这种需求出现，一等公民的 `Numpad*` 才是后继方案——届时这个别名必须重新审视，而不是叠在它上面。
- Windows/macOS 桌面端的 `bindingIssue` 放行不带修饰键的数字绑定；NumLock 关闭时，小键盘按键会在用户期待 `End` 系导航的位置触发这类绑定。所有出厂默认都带修饰键，因此只有刻意录制裸数字的用户才会遇到。
- 别名在已存文档与速查界面里是隐形的——小键盘按键处处看起来都和数字行一样，这正是本意——但关于小键盘做了什么的 bug 报告需要把这一点放在心上。
- 日后新增的第四条输入路径若没有这份映射，会再次悄悄拒绝小键盘；在那之前，三处接缝的测试就是护栏。
