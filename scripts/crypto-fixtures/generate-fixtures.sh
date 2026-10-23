#!/usr/bin/env bash
# 生成 packages/ofdrw-viewer-crypto/test/fixtures/crypto 下的全部受保护 OFD 样例、
# 测试证书与 manifest。要求 JDK 21 与已构建到工作区本地仓库的 ofdrw 2.4.0。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_DIR="${1:-$ROOT/packages/ofdrw-viewer-crypto/test/fixtures/crypto}"
BASE_OFD="${2:-$ROOT/references/ofdrw/ofdrw-crypto/src/test/resources/hello.ofd}"
M2_REPO="${M2_REPO:-$ROOT/.cache/m2}"
if [[ -z "${JAVA_HOME:-}" && -x "$ROOT/.cache/jdk21/bin/javac" ]]; then
  export JAVA_HOME="$ROOT/.cache/jdk21"
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "错误：需要 JDK 21（设置 JAVA_HOME，或准备 $ROOT/.cache/jdk21）" >&2
  exit 2
fi
if [[ ! -d "$M2_REPO/org/ofdrw/ofdrw-sign/2.4.0" ]]; then
  echo "错误：本地 Maven 仓库缺少 ofdrw 2.4.0：$M2_REPO" >&2
  echo "请先按 scripts/crypto-fixtures/README.md 构建 references/ofdrw" >&2
  exit 2
fi
if [[ ! -f "$BASE_OFD" ]]; then
  echo "错误：基准 OFD 不存在：$BASE_OFD" >&2
  exit 2
fi

MVN=(mvn -B -q -Dmaven.repo.local="$M2_REPO" -f "$ROOT/scripts/crypto-fixtures/pom.xml")
mkdir -p "$FIXTURE_DIR"
if [[ ! -f "$FIXTURE_DIR/certs/root-ca.crt.pem" ]]; then
  echo "==> 首次生成测试证书"
  "${MVN[@]}" compile exec:java -Dexec.args="generate-certs $FIXTURE_DIR"
fi
echo "==> 生成受保护 OFD 样例"
"${MVN[@]}" compile exec:java -Dexec.args="generate $FIXTURE_DIR $BASE_OFD"
echo "==> 生成完成：$FIXTURE_DIR"
