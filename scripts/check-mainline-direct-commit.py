#!/usr/bin/env python3
"""mainline direct-commit gate — 拦「主线直提」，参数全取自 repos.yaml（经 repos-registry 唯一读口）。

作用域 = registry `scopes.dsh`（当前仓在册才生效，仓清单不写死）；
主线名 = 该仓 `mainline`（脚本零分支名/仓名字面，harness=master、dsh-web=dev 随 yaml 走）；
仓身份 = git common-dir 父目录 对 registry `path`（主 checkout 与 worktree 同判）。

判定序（快路径在前）：
  ① 非主线分支 / 游离头 → 放行（worktree 会话零爆半径；rebase 序列游离头亦放行——本闸面 = 分支直提）
  ② MERGE_HEAD 在场（合入含冲突收尾） → 放行
  ③ DSH_INTEGRATE=1（合入/构建/安装窗口旗标） → 放行 + stdout 留痕
  ④ 否则 → 拦：stderr 三出路 + 判定档指针，exit 1

安装态 = 本地 git config `dsh.registry`（install-mainline-gate.py 从 registry 写入，机器态不入库）：
  config 缺失（外来克隆/未装） → 放行 + warn；config 在但 registry 读取失败 → exit 1 fail-closed。
退出码：0 = 放行；1 = 拦 / 已装但读取失败。
"""
from __future__ import annotations

import importlib.util as ilu
import os
import subprocess
import sys


def _reconfigure_stdio() -> None:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )


def _out(*args: str) -> str:
    return (_git(*args).stdout or "").strip()


def _load_registry(path: str):
    spec = ilu.spec_from_file_location("dsh_mainline_gate_registry", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载读口: {path}")
    mod = ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _norm(p: str) -> str:
    return os.path.normcase(os.path.realpath(p))


def main() -> int:
    _reconfigure_stdio()

    # 安装态：registry 读口位置（本地 config，机器态不入库）
    reg = _out("config", "--get", "dsh.registry")
    if not reg:
        print("[gate] dsh.registry 未配置（未安装/外来克隆）→ 放行", file=sys.stderr)
        return 0
    if not os.path.isfile(reg):
        print(f"[gate] dsh.registry 指向不存在的文件: {reg} → 拦（fail-closed；"
              "重跑 python scripts/git/install-mainline-gate.py）", file=sys.stderr)
        return 1
    try:
        rr = _load_registry(reg)
        data = rr.load_repos()
    except Exception as e:
        print(f"[gate] repos-registry 读取失败 → 拦（fail-closed）: {e}", file=sys.stderr)
        return 1

    # 仓身份 = git common-dir 父目录（主 checkout 与 worktree 同判）
    cd = _out("rev-parse", "--path-format=absolute", "--git-common-dir")
    if not cd:
        print("[gate] git 上下文不可用 → 拦（fail-closed）", file=sys.stderr)
        return 1
    root = os.path.dirname(os.path.abspath(cd))

    scope = ((data.get("scopes") or {}).get("dsh")) or []
    mainline = None
    for rid in scope:
        try:
            cfg = rr.load_repo(rid)
        except Exception:
            continue
        p = str(cfg.get("path") or "")
        if p and _norm(p) == _norm(root):
            mainline = str(cfg.get("mainline") or "")
            break
    if not mainline:
        return 0  # 不在闸作用域（m-note / 未注册仓 / 未知仓）

    # ① 快路径：非主线分支、游离头
    branch = _out("symbolic-ref", "--short", "-q", "HEAD")
    if not branch or branch != mainline:
        return 0

    # ② 合入进行中（含冲突收尾提交）
    mh = _out("rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD")
    if mh and os.path.exists(mh):
        return 0

    # ③ 旗标窗口（放行留痕）
    if os.environ.get("DSH_INTEGRATE"):
        print(f"[gate] DSH_INTEGRATE 豁免放行（直提 {root} @ {branch}，留痕）")
        return 0

    # ④ 拦
    print(f"⛔ mainline 直提被拦：{root} @ {branch}"
          "（governance §2.1：宿主 checkout 常态干净，唯一合法写入者 = 合入动作）",
          file=sys.stderr)
    print("   出路：① git merge 合入 ② 先落 wt/* 分支再合 ③ 合入/构建/安装窗口 DSH_INTEGRATE=1",
          file=sys.stderr)
    print("   指针：content/tech/ai/dsh/repo-rule-scope-harness-1126.md（三档结论）",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
