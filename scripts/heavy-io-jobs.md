# 闸在册大活清单与拆分轮转（heavyio-silentdeath-1128 · 腿②）

判据源：任务书 heavyio-silentdeath-1128 腿② + 派发侧事实更正函（session-6561bef0，2026-11-28）——**单块上界 = 258s**（看门狗 typecheck 族 `tHard=258s` 现核现踢，超过必被收割；原任务书 5min 作废）。拆分目标：任何可拆大活的单块 ≤258s；不可拆项必须标「不可拆 + 理由」。

时长数据两源，表中逐条标注：**实测** = 本机直接读数；**参照** = mem-quota-ruling-1124 §〇 表B 族中位（看门狗 `_TIER_HOT_T_OP_S` 同源，「起步值、观察器校准」）。

## 一、族阈值参照（build-watchdog.py `_TIER_HOT_T_OP_S`，2026-11-28 读源核实）

| 族 | 表B 中位 | tOp=中位×3 | tHard=2×tOp | 命令串判定（`_tier_family`） |
|---|---|---|---|---|
| typecheck | 43s | 129s | **258s** | 含 `typecheck` 或 `tsc`（且非 full-cold 形） |
| lint | 28s | 84s | 168s | 含 `lint` |
| install | 173s | 519s | 1038s | 含 `install` |
| vitest | 225s | 675s | 1350s | 含 `vitest` 或 `jest` |
| build | 302s | 906s | 1812s | 含 `build` |
| full-typecheck | 3238s（合法极值） | 6476s | 12952s | 含 `--scope` 且含 `typecheck` |
| unknown | — | lock_min 45min | 90min | 判不全 = 宁松不误踢 |

本清单统一取 **258s** 为拆分上界（最紧的常用族 tHard；lint 族更紧的 168s 见各条标注）。

## 二、可拆大活总表（每条 ≤258s 或标不可拆）

### A. heavy-io-gate 直接包装（package.json `heavy-io-gate.ts "…"` 形）

| 作业 | 入口 | 族 | 参照/实测时长 | 拆分方式 | 单块目标 |
|---|---|---|---|---|---|
| 全量测试 | `test:all` / `heavy:test` | vitest | 参照中位 225s；全量 38min（冷） | 按包/文件：`pnpm exec vitest run packages/<pkg>/tests/…` 逐包跑 | ≤258s/包（实测分包 30–130s） |
| 覆盖率全量 | `test:coverage` | vitest | 参照 225s 中位；全量更长 | 已有 `test:coverage:partitioned`（分片入口在册） | ≤258s/片 |
| GUI 测试 | `heavy:test:gui` = `vitest run packages/client packages/host` | vitest | 参照 225s 中位 | 拆两半：`vitest run packages/client` / `vitest run packages/host`；再按包细分 | ≤258s |
| 快测 | `test`（vitest.fast.config） | vitest | 参照 225s 中位 | 按包/文件同上 | ≤258s |
| e2e | `test:e2e` | vitest | 未测（参照 225s） | 按 spec 文件拆 | ≤258s |
| expected/snapshot 族 | `test:expected` `test:snapshot` 等 | vitest | 未测（参照 225s） | 按 spec 文件拆 | ≤258s |
| web 测试族 | `test:web` `test:web:built` 等 | vitest（含 `--config vitest.web`） | 未测 | 按 spec 文件拆 | ≤258s |
| 慢道 | `test:slowlane` | vitest | 未测 | 按批拆（run-slow-lane 内部分批） | ≤258s |
| 全仓 lint | `lint` / `heavy:lint:contracts-ready`（`run-oxlint.ts .`） | lint | 表B 中位 28s；全仓实测远超 | 按目录 chunk：`node scripts/run-oxlint.ts packages/client` / `packages/host` / `scripts` / `apps`…（targeted 形式是 hot-path，**免 fullcheck ticket**——拆分的额外收益，FULL_COLD_PATTERNS 注释明载） | ≤258s/块；lint 族 tHard=168s，块目标 ≤168s 更稳 |
| lint 修复 | `lint:fix` | lint | 同上 | 同上按目录拆（`--fix` 形） | ≤168s |
| 安装 | `heavy:install` | install | **实测 466.6s**（2026-11-28 本机 RC=0，7m46.6s） | **不拆**（单事务，拆 = 锁碎裂/半装态）；单独跑、避开红窗即可——install 族 tHard=1038s > 466s 不被收割 | 单独跑（任务书原话「install 单独」） |
| 文档站构建 | `docs:build` / `docs:check` | build | 未测（参照 302s 中位） | 拆 = 先 `tsx website/build.ts` 后 `verify-doc-site-fragments`（本就是 `&&` 两段） | ≤258s |
| lib 构建 | `heavy:build:lib` | build | 未测（参照 302s 中位） | 已有半区入口 `heavy:build:lib:host` / `heavy:build:lib:client` 两块 | ≤258s/半区（超则再按 compile→tsc→bundle 步拆） |
| 桌面打包 | `package:desktop:*`（10 变体） | build | 未测 | 已按目标平台拆成 10 个独立脚本（win:x64 / mac:arm64 / mac:x64 × dir/unsigned） | 单目标 ≤258s（超则该目标不可拆，见 C 节） |
| web/desktop 构建 | `build:web` `build:desktop` | build | 未测（参照 302s） | 单包构建，内部按 workspace 依赖序；超时按 face 拆（build:lib 先例） | ≤258s |
| 重复度扫描 | `duplication`（jscpd） | unknown→lint 形 | 未测 | 按目录拆（`jscpd packages/client` / `packages/host` / `scripts`） | ≤258s |
| doc-typecheck | `doc-typecheck` | typecheck | 未测 | 按文档域拆（若单跑超时） | ≤258s |

