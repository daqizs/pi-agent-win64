$ErrorActionPreference = 'Stop'

function Wait-IfNeeded {
    param([int]$ArgCount)
    if ($env:PI_NO_PAUSE -ieq '1') { return }
    if ($ArgCount -eq 0 -and -not [Console]::IsInputRedirected) {
        Write-Host -NoNewline 'Press any key to continue . . . '
        [void][System.Console]::ReadKey($true)
        Write-Host ''
    }
}

$argCount = $args.Count
$piPs1 = Join-Path $env:USERPROFILE '.pi\agent\bin\pi.ps1'
$piCmd = Join-Path $env:USERPROFILE '.pi\agent\bin\pi.cmd'
$piExe = (Get-Command pi -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)

$launcher = $null
if (Test-Path -LiteralPath $piPs1 -PathType Leaf) { $launcher = $piPs1 }
elseif (Test-Path -LiteralPath $piCmd -PathType Leaf) { $launcher = $piCmd }
elseif ($piExe) { $launcher = $piExe }

if (-not $launcher) {
    Write-Host '[ERROR] Pi CLI not found. Install @earendil-works/pi-coding-agent first.'
    Wait-IfNeeded -ArgCount $argCount
    exit 1
}

$env:PYTHONUTF8 = '1'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    $Host.UI.RawUI.WindowTitle = "Pi Agent (PowerShell $($PSVersionTable.PSVersion))"
} catch {}

$ErrorActionPreference = 'Continue'
& $launcher @args
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }

if ($exitCode -ne 0) {
    Write-Host "[Pi exited with code $exitCode]"
}

Wait-IfNeeded -ArgCount $argCount
exit $exitCode
