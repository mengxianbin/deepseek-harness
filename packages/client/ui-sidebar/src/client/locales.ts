/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.more': '更多',
  'panels.mimoLogin': '登录MiMo',
  'glance.open': '打开使用统计',
  'glance.window.month.label': '月',
  'glance.window.week.label': '周',
  'glance.window.5h.label': '5h',
  'glance.window.month.title': '月窗口：用量占比与时间进度（读数 = 用量% · 已过 / 总计天）',
  'glance.window.week.title': '周窗口：用量占比与时间进度（读数 = 用量% · 已过 / 总计天）',
  'glance.window.5h.title': '5 小时窗口：用量占比与时间进度（读数 = 用量% · 已过 / 总计小时）',
  'glance.today': '今日 token 用量',
  'glance.cycle': '套餐周期 token 用量',
  'glance.today.label': '今日',
  'glance.cycle.label': '周期',
  'glance.mimoBalance.label': '余额',
  'glance.mimoBalance.stale': '陈旧，最后探测',
  'glance.refreshed': '数据刷新于',
  // 双层口径（2026-10-24 裁定；线值随 2026-10-27 参数修订）：85% 只是 UI 预警红层，95/99 才是自动动作线。
  'glance.trigger.hint': '≥85% 预警；95% 换新会话默认、99% 自动切换',
  'glance.source.label': '源',
  'glance.source.go': 'OpenCode Go',
  'glance.source.mimo': 'MiMo 官方',
  'glance.source.baseline': '常态',
  'glance.source.triggered': '自动切换中',
  'glance.source.decided': '最近决策',
  'glance.source.defaults': '新会话默认',
  'glance.source.pollError': '控制器轮询异常',
  'glance.source.frozen': 'dsh 已自动切至 MiMo 官方',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.more': 'More',
  'panels.mimoLogin': 'Sign in to MiMo',
  'glance.open': 'Open usage statistics',
  'glance.window.month.label': 'Mo',
  'glance.window.week.label': 'Wk',
  'glance.window.5h.label': '5h',
  'glance.window.month.title': 'Monthly window: usage share and time progress (read-out = usage% · elapsed / total days)',
  'glance.window.week.title': 'Weekly window: usage share and time progress (read-out = usage% · elapsed / total days)',
  'glance.window.5h.title': '5-hour window: usage share and time progress (read-out = usage% · elapsed / total hours)',
  'glance.today': 'Tokens today',
  'glance.cycle': 'Tokens this plan cycle',
  'glance.today.label': 'Today',
  'glance.cycle.label': 'Cycle',
  'glance.mimoBalance.label': 'Balance',
  'glance.mimoBalance.stale': 'stale, last probe',
  'glance.refreshed': 'Refreshed',
  // Double-layer ruling (2026-10-24; lines per the 2026-10-27 revision): 85% is the UI warning red, 95/99 the auto-action lines.
  'glance.trigger.hint': '≥85% warn; default at 95%, switch at 99%',
  'glance.source.label': 'Source',
  'glance.source.go': 'OpenCode Go',
  'glance.source.mimo': 'MiMo official',
  'glance.source.baseline': 'Baseline',
  'glance.source.triggered': 'Auto-switched',
  'glance.source.decided': 'Decided',
  'glance.source.defaults': 'New sessions default to',
  'glance.source.pollError': 'Controller poll failing',
  'glance.source.frozen': 'dsh auto-switched to MiMo official',
} satisfies Record<SidebarKey, string>
