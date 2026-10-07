param(
    [string]$Owner = 'arthurhpabreu',
    [string]$Repository = 'agentdeck'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $projectRoot
try {
    $account = & gh api user --jq .login
    if ($LASTEXITCODE -ne 0) { throw 'Authenticate GitHub CLI with gh auth login first.' }
    if ($account.Trim() -ne $Owner) { throw "GitHub CLI is signed in as $account. Run gh auth login --hostname github.com --web and sign in as $Owner before publishing." }
    $changes = & git status --porcelain
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Commit the reviewed project files before publishing.' }
    & corepack pnpm check:repo
    if ($LASTEXITCODE -ne 0) { throw 'Repository hygiene check failed.' }
    $target = "$Owner/$Repository"
    $ErrorActionPreference = 'Continue'
    $response = & gh api "repos/$target" 2>&1
    $apiExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($apiExit -ne 0) {
        if (($response -join ' ') -notmatch 'HTTP 404') { throw "Unable to inspect repository: $response" }
        & gh repo create $target --private --description 'Desktop workspace for coding agents, task flows and local knowledge graphs'
        if ($LASTEXITCODE -ne 0) { throw 'Private repository creation failed.' }
    }
    $metadata = & gh repo view $target --json isPrivate,url
    if ($LASTEXITCODE -ne 0) { throw 'Unable to verify repository visibility.' }
    $repo = $metadata | ConvertFrom-Json
    if (-not $repo.isPrivate) { throw 'The destination must be private. No files were pushed.' }
    $url = "https://github.com/$target.git"
    $remotes = & git remote
    if ($remotes -contains 'origin') {
        $origin = & git remote get-url origin
        if ($origin.Trim() -ne $url) { throw "Unexpected origin: $origin" }
    } else { & git remote add origin $url }
    if ($LASTEXITCODE -ne 0) { throw 'Unable to configure the repository remote.' }
    & gh auth setup-git
    if ($LASTEXITCODE -ne 0) { throw 'Unable to configure GitHub authentication.' }
    & git push --set-upstream origin main
    if ($LASTEXITCODE -ne 0) { throw 'Push failed.' }
    Write-Output "Published privately: $($repo.url)"
} finally { Pop-Location }
