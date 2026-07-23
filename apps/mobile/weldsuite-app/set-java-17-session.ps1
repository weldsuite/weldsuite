# Set Java 17 for current PowerShell session only (no admin required)
# Source this script: . .\set-java-17-session.ps1

$javaHome = "C:\Program Files\Microsoft\jdk-17.0.17.10-hotspot"
$javaBin = "$javaHome\bin"

Write-Host "Setting Java 17 for current session..." -ForegroundColor Green

$env:JAVA_HOME = $javaHome
$env:PATH = "$javaBin;$env:PATH"

Write-Host "[OK] JAVA_HOME = $javaHome" -ForegroundColor Green
Write-Host "[OK] Added to PATH for this session" -ForegroundColor Green
Write-Host ""
Write-Host "Verifying Java version..." -ForegroundColor Yellow
java -version

Write-Host ""
Write-Host "Java 17 is now active for this terminal session!" -ForegroundColor Green
Write-Host "You can now run: npx expo run:android" -ForegroundColor Cyan
