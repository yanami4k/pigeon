#!/bin/sh
# 延续式跑批 strands 镜像 v5 的 lint 层（148 修订"还原人当时的 CI"）：人的 CI 每次按当时能装到的最新版本装依赖，
# 故 lint 环境按每个要测的提交自己的提交时间解析（uv 的 --exclude-newer），Python 3.10，依赖为该提交 pyproject 的
# lint 依赖（stream_env.py requirements … lint：项目依赖、all 与 bidi-all 可选依赖、hatch-test 与 hatch-static-analysis
# 环境的依赖，含 mypy、ruff 的版本约束）。解析结果逐字相同的合为一套，装在 /opt/lint/sets/<结果摘要>；
# /opt/stream/lint-map.txt 每行"提交 套名"，select-lint <提交> 据此切换 /opt/lint/current。运行环境不动。
# 输入（构建上下文）：lint/<提交>.toml 与 lint-dates.txt（每行"提交 提交时间"）。构建时联网
set -eu
cd /opt/stream
mkdir -p lint-locks /opt/lint/sets
: > lint-map.txt
while read -r commit date; do
  [ -n "$commit" ] || continue
  /usr/local/bin/python3 stream_env.py requirements "lint/$commit.toml" lint > "lint-locks/$commit.in"
  uv pip compile -q --python 3.10 --python-platform linux --exclude-newer "$date" --no-header --no-annotate \
    "lint-locks/$commit.in" -o "lint-locks/$commit.txt"
  set=$(sha256sum "lint-locks/$commit.txt" | cut -c1-12)
  if [ ! -d "/opt/lint/sets/$set" ]; then
    uv venv -q --python 3.10 "/opt/lint/sets/$set"
    uv pip install -q --python "/opt/lint/sets/$set/bin/python" -r "lint-locks/$commit.txt"
    uv pip freeze --python "/opt/lint/sets/$set/bin/python" > "/opt/lint/sets/$set/freeze.txt"
  fi
  echo "$commit $set" >> lint-map.txt
done < lint-dates.txt
printf '#!/bin/sh\nexec /usr/local/bin/python3 /opt/stream/stream_env.py select-lint "$@"\n' > select-lint
chmod +x select-lint
echo "lint 层：$(wc -l < lint-map.txt) 个提交，$(ls /opt/lint/sets | wc -l) 套"
