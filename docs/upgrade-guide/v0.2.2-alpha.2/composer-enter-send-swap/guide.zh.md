---
kind: upgrade-guide
description: "输入框 Enter 改为换行，Shift+Enter 改为发送消息。"
---

# 输入框 Enter 换行、Shift+Enter 发送

[English](guide.md) | 中文

## 变更

对话输入框交换了两个 Enter 手势。原先按 `Enter` 发送草稿、按 `Shift` + `Enter` 换行；现在 `Enter` 换行、按 `Shift` + `Enter` 发送草稿。`Cmd`/`Ctrl` + `Enter` 仍是加速的 Queue/Steer 投递，带 `Alt`、`AltGraph`、同时带 `Ctrl` 与 `Cmd`，或 `Shift` 与 `Ctrl`/`Cmd` 组合的 Enter 依旧不改动草稿、留给应用快捷键。

Web 与桌面端的所有用户都会感知到这次对调，触屏设备尤其受益——此前它们没有任何换行手段。本次改动其余行为不变：菜单、弹层、终端、排队行编辑器与 goal 栏各有自己的 Enter 行为，其他快捷键绑定也保持原样。快捷键参考把 `Shift` + `Enter` 列在「发送消息」旁、把 `Enter` 列在「换行」旁；本版本的后续变更让提问输入框对齐同一键对、分组改名「文本输入」（见[提问输入框 Enter 对齐](../question-composer-enter-alignment/guide.zh.md)）。

## 迁移

1. 输入多行消息时，用 `Enter` 换行，不再用 `Shift` + `Enter`。
2. 用键盘发送改为按 `Shift` + `Enter`；发送按钮与 `Cmd`/`Ctrl` + `Enter` 不变。
3. 更新驱动输入框的脚本、测试与自动化：原来用于发送的 `press('Enter')` 改成 `press('Shift+Enter')`，原来用于换行的 `press('Shift+Enter')` 改成 `press('Enter')`。
4. 在会话里验证：输入一行后按 `Enter`（草稿增加一行、不发送），再按 `Shift` + `Enter`（恰好送达一条消息）。
