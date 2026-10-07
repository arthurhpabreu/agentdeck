$ErrorActionPreference = 'Stop'
$agentdeckRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$agentdeckCargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath $agentdeckCargoBin) { $env:PATH = "$agentdeckCargoBin;$env:PATH" }
Push-Location -LiteralPath $agentdeckRoot
try {
    & corepack pnpm exec tauri build --bundles 'nsis,msi'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
