$ErrorActionPreference = 'Stop'

$kitRoot = Split-Path -Parent $PSScriptRoot
$agentDir = Join-Path $env:USERPROFILE '.pi\agent'

Write-Host '=== Pi Agent Win64 Kit Installer ==='
Write-Host "Target: $agentDir"

foreach ($sub in @('extensions', 'lib', 'prompts', 'data')) {
    New-Item -ItemType Directory -Path (Join-Path $agentDir $sub) -Force | Out-Null
}

Copy-Item -Path (Join-Path $kitRoot 'extensions\*.ts') -Destination (Join-Path $agentDir 'extensions') -Force
Copy-Item -Path (Join-Path $kitRoot 'lib\*.mjs') -Destination (Join-Path $agentDir 'lib') -Force
if (Test-Path (Join-Path $kitRoot 'prompts')) {
    Copy-Item -Path (Join-Path $kitRoot 'prompts\*.md') -Destination (Join-Path $agentDir 'prompts') -Force
}

foreach ($cfg in @('tool-hud.json', 'smart-router.json', 'ttsr-rules.json')) {
    $src = Join-Path $kitRoot "config\$cfg"
    $dst = Join-Path $agentDir $cfg
    if ((Test-Path $src) -and -not (Test-Path $dst)) {
        Copy-Item -Path $src -Destination $dst -Force
        Write-Host "[NEW] $cfg"
    }
}

Write-Host ''
Write-Host 'Environment checks:'
foreach ($tool in @('pwsh', 'node', 'git', 'ast-grep')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) { Write-Host "  [OK]   $tool -> $($cmd.Source)" }
    else { Write-Host "  [MISS] $tool (optional/recommended)" }
}

Write-Host ''
Write-Host 'Done! Restart Pi or run win64\start-pi.bat to launch in PowerShell 7 (Admin).'