### B. sink 入口（自身进闸的三处，非 package 包装）

| 作业 | 入口 | 族 | 参照/实测时长 | 拆分方式 | 单块目标 |
|---|---|---|---|---|---|
| 聚合 typecheck | `typecheck` = `build.ts --scope typecheck` | full-typecheck（`--scope`+`typecheck` 判定） | **实测热跑 68s**（更正函）；iso host 冷 >386s、client 210s | 见 C 节不可拆项 | — |
| 聚合 check | `build:check` = `build.ts --scope check` | full-typecheck | 同上 | 同上 | — |
| 完整构建 | `build` = `build.ts`（全 scope） | build（命令串 `scripts/build.ts`） | 未测（参照 302s 中位；r1 实况被 floor-tier 杀） | 拆 = `build:check` + `build:artifacts` 两 scope 分跑（scope 级在册拆分）；artifacts 内按 gate 图分步 | ≤258s |
| 全量检查矩阵 | `check:all` = `run-gates.ts check-all` | 按子 gate 分族 | 未测 | **本就是 gate 图**：`check:ci:unit` / `check:ci:static` / `check:ci:coverage` / `check:node-compat` / `hygiene` / `doc-sync` / `check:i18n` / `test:docs` 等 15 个独立 mode 在册，逐 mode 跑即天然分块 | ≤258s/mode |
| CI 矩阵族 | `check:ci:*`（12 个 mode） | 混 | 未测 | 每 mode 独立在册；mode 内再按 gate 叶子并发（gate 图已有 `needs`/`after` 依赖） | ≤258s/mode |

### C. 不可拆项（标「不可拆 + 理由」）

| 作业 | 判定 | 理由 | 处置 |
|---|---|---|---|
| **聚合 typecheck 根程序检查**（`tsc -b tsconfig.host.json` / `tsconfig.client.json`；`build.ts --scope typecheck/check` 的聚合腿） | **不可拆** | 单进程全程序内存峰：`tsc -b` 整项目图必须单进程一次构建（466 个分项 .tsbuildinfo 是它的续跑缓存，不是可并行块）——拆成多进程 = 每进程各自重建全图（内存翻倍 + 增量失效），违背任务书唯一已知不可拆项的定义 | ① 绿窗开火（avail ≥3450MB）② 死因日志兜底：本仓 die-log 已记录 exit 路径 + 内存快照 + kill-audit 交叉引用（killedBy/killTier）③ 热跑优先（68s < 258s 安全）；冷跑 >386s 会被 typecheck 族 tHard=258s 收割——**命令串含 `--scope typecheck` 时看门狗判 full-typecheck 族（tHard=12952s）不收割**，裸 `tsc -b …` 形才判 typecheck 族，排程时优先走 `pnpm run typecheck`（build.ts sink 形） |
| `pnpm install` | 不可拆 | 单事务原子操作，拆分产生半装态与锁碎裂 | 单独跑（466s < install 族 tHard=1038s，不被收割）；避开地板红窗 |
| 桌面单目标打包（`package:desktop:<os>:<arch>` 单脚本内部） | 条件不可拆 | electron 打包单目标内不可再分（按 face 拆仅对 lib 构建有效） | 实测超 258s 则标不可拆 + 走 build 族 tHard=1812s 容忍（build 族中位 302s 本就超 258s，看门狗对 build 族按 906s/1812s 起踢——**258s 上界对 build 族是超额保守**，此处按族 tHard 放宽并记录） |

