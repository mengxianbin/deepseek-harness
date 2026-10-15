/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.label': '全局面板',
  'panels.more': '更多',
  'glance.open': '打开使用统计',
  'glance.usage': '套餐周期用量：已用 / 总量（%）',
  'glance.days': '套餐周期天数：已过 / 总计',
  'glance.today': '今日 token 用量',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
  'panels.more': 'More',
  'glance.open': 'Open usage statistics',
  'glance.usage': 'Plan cycle usage: used / total (%)',
  'glance.days': 'Plan cycle days: elapsed / total',
  'glance.today': 'Tokens today',
} satisfies Record<SidebarKey, string>
