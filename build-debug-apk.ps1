$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$androidRoot = Join-Path $projectRoot "android"
$logPath = Join-Path $projectRoot "android-debug-build.log"

Set-Location $androidRoot

$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:NODE_ENV = "development"

& .\gradlew.bat assembleDebug --no-daemon --max-workers=1 "-PreactNativeArchitectures=arm64-v8a" "-Dorg.gradle.workers.max=1" *> $logPath
exit $LASTEXITCODE