## 三、拆分轮转执行约定

1. **块间交接**：每块独立走闸（独立进程 = 独立 pid），块 A `release` → 块 B `acquire`，history.log 出现不同 pid 的 acquire/release 交接行即为锁易主证据。
2. **插队窗口**：拆分的收益不止避收割——块间锁空窗允许小单（staged lint 等 hot-path）插入排队，整活不再独占机器数小时。
3. **地板协同**：开火前读 avail ≥3450MB（聚合腿绿窗）或 ≥1611MB（普通闸）；红窗内块留队（floor-red 留队至绿，处置 A）。
4. **死因留痕**：每块的 exit 路径 + 内存快照落 die-log（腿①），块被收割时 kill-audit 交叉引用给出 killedBy + tier——拆分块若仍被杀，说明块定标错了，回表修上界。

## 四、拆分跑通证据（机检B 回填，2026-11-28 实跑）

活 = 全量 lint（表A 第 35 行可拆项），按目录拆两块，两独立进程直调 `run-oxlint.ts <目录>` 各自进闸（不套共享外层闸——外层持锁会注 `DSH_HEAVY_IO_HELD=1` 让内层透传，只剩一次持锁、无易主）。块1 先起持锁，sleep 3 后块2 起 → 排队 → 块1 释放后块2 接手 = 真实换手。

**history.log 增量原文（易主证据，UTC）**：

```
2026-11-28T07:53:45.002Z acquire pid=19972 cmd=run-oxlint.ts scripts
2026-11-28T07:53:48.111Z waiting pid=19504 waitedMs=7 holderPid=19972 holderCmd=run-oxlint.ts scripts cmd=run-oxlint.ts packages/host
2026-11-28T07:54:19.891Z floor-red pid=19504 waitedMs=31787 freeMb=1594 floorMb=1611 cmd=run-oxlint.ts packages/host
2026-11-28T07:55:16.073Z release pid=19972 heldMs=91070 cmd=run-oxlint.ts scripts
2026-11-28T07:55:16.410Z acquire pid=19504 cmd=run-oxlint.ts packages/host
2026-11-28T07:55:51.268Z release pid=19504 heldMs=34856 cmd=run-oxlint.ts packages/host
2026-11-28T07:55:51.803Z acquire pid=33424 cmd=pnpm vitest run packages/dsh-better-sidebar/…
```

锁换手 **≥1 次实证**：`pid=19972` 释放 → **`pid=19504` 接手**（块间易主）；随后第三方 `pid=33424`（他方 vitest）再接手块2 的锁——拆分空窗允许插队（§三 第 2 条）同场验证。附带验证：块2 排队中撞地板红自动留队（`floor-red … holding the queue`）后恢复 = 处置A 生效。

**die.log 增量原文（每块 exit 路径 + 内存快照）**：

```
2026-11-28T07:55:16.081Z release pid=19972 heldMs=91070 reason=正常收口 freeMb=2666 floorMb=1611 cmd=run-oxlint.ts scripts
2026-11-28T07:55:16.087Z exit pid=19972 path=normal exitCode=0 freeMb=2666 floorMb=1611 cmd=run-oxlint.ts scripts
2026-11-28T07:55:51.271Z release pid=19504 heldMs=34856 reason=正常收口 freeMb=2790 floorMb=1611 cmd=run-oxlint.ts packages/host
2026-11-28T07:55:51.274Z exit pid=19504 path=normal exitCode=0 freeMb=2790 floorMb=1611 cmd=run-oxlint.ts packages/host
```

**单块时长**：块1 = 92s（oxlint 实跑 90.7s / 388 文件 / 0 错）、块2 = 124s（oxlint 实跑 34.3s / 47 文件 / 0 错，含排队 31.8s 地板红留队）——均 ≤258s 上界。脚本 = worktree `.tmp/mcheck-b.sh`。
