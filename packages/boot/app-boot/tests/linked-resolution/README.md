# linked-resolution 差分矩阵拆分（三刀·刀1，2026-11-01 批）

> 一句话：把原来一个文件里全量串行跑的 4800 个差分用例，按家族拆成 10 个测试文件（跨文件跨 worker 并行），默认车道用 pairwise 正交表抽样到 693 例（覆盖论证机器可查），全深度一键逃生门保留；单文件从「93.4 分钟级尾部」变成秒～十秒级。
>
> 落点 = 本目录（`packages/boot/app-boot/tests/linked-resolution/`，worktree `.wt/matrix-split-1101`），原 `tests/linked-resolution-matrix.spec.ts`（644 行）由本目录整体取代。

## 1. 拆分前形态与问题

- 原文件单 `describe(..., { concurrent: false })` 装 **4800 用例**（10 组嵌套循环逐段加总，原 L140-283），vitest 单文件单 worker 全串行；
- 每用例 = 3 棵真实临时目录树（native / current / reference 各一棵：mkdtemp + 逐文件写 + junction 软链）+ 7 法探测（esm-resolve / esm-meta-resolve / esm-import / cjs-resolve / cjs-require / cjs-paths / metadata）+ rmSync 拆树；
- 量级：coverage 分区跑 **93.4min**（判据源 = 任务书，10-24 日志口径）；2026-11-02 01:2x 争用现场实测**单文件全量 88 分钟未完跑**（23:59:01 起、01:27:23 杀停，worker CPU 已 3514s；现场 = 主树全量 + 3 个邻批 vitest 并跑）——「普通全量日尾部永远跑不完」的本体；
- 差分语义 = 存在意义：native Node vs profile 拦截 7 法差分（断言 selected ≠ external），防 cosmokit 同族解析回归（事故档 = `content/tech/ai/dsh/dsh-web-troubleshooting.md`（主树）主树 L151）。

## 2. 新布局

| 文件 | 内容 |
|---|---|
| `cases.ts` | 全网格用例生成器（原 L13-50/140-283 逐字搬移，生成语义零变化）+ 共享类型/常量 |
| `harness.ts` | 夹具/探测/断言机器（原 L52-138/285-577 搬移）+ 按家族写报告 + `runFamilySuite()` |
| `sampling.ts` | pairwise 正交选择器（贪心 set cover）+ 因子表 + `DSH_RESOLUTION_MATRIX_FULL=1` 逃生门 |
| `matrix-<家族>.spec.ts` ×10 | 每家族一个 spec（薄壳：`runFamilySuite(family, selectFamilyCases(family))`） |
| `sampling-coverage.spec.ts` | 抽样覆盖论证的机器检查（纯计算，无夹具，进快速档） |

10 个家族全部保留：root / placement / workspace-declaration / malformed-declaration / request-form / helper-declaration / node-comparison / node-comparison-files / node-comparison-explicit / node-legacy。

## 3. 抽样设计（pairwise 正交表）

**默认车道**：每家族对「因子取值对全覆盖（2-way covering array）」做贪心 set cover 选行；**全深度**：`DSH_RESOLUTION_MATRIX_FULL=1` 时每家族跑全网格 4800 例（报告产物同步标注 mode）。

| 家族 | 因子（取值域） | 全网格 | 默认车道 | 边界钉 |
|---|---|---|---|---|
| root | layout(3) × name(2) × inRuntime(2) × declarations(8) × copies(0-7) | 768 | 129 | 13 |
| placement | layout(3) × name(2) × inRuntime(2) × declarations(8) × copies(7 档) × importer(3) | 2016 | 153 | 7 |
| workspace-declaration | name(2) × inRuntime(2) × declarations(8) × workspaceDeclarations(8) × copies(3 档) | 768 | 129 | 5 |
| malformed-declaration | layout(3) × name(2) × inRuntime(2) × variant(6) × copies(2 档) | 144 | 45 | 12 |
| request-form | layout(3) × name(2) × inRuntime(2) × declarations(2) × request(4 模板) × copies(2 档) | 192 | 42 | 8 |
| helper-declaration | layout(3) × name(2) × inRuntime(2) × declarations(2) × helperDeclarations(2) × copies(2 档) × importer(2) | 192 | 36 | 6 |
| node-comparison | layout(2) × name(2) × inRuntime(2) × startManifest(3) × startModules(3) × parent(5) | 360 | 59 | 6 |
| node-comparison-files | layout(2) × name(2) × inRuntime(2) × importer(2) × request(4 模板) × startModules(2) | 128 | 34 | 6 |
| node-comparison-explicit | layout(2) × name(2) × inRuntime(2) × copies(2 档) | 16 | 11 | 4 |
| node-legacy | layout(3) × name(2) × inRuntime(2) × legacyEntry(6) × request(3 模板) | 216 | 55 | 9 |
| **合计** | | **4800** | **693**（−85.6%） | 76 |

