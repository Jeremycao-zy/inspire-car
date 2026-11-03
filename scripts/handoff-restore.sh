#!/usr/bin/env bash
# ============================================================================
# handoff-restore.sh — 从 Trae 的改动中回滚到交接锚点
#
# 用法：
#   bash scripts/handoff-restore.sh check     # 只看差异，不动任何东西（默认）
#   bash scripts/handoff-restore.sh soft      # 丢弃未提交改动，保留 Trae 的提交
#   bash scripts/handoff-restore.sh hard      # 彻底回到 handoff-2026-11-03（提交也丢）
#   bash scripts/handoff-restore.sh backup    # 回滚前先把当前状态另存一个分支
#
# 设计原则：默认只读。任何破坏性操作都必须显式传参，且先自动备份。
# ============================================================================

set -euo pipefail

ANCHOR="handoff-2026-11-03"
MODE="${1:-check}"

cd "$(dirname "$0")/.."

# --- 前置检查 ---
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "✗ 当前目录不是 git 仓库：$(pwd)"
  exit 1
fi

if ! git rev-parse "$ANCHOR" >/dev/null 2>&1; then
  echo "✗ 找不到锚点 tag '$ANCHOR'"
  echo "  可用的 tag："; git tag -l | sed 's/^/    /'
  echo "  若 tag 丢失，可从 GitHub 恢复："
  echo "    git fetch --tags origin"
  exit 1
fi

# 注意：$ANCHOR 是 annotated tag，必须用 ^{commit} peel 到真实提交，
# 否则拿到的是 tag 对象自身的 SHA，会和 HEAD 永远不相等。
ANCHOR_SHA=$(git rev-parse --short "${ANCHOR}^{commit}")
ANCHOR_COMMIT=$(git rev-parse "${ANCHOR}^{commit}")

echo "============================================================"
echo " 交接锚点：$ANCHOR ($ANCHOR_SHA)"
git --no-pager log -1 --format=' 提交时间：%ci%n 提交说明：%s' "$ANCHOR"
echo "============================================================"
echo

case "$MODE" in

  check)
    echo "【只读检查】当前 HEAD：$(git rev-parse --short HEAD) ($(git branch --show-current))"
    echo
    if [ "$(git rev-parse HEAD)" = "$ANCHOR_COMMIT" ]; then
      echo "✓ 当前与锚点完全一致，没有任何偏离。"
    else
      echo "⚠ 当前已偏离锚点。差异如下："
      echo
      echo "--- 提交差异（锚点之后新增）---"
      git --no-pager log --oneline "$ANCHOR..HEAD" | head -30 || true
      echo
      echo "--- 改动文件统计 ---"
      git --no-pager diff --stat "$ANCHOR"..HEAD | tail -30 || true
    fi
    echo
    echo "--- 未提交改动 ---"
    if [ -z "$(git status --porcelain)" ]; then
      echo "  无"
    else
      git --no-pager status --short | head -40
    fi
    echo
    echo "如需回滚："
    echo "  bash scripts/handoff-restore.sh backup   # 先另存当前状态"
    echo "  bash scripts/handoff-restore.sh soft     # 只丢未提交改动"
    echo "  bash scripts/handoff-restore.sh hard     # 彻底回到锚点"
    ;;

  backup)
    SAVED="pre-restore-$(date +%Y%m%d-%H%M%S)"
    git branch "$SAVED" HEAD
    echo "✓ 当前状态已存为分支：$SAVED"
    echo "  查看：git log --oneline $SAVED -5"
    echo "  恢复：git checkout $SAVED"
    echo
    echo "如需推到 GitHub 长期保留：git push origin $SAVED"
    ;;

  soft)
    SAVED="pre-restore-$(date +%Y%m%d-%H%M%S)"
    git branch "$SAVED" HEAD 2>/dev/null || true
    echo "① 已自动备份当前状态到分支：$SAVED"
    git reset --hard HEAD >/dev/null
    git clean -fd -e node_modules -e .env -e .cache -e dist >/dev/null
    echo "② 已丢弃全部未提交改动（保留 node_modules / .env / .cache / dist）"
    echo "✓ HEAD 仍是 $(git rev-parse --short HEAD)，提交历史未动"
    ;;

  hard)
    SAVED="pre-restore-$(date +%Y%m%d-%H%M%S)"
    git branch "$SAVED" HEAD 2>/dev/null || true
    echo "① 已自动备份当前状态到分支：$SAVED（后悔时 git checkout $SAVED）"
    git reset --hard "$ANCHOR_COMMIT"
    git clean -fd -e node_modules -e .env -e .cache -e dist >/dev/null
    echo "② 已重置到锚点，并清理未跟踪文件"
    echo
    echo "当前 HEAD：$(git rev-parse --short HEAD) $(git branch --show-current)"
    echo "工作区：$([ -z "$(git status --porcelain)" ] && echo '干净 ✓' || echo '仍有改动')"
    echo
    echo "建议随后执行：npm install && npm run build"
    ;;

  *)
    echo "未知模式：$MODE"
    echo "可用：check | soft | hard | backup"
    exit 1
    ;;
esac
