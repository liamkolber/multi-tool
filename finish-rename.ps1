# One-shot: finish renaming this project folder from "scraper" to "multi-tool".
#
# The folder cannot be renamed while an editor has it open, so this script
# copies itself to your temp folder, re-launches from there (releasing its own
# handle on the folder), then waits for you to close the VS Code window before
# doing the rename, refreshing the shortcuts and restarting the tray app.
#
#   powershell -ExecutionPolicy Bypass -File .\finish-rename.ps1
#
# Delete this file afterwards — it only needs to run once.

param(
    [string]$OldPath = 'c:\Users\MexiB\Documents\code\scraper',
    [string]$NewName = 'multi-tool',
    [switch]$Relaunched
)

$ErrorActionPreference = 'Stop'

# --- Re-launch from temp so this script isn't itself holding the folder open ---
if (-not $Relaunched) {
    $copy = Join-Path $env:TEMP 'finish-rename.ps1'
    Copy-Item $PSCommandPath $copy -Force
    Start-Process powershell -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$copy`"",
        '-OldPath', "`"$OldPath`"", '-NewName', $NewName, '-Relaunched'
    ) -WorkingDirectory $env:TEMP
    Write-Host 'Continuing in a new window...'
    return
}

Set-Location $env:TEMP   # never stand inside the folder we're about to rename

$parent  = Split-Path $OldPath -Parent
$NewPath = Join-Path $parent $NewName

if (Test-Path $NewPath) { Write-Host "$NewPath already exists — nothing to do."; Read-Host 'Enter to close'; return }
if (-not (Test-Path $OldPath)) { Write-Host "$OldPath is gone — already renamed?"; Read-Host 'Enter to close'; return }

# --- Stop the app so its node/tray processes let go of the folder ---
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='cmd.exe'" |
    Where-Object { $_.CommandLine -match 'tray\.ps1|server\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# --- Wait for the editor to release the folder ---
Write-Host ''
Write-Host '  Close the VS Code window that has "scraper" open.' -ForegroundColor Yellow
Write-Host '  (This window will carry on by itself as soon as you do.)'
Write-Host ''

$renamed = $false
for ($i = 0; $i -lt 150; $i++) {
    try {
        Rename-Item -LiteralPath $OldPath -NewName $NewName -ErrorAction Stop
        $renamed = $true
        break
    } catch {
        Start-Sleep -Seconds 2
        if ($i % 10 -eq 0 -and $i -gt 0) { Write-Host '  still waiting for the folder to be released...' }
    }
}

if (-not $renamed) {
    Write-Host 'Gave up after 5 minutes — something still has the folder open.' -ForegroundColor Red
    Read-Host 'Enter to close'
    return
}
Write-Host "Renamed: $OldPath -> $NewPath" -ForegroundColor Green

# --- Re-point the Desktop / Start Menu shortcuts at the new path ---
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $NewPath 'install-shortcut.ps1')

# --- Point the git remote at the renamed GitHub repo, if it exists ---
Push-Location $NewPath
$newUrl = "https://github.com/liamkolber/$NewName"
git ls-remote $newUrl 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    git remote set-url origin $newUrl
    Write-Host "git remote origin -> $newUrl" -ForegroundColor Green
} else {
    Write-Host "Left the git remote alone: $newUrl does not resolve yet." -ForegroundColor Yellow
    Write-Host "Rename the repo on GitHub, then run:  git remote set-url origin $newUrl"
}
Pop-Location

# --- Bring the app back up ---
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
    -ArgumentList "`"$NewPath\launch.vbs`" -NoBrowse" -WorkingDirectory $NewPath
Start-Sleep -Seconds 5
try {
    Invoke-WebRequest 'http://127.0.0.1:8080/api/tools' -UseBasicParsing -TimeoutSec 5 | Out-Null
    Write-Host 'App restarted on http://localhost:8080' -ForegroundColor Green
} catch {
    Write-Host 'App did not come back up — start it from the Desktop shortcut.' -ForegroundColor Red
}

Write-Host ''
Write-Host "Reopen the project in VS Code from: $NewPath"
Write-Host 'You can delete finish-rename.ps1 now.'
Read-Host 'Enter to close'
