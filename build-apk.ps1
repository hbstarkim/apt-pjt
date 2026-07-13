# ============================================================
# 안드로이드 APK 빌드 스크립트
# - 웹 자산(index.html 등)을 android/app/src/main/assets/www 로 복사한 뒤
#   Gradle 로 debug APK 를 빌드합니다.
# - 필요 도구: %LOCALAPPDATA%\AndroidBuild\{jdk, gradle, sdk}
#   (JDK 17, Gradle 8.7, Android SDK 34 — 최초 1회 준비)
# - 결과물: android\app\build\outputs\apk\debug\app-debug.apk
# ============================================================
$ErrorActionPreference = "Stop"
$proj = $PSScriptRoot

# 빌드 도구 경로
$tools = "$env:LOCALAPPDATA\AndroidBuild"
$jdk = (Get-ChildItem "$tools\jdk" -Directory | Select-Object -First 1).FullName
$gradleBin = (Get-ChildItem "$tools\gradle" -Directory | Select-Object -First 1).FullName + "\bin\gradle.bat"
if (-not (Test-Path $gradleBin)) { Write-Error "Gradle을 찾을 수 없습니다: $gradleBin"; exit 1 }
$env:JAVA_HOME = $jdk

# 1) 웹 자산 복사 (robocopy /MIR 로 assets/www 동기화)
$www = Join-Path $proj "android\app\src\main\assets\www"
New-Item -ItemType Directory -Force $www | Out-Null
robocopy $proj $www index.html styles.css app.js viewer3d.js autoroom.js /NJH /NJS /NDL | Out-Null
robocopy (Join-Path $proj "vendor") (Join-Path $www "vendor") /MIR /NJH /NJS /NDL | Out-Null
Write-Host "웹 자산 복사 완료 → assets/www"

# 2) Gradle 빌드
& $gradleBin -p (Join-Path $proj "android") assembleDebug --no-daemon
if ($LASTEXITCODE -ne 0) { Write-Error "Gradle 빌드 실패 (exit $LASTEXITCODE)"; exit 1 }

$apk = Join-Path $proj "android\app\build\outputs\apk\debug\app-debug.apk"
if (Test-Path $apk) {
    Write-Host ""
    Write-Host "빌드 성공: $apk"
    Write-Host ("크기: {0:N1} MB" -f ((Get-Item $apk).Length / 1MB))
} else {
    Write-Error "APK 파일이 생성되지 않았습니다."
}
