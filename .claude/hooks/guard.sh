#!/bin/sh
# 훅 입구 (desktop 의 .claude/hooks/guard.sh 와 같은 모양) — 검사가 필요한 입력일 때만 node 검사 스크립트를 띄운다:
# git push · gh pr merge 명령, 또는 catalog.json · dist/ 를 가리키는 파일 편집.
# 훅 셸(/bin/sh)은 로그인 설정을 읽지 않아 nvm 등으로 깐 node 가 PATH 에 없을 수 있다 — 여러 곳에서 찾고,
# 그래도 없으면 그 명령을 막는다(종료 코드 2). 검사 없이 통과되는 일이 없게 한다.
#   sh .claude/hooks/guard.sh <검사 이름>   (예: block-protected-push)
set -u
script="$1"
input=$(cat)

case "$input" in
  *git*push* | *gh*pr*merge* | *catalog.json* | *dist/*) ;;
  *) exit 0 ;;
esac

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for candidate in "${NVM_BIN:-}/node" "$HOME/.volta/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  newest=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1)
  if [ -n "$newest" ] && [ -x "$newest" ]; then echo "$newest"; return; fi
}

node_bin=$(find_node)
if [ -z "$node_bin" ]; then
  echo "자동 검사($script)를 돌릴 node 를 찾지 못해 이 명령을 막았습니다. node 를 PATH 에 두거나 nvm·Homebrew 로 설치해 주세요." >&2
  exit 2
fi

# 검사 스크립트가 띄우는 npm·gh·git 도 찾을 수 있게 — node 가 있는 폴더(npm 이 같이 있다)와 Homebrew 폴더를 앞에 붙인다
PATH="$(dirname "$node_bin"):/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
dir=$(dirname "$0")
printf '%s' "$input" | "$node_bin" "$dir/$script.mjs"