**为什么 pairwise 算「不削弱差分覆盖」**：差分的判别力来自「某因子取值组合下 native 与拦截结果分叉」；pairwise 保证每家族**任意两因子的任意取值组合至少被真实跑一次**，被砍掉的只是三阶及以上近亲组合（同族近亲行）。核心语义对（declaration 声明集 × copies 拷贝位）以完整 8×8/8×7 值对保留，未做任何压缩。

**边界变体零丢失（机器可查，`sampling-coverage.spec.ts` 五断言）**：
1. 全计划钉 = 4800 例、10 家族、每家族计划数逐个对表；
2. 采样只从全网格取行（id ⊆ 全网格、无自造行、无重复）；
3. 每家族每因子取值域 = 全网格取值域（值完整性）；
4. 每家族每因子对取值对全覆盖（pairwise 完整性；要求域取自全网格，丢值藏不住自己的对）；
5. 边界钉逐条在场（上表 76 条：角点如 decl0×copies0 / decl7×copies7、各位单因子行、每 variant×copies、每 request 模板×copies、每 legacy 条目、每目录状态值对）。

**逃生门**：任何改 boot/profile-resolution 面的批次怀疑抽样藏了三阶回归时，`DSH_RESOLUTION_MATRIX_FULL=1 pnpm exec vitest run packages/boot/app-boot/tests/linked-resolution` 一键跑全 4800 例。

## 4. 并发安全论证（为什么不用 `concurrent: true`）

- 每用例改的是**进程全局态**：ESM loader 拦截注册/回收（`installRuntimeInterception` + dispose）、`NODE_PATH` env + `node:module._initPaths()`、require/ESM 模块缓存、loader.import 队列——同进程内并发用例互相踩（A dispose 掉 B 还在用的拦截 = 假红/假绿）；
- **跨文件跨 worker 是安全并行轴**：forks 池每文件独立进程（本机 16 worker 上限 = min(CPU, 48)），文件内保持 `concurrent: false` 串行——与原文件语义逐字一致；
- 因此并行收益全部来自拆文件（10 家族文件负载均衡后最大单文件 ≈ placement 153 例）。

## 5. 耗时对照（解析器骨架日志法自测；`#fastlane-2s-1101` 统计器单未合入）

> 测量语境：2026-11-02 01:4x 现场重度争用（主树全量自 23:41 在跑 + 邻批 flake-timeout-govern-1101 / slowtop5-costdown-1101 两趟 vitest 并跑，node 进程 50-64 个）——读数偏保守（更慢），结论方向不受影响。首轮车道跑出 33 条 `Test timed out in 5000ms` 假红（0 条 AssertionError；§5.7 在案同款 = lazy-A 批 249 条超时假红），按 §5.7 flake 分诊复跑 + 官方共享宿主 lane 预算 `DSH_COVERAGE_TEST_TIMEOUT_MS=60000`（root config 全项目 test/hook/expect.poll 预算旋钮）转 698/698 全绿——矩阵用例语义零改动。

