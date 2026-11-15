---
kind: upgrade-guide
description: "提问输入框改为 Enter 换行、Shift+Enter 继续流程。"
---

# 提问输入框 Enter 对齐共用键对

[English](guide.md) | 中文

## 变更

提问输入框交换了两个 Enter 手势，与对话输入框对齐。原先按 `Enter` 继续流程（下一题或提交）、按 `Shift` + `Enter` 换行；现在 `Enter` 换行、按 `Shift` + `Enter`（或 `Cmd`/`Ctrl` + `Enter`）继续流程。IME 组合输入期间按 Enter 仍只确认候选，高亮的 `/` 菜单项仍由菜单落定，聚焦选项上按 Enter 仍提交整组答案。

所有回答过问题的 Web 与桌面端用户都能感知：长答案从此有了 `Shift` + `Enter` 才能打出的换行，而触屏设备按不出这个组合。快捷键参考现在把这对键列在同一分组「文本输入」（由「消息输入」改名）下：`Enter` 在「换行」旁，`Shift` + `Enter` 同时在「发送消息」与「下一题／提交」旁——后者由提问插件用与按键同源的绑定登记。排队行编辑器与 goal 栏仍保持自己的 Enter 行为。

## 迁移

1. 在问题的文本答案里，用 `Enter` 换行，不再用它继续流程。
2. 用键盘继续改为按 `Shift` + `Enter`，或点「下一题／提交」按钮；发送按钮不受影响。
3. 更新驱动提问答案的脚本、测试与自动化：原来用于继续的 `press('Enter')` 改成 `press('Shift+Enter')`，原来用于换行的 `press('Shift+Enter')` 改成 `press('Enter')`。
4. 在会话里验证：答案框里用 `Enter` 打两行（框变高、流程不动），再按 `Shift` + `Enter`（流程前进一题）。
