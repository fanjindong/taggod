#!/usr/bin/env bash
set -euo pipefail

target_branch="${TARGET_BRANCH:-master}"
remote_name="${REMOTE_NAME:-origin}"

显示用法() {
  cat <<'EOF'
用法：
  scripts/发布标签.sh
  scripts/发布标签.sh --dry-run

说明：
  默认读取 manifest.json 中的 version，创建并推送 v<version> 标签。
  可通过环境变量覆盖目标分支和远端：
    TARGET_BRANCH=main REMOTE_NAME=origin scripts/发布标签.sh
EOF
}

dry_run=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=true
      ;;
    -h|--help)
      显示用法
      exit 0
      ;;
    *)
      echo "未知参数：$arg" >&2
      显示用法 >&2
      exit 2
      ;;
  esac
done

执行命令() {
  echo "+ $*"

  if [[ "$dry_run" == "true" ]]; then
    return 0
  fi

  "$@"
}

确认命令存在() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少必要命令：$command_name" >&2
    exit 1
  fi
}

确认命令存在 git
确认命令存在 node

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "工作区不干净，请先提交、暂存或清理本地改动后再发布标签。" >&2
  git status --short >&2
  exit 1
fi

echo "同步 ${remote_name}/${target_branch}"
执行命令 git fetch "$remote_name" --prune --tags
执行命令 git switch "$target_branch"
执行命令 git pull --ff-only "$remote_name" "$target_branch"

version="$(node -e "const fs = require('fs'); const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8')); if (!manifest.version) { throw new Error('manifest.json 缺少 version'); } console.log(manifest.version);")"
tag_name="v${version}"

echo "准备发布标签：${tag_name}"

if git rev-parse -q --verify "refs/tags/${tag_name}" >/dev/null; then
  echo "本地已存在标签：${tag_name}" >&2
  exit 1
fi

if git ls-remote --exit-code --tags "$remote_name" "$tag_name" >/dev/null 2>&1; then
  echo "远端已存在标签：${tag_name}" >&2
  exit 1
fi

echo "执行发布前校验"
执行命令 node --check background.js
执行命令 node --check popup.js
执行命令 node scripts/校验插件.js
执行命令 git diff --check

if [[ "$dry_run" == "true" ]]; then
  echo "演练完成：将会创建并推送标签 ${tag_name}"
  exit 0
fi

git tag "$tag_name"
git push "$remote_name" "$tag_name"

echo "标签已推送：${tag_name}"
