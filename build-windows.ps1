$ErrorActionPreference = "Stop"

# Windows에서도 별도 서버 없이 같은 Rust AWS SDK와 WebView2 UI를 사용한다.
# Access Key는 앱에 포함하지 않으며 현재 사용자의 AWS 프로필을 그대로 읽는다.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

npm ci
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build

Write-Host ""
Write-Host "Windows 설치 파일 빌드 완료:"
Get-ChildItem -Recurse "src-tauri\target\release\bundle" |
    Where-Object { $_.Extension -in ".msi", ".exe" } |
    ForEach-Object { Write-Host "  $($_.FullName)" }
