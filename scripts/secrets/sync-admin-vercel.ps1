# Sync admin app Vercel settings for develop (test) and verify production wiring.
# Usage (from repo root):
#   pwsh scripts/secrets/sync-admin-vercel.ps1
#
# Requires: Vercel CLI (logged in), Doppler CLI (logged in), linked weldsuite-admin.

$ErrorActionPreference = "Stop"
$AdminDir = Join-Path $PSScriptRoot "..\..\apps\web\admin"
$ProjectId = "prj_nNXaLtKSyVkWlvByT3S8ei9Q3Wlq"

Set-Location $AdminDir
Write-Host "Working in $AdminDir"

function Sync-DopplerToVercel {
    param(
        [string]$DopplerKey,
        [string]$VercelKey = $DopplerKey,
        [string]$DopplerConfig,
        [string]$VercelEnv,
        [string]$GitBranch
    )

    try {
        $value = doppler secrets get $DopplerKey --project weldsuite --config $DopplerConfig --plain 2>$null
    } catch {
        Write-Host "  skip $VercelKey (no Doppler key '$DopplerKey' in $DopplerConfig)"
        return
    }
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
        Write-Host "  skip $VercelKey (no Doppler key '$DopplerKey' in $DopplerConfig)"
        return
    }

    if ($GitBranch) {
        $value | npx vercel env add $VercelKey $VercelEnv --git-branch $GitBranch --force --yes | Out-Null
        Write-Host "  set $VercelKey -> $VercelEnv/$GitBranch"
    } else {
        $value | npx vercel env add $VercelKey $VercelEnv --force --yes | Out-Null
        Write-Host "  set $VercelKey -> $VercelEnv"
    }
}

function Set-PublicEnv {
    param(
        [string]$Key,
        [string]$Value,
        [string]$VercelEnv,
        [string]$GitBranch
    )

    npx vercel env add $Key $VercelEnv --git-branch $GitBranch --value $Value --no-sensitive --force --yes | Out-Null
    Write-Host "  set $Key -> $VercelEnv/$GitBranch"
}

Write-Host "`n[1/3] develop-scoped Preview env vars (Doppler test)..."
Set-PublicEnv "REALTIME_WORKER_URL" "https://realtime-test.weldsuite.org" "preview" "develop"
Set-PublicEnv "NEXT_PUBLIC_REALTIME_URL" "wss://realtime-test.weldsuite.org" "preview" "develop"
Set-PublicEnv "REALTIME_REGISTER_OTE" "false" "preview" "develop"

$testSecretMappings = @(
    @{ Doppler = "DATABASE_URL_MASTER"; Vercel = "DATABASE_URL_MASTER" },
    @{ Doppler = "DATABASE_ENCRYPTION_KEY"; Vercel = "DATABASE_ENCRYPTION_KEY" },
    @{ Doppler = "NEON_API_KEY"; Vercel = "NEON_API_KEY" },
    @{ Doppler = "REALTIME_INTERNAL_SECRET"; Vercel = "REALTIME_INTERNAL_SECRET" },
    @{ Doppler = "REALTIME_REGISTER_API_KEY"; Vercel = "REALTIME_REGISTER_API_KEY" },
    @{ Doppler = "REALTIME_REGISTER_CUSTOMER"; Vercel = "REALTIME_REGISTER_CUSTOMER" }
    # Admin Clerk stays on the shared Preview/Production vars (admin instance, not platform Doppler test keys).
)
foreach ($mapping in $testSecretMappings) {
    Sync-DopplerToVercel -DopplerKey $mapping.Doppler -VercelKey $mapping.Vercel -DopplerConfig "test" -VercelEnv "preview" -GitBranch "develop"
}

Write-Host "`n[2/3] admin-test.weldsuite.org domain on develop..."
$domainBody = '{"name":"admin-test.weldsuite.org","gitBranch":"develop"}'
$domainBody | npx vercel api "/v10/projects/$ProjectId/domains" -X POST --input - --silent
Write-Host "  domain request sent"

Write-Host "`n[3/3] redeploy develop preview..."
$json = npx vercel api "/v6/deployments?projectId=$ProjectId&limit=30" 2>&1 | Out-String
$obj = $json | ConvertFrom-Json
$dev = $obj.deployments | Where-Object { $_.meta.githubCommitRef -eq 'develop' } | Select-Object -First 1
if ($dev) {
    npx vercel redeploy $dev.uid --target preview --no-wait | Out-Null
    Write-Host "  redeploy triggered for develop deployment $($dev.uid)"
} else {
    Write-Host "  no develop deployment found; push to develop to deploy"
}

Write-Host "`nDone. Check https://admin-test.weldsuite.org after DNS + build complete."
