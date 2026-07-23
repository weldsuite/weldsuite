# Set Java 17 as the active JDK for React Native development
# Run this script as Administrator in PowerShell

$javaHome = "C:\Program Files\Microsoft\jdk-17.0.17.10-hotspot"

Write-Host "Setting JAVA_HOME to: $javaHome" -ForegroundColor Green

# Set JAVA_HOME for System (requires admin)
try {
    [System.Environment]::SetEnvironmentVariable('JAVA_HOME', $javaHome, 'Machine')
    Write-Host "[OK] JAVA_HOME set successfully (System)" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Failed to set system JAVA_HOME (run as Administrator)" -ForegroundColor Red
    Write-Host "  Setting for current user instead..." -ForegroundColor Yellow
    [System.Environment]::SetEnvironmentVariable('JAVA_HOME', $javaHome, 'User')
    Write-Host "[OK] JAVA_HOME set for current user" -ForegroundColor Green
}

# Update PATH
$javaBin = "$javaHome\bin"
$currentPath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')

if ($currentPath -notlike "*$javaBin*") {
    try {
        # Remove old OpenJDK 25 from path
        $currentPath = $currentPath -replace '[^;]*OpenJDK\\jdk-25\\bin[^;]*;?', ''

        # Add Java 17 to the beginning of PATH
        $newPath = "$javaBin;$currentPath"
        [System.Environment]::SetEnvironmentVariable('Path', $newPath, 'Machine')
        Write-Host "[OK] Added Java 17 to PATH (System)" -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] Failed to update system PATH (run as Administrator)" -ForegroundColor Red
        Write-Host "  Updating user PATH instead..." -ForegroundColor Yellow

        $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath -notlike "*$javaBin*") {
            $userPath = $userPath -replace '[^;]*OpenJDK\\jdk-25\\bin[^;]*;?', ''
            $newUserPath = "$javaBin;$userPath"
            [System.Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
            Write-Host "[OK] Added Java 17 to user PATH" -ForegroundColor Green
        }
    }
} else {
    Write-Host "[OK] Java 17 already in PATH" -ForegroundColor Green
}

# Set for current session
$env:JAVA_HOME = $javaHome
$env:PATH = "$javaBin;$env:PATH"

Write-Host ""
Write-Host "Environment variables updated!" -ForegroundColor Green
Write-Host "JAVA_HOME = $javaHome" -ForegroundColor Cyan
Write-Host ""
Write-Host "Verifying Java version..." -ForegroundColor Yellow
& "$javaHome\bin\java.exe" -version

Write-Host ""
Write-Host "IMPORTANT: Close and reopen your terminal for changes to take effect!" -ForegroundColor Yellow
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Close this terminal" -ForegroundColor White
Write-Host "  2. Open a new terminal" -ForegroundColor White
Write-Host "  3. Run: java -version" -ForegroundColor White
Write-Host "  4. Verify it shows Java 17.0.17" -ForegroundColor White
Write-Host "  5. Then run: npx expo run:android" -ForegroundColor White