| 口径 | 总测试秒 | 说明 |
|---|---|---|
| 前 · 官方基线（coverage 分区） | **5604s**（93.4min） | 判据源 = 任务书（10-24 日志） |
| 前 · 原单文件全量（非 coverage，本机自测） | **>5280s 未完跑**（88min 杀停，worker CPU 3514s） | 本批 2026-11-02 01:27 实录；下界口径 |
| 后 · 拆分默认车道墙钟（693 例 + coverage spec） | **329.85s**（tests 分片和 1150.46s） | C2 复跑实录，EXIT=0 |
| 后 · 类型修后复验（C3，同车道） | **206s 墙钟 / 698 passed** | 8 处 TS2532 索引访问收紧（运行时零行为）后复跑；同窗 tsc host aggregate EXIT=0、oxlint 0/0 |
| 后 · 拆分默认车道（首轮，33 条 5s 超时假红） | 566.67s | 争用现场；`DSH_COVERAGE_TEST_TIMEOUT_MS=60000` 官方 lane 预算复跑转绿（§5.7 flake 分诊） |
| 后 · 整包 scoped（验收跑） | **528s 墙钟**（31 文件，1561 passed \| 1 skipped，0 failed） | `pnpm exec vitest run packages/boot/app-boot`，PKG_EXIT=0 |

降幅（C2 车道口径）：对官方基线 = 墙钟 **−94.1%** / tests 分片和 **−79.5%**；对自测下界 = 墙钟 **−93.8%** / 分片和 **−78.2%**——全部口径 ≥60% 验收线。

## 6. 逐文件读数与车道名单（慢车道）

> 判据 = 任一单文件 ≤2s 直接进快速档；达不到则显式入慢车道名单 + 写明点名触发条件。

| 文件 | 用例数 | 实测（C2 专用 lane，争用现场） | 车道 |
|---|---|---|---|
| `sampling-coverage.spec.ts` | 5 | **323ms** | **快速档** |
| `matrix-placement.spec.ts` | 153 | 252.4s | 慢车道 |
| `matrix-workspace-declaration.spec.ts` | 129 | 228.8s | 慢车道 |
| `matrix-root.spec.ts` | 129 | 198.1s | 慢车道 |
| `matrix-node-legacy.spec.ts` | 55 | 96.1s | 慢车道 |
| `matrix-node-comparison.spec.ts` | 59 | 88.1s | 慢车道 |
| `matrix-malformed-declaration.spec.ts` | 45 | 82.1s | 慢车道 |
| `matrix-request-form.spec.ts` | 42 | 71.9s | 慢车道 |
| `matrix-helper-declaration.spec.ts` | 36 | 61.3s | 慢车道 |
| `matrix-node-comparison-files.spec.ts` | 34 | 52.1s | 慢车道 |
| `matrix-node-comparison-explicit.spec.ts` | 11 | 19.2s | 慢车道 |

**慢车道名单（11 项，上面表格全表）**：`packages/boot/app-boot/tests/linked-resolution/` 下除 `sampling-coverage.spec.ts` 外全部 10 个 `matrix-*.spec.ts`。
**点名触发条件（何时必跑慢车道）**：改 `packages/boot/app-boot/src/**`（尤其 `profile.ts`、`profile-resolution/**`）、`packages/boot/app-boot/package.json` 依赖面、或根 `vitest*.config.*` 时，点名跑 `pnpm exec vitest run packages/boot/app-boot/tests/linked-resolution`；其余改动只依赖快速档（coverage spec 秒级）+ 整包 scoped 跑自然捎带。
**与邻批衔接**：隔壁 `slowtop5-costdown-1101` 批在制 `.slowlane.spec.ts` + `run-slow-lane.ts` 慢车道机制（未合入）；其合入后本名单可迁挂官方机制，点名触发条件不变。

## 7. 报告产物（env 门，opt-in）

- `DSH_RESOLUTION_MATRIX_REPORT_DIR=<dir>`：每家族 worker 各写自己的 `matrix-<family>.json/csv/md`（+ 有 comparison 行的家族写 `node-comparison.csv/md`）到 `<dir>/<family>-<random>/`；json 内含 `family / mode(sampled|full) / plannedCases / observedCases / sourceHead`；
- 默认（不设 env）零写盘；
- 与原版差异：单文件整矩阵合并报告 → 按家族分目录报告（跨文件并行写盘互不踩；全量合并视图 = FULL 模式各家族产物并集）。

## 8. 用例 id 方案

保持原全局编号语义：root/placement/workspace/malformed/request/helper 家族沿用 `M####`（按原合并顺序），comparison 家族 `N####`，legacy `L####`——采样行保留其在全网格中的原 id，可与历史产物逐行对表。
