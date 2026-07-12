# 아파트 평면도 시뮬레이터 실행 스크립트
# - 로컬 서버(node)를 띄우고 크롬으로 엽니다. OCR 등 모든 기능이 동작합니다.
# 사용: 이 파일을 우클릭 > "PowerShell에서 실행" 하거나, 터미널에서  ./start.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Host "Node.js 가 필요합니다. https://nodejs.org 에서 설치 후 다시 실행해 주세요." -ForegroundColor Red
  Read-Host "엔터를 누르면 종료합니다"
  exit 1
}

$port = 8765
# 서버를 새 창에서 실행
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $root
Start-Sleep -Milliseconds 1200

$url = "http://localhost:$port/"
$chrome = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) { Start-Process -FilePath $chrome -ArgumentList $url }
else { Start-Process $url }  # 기본 브라우저

Write-Host "서버를 실행하고 브라우저를 열었습니다: $url" -ForegroundColor Green
Write-Host "서버를 종료하려면 새로 열린 node 창에서 Ctrl + C 를 누르세요."
