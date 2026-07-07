# YTS Library launcher.
# Starts the local server (only if it isn't already running), waits for it to be
# ready, then opens the app in your default browser.
# Run with -NoBrowse to start the server without opening the browser.

param([switch]$NoBrowse)

$ErrorActionPreference = 'SilentlyContinue'

$Port = 8080
$Url  = "http://localhost:$Port"
$Root = $PSScriptRoot

function Test-Port([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try   { $client.Connect('127.0.0.1', $p); return $true }
    catch { return $false }
    finally { $client.Dispose() }
}

if (-not (Test-Port $Port)) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
            "Node.js was not found on your PATH.`r`nInstall it from https://nodejs.org and run this again.",
            'YTS Library')
        return
    }

    # Launch the server in its own minimized window.
    # (Close that "YTS Library Server" window to stop the app.)
    Start-Process -FilePath $env:ComSpec `
        -ArgumentList '/c "title YTS Library Server & node server.mjs"' `
        -WorkingDirectory $Root -WindowStyle Minimized

    # Wait up to ~15s for the server to start accepting connections.
    for ($i = 0; $i -lt 50; $i++) {
        if (Test-Port $Port) { break }
        Start-Sleep -Milliseconds 300
    }
}

if (-not $NoBrowse) { Start-Process $Url }
