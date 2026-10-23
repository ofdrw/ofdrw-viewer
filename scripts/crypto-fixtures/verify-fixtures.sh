#!/usr/bin/env bash
# 校验 manifest 中的 SHA-256，并用 ofdrw Java 侧解密/验签/完整性检查全部夹具。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_DIR="${1:-$ROOT/packages/ofdrw-viewer-crypto/test/fixtures/crypto}"
M2_REPO="${M2_REPO:-$ROOT/.cache/m2}"
if [[ -z "${JAVA_HOME:-}" && -x "$ROOT/.cache/jdk21/bin/javac" ]]; then
  export JAVA_HOME="$ROOT/.cache/jdk21"
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "错误：需要 JDK 21（设置 JAVA_HOME，或准备 $ROOT/.cache/jdk21）" >&2
  exit 2
fi
if [[ ! -f "$FIXTURE_DIR/manifest.json" || ! -f "$FIXTURE_DIR/manifest.sha256" ]]; then
  echo "错误：缺少 manifest.json / manifest.sha256：$FIXTURE_DIR" >&2
  exit 2
fi

echo "==> 校验 manifest SHA-256"
cd "$FIXTURE_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c manifest.sha256 >/dev/null
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c manifest.sha256 >/dev/null
else
  echo "错误：需要 sha256sum 或 shasum" >&2
  exit 2
fi

echo "==> 使用 ofdrw Java 侧校验语义"
mvn -B -q -Dmaven.repo.local="$M2_REPO" -f "$ROOT/scripts/crypto-fixtures/pom.xml" \
  compile exec:java -Dexec.args="verify $FIXTURE_DIR"
echo "==> 夹具校验通过"
