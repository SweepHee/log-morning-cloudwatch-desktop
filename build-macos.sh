#!/usr/bin/env bash
set -euo pipefail

# macOS 개인정보 보호 설정 때문에 Documents 안에서 Node/Rust가 직접 파일을 읽지
# 못하는 환경도 있다. Finder 권한으로 임시 폴더에 소스를 복사해 빌드한 뒤 완성된
# 앱과 DMG만 release/로 가져온다. 원본 소스나 AWS 리소스는 변경하지 않는다.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_parent="$(mktemp -d /tmp/log-morning-release.XXXXXX)"
build_root="$build_parent/$(basename "$script_dir")"
release_dir="$script_dir/release"

cleanup() {
  if [[ -n "${build_parent:-}" && "$build_parent" == /tmp/log-morning-release.* ]]; then
    rm -rf "$build_parent"
  fi
}
trap cleanup EXIT

command -v osascript >/dev/null
command -v npm >/dev/null
command -v cargo >/dev/null
command -v codesign >/dev/null

osascript -e "tell application \"Finder\" to duplicate POSIX file \"$script_dir\" to POSIX file \"$build_parent\" with replacing" >/dev/null

cd "$build_root"
npm ci
npm test
cargo test --manifest-path src-tauri/Cargo.toml

# Apple Developer ID 인증서가 없는 사내/로컬 배포본도 앱 번들 전체에 임시 서명을
# 적용한다. 공증된 배포본은 아니지만 리소스 서명이 깨진 앱이 생성되는 일을 막는다.
APPLE_SIGNING_IDENTITY="-" npm run tauri build -- --bundles app,dmg

app_version="$(npm pkg get version | tr -d '\"')"
app_bundle="$build_root/src-tauri/target/release/bundle/macos/로그 모닝.app"
codesign --verify --deep --strict "$app_bundle"

if [[ -d "$app_bundle" ]]; then
  mv "$app_bundle" "$build_root/src-tauri/target/release/bundle/macos/로그 모닝 $app_version.app"
fi

shopt -s nullglob
artifacts=(
  "$build_root"/src-tauri/target/release/bundle/dmg/*.dmg
  "$build_root"/src-tauri/target/release/bundle/macos/*.app
)

if (( ${#artifacts[@]} == 0 )); then
  echo "빌드 산출물을 찾지 못했습니다." >&2
  exit 1
fi

for artifact in "${artifacts[@]}"; do
  osascript -e "tell application \"Finder\" to duplicate POSIX file \"$artifact\" to POSIX file \"$release_dir\" with replacing" >/dev/null
done

echo "빌드 완료:"
for artifact in "${artifacts[@]}"; do
  echo "  release/$(basename "$artifact")"
done
