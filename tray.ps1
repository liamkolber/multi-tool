# Liam's Multi-Tool tray host.
#
# Starts the server with no console window at all and puts a tray icon in its
# place — the icon is what you use to open the app, reach the downloads folder,
# or quit, replacing the old "close the minimized window" gesture.
#
# Launched via launch.vbs so not even PowerShell's own console flashes.
# Run with -NoBrowse to start without opening the browser.

param([switch]$NoBrowse)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root    = $PSScriptRoot
$Port    = 8080
$Url     = "http://localhost:$Port"
$LogPath = Join-Path $Root 'server.log'
$IcoPath = Join-Path $Root 'multitool.ico'

# --- Single instance: a second launch should surface the app, not stack up a
# --- second tray icon and a second server.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\LiamsMultiToolTray', [ref]$createdNew)
if (-not $createdNew) {
    if (-not $NoBrowse) { Start-Process $Url }
    return
}

function Test-Port([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try   { $client.Connect('127.0.0.1', $p); return $true }
    catch { return $false }
    finally { $client.Dispose() }
}

# The server process, tracked so Quit can stop it. Runs under a hidden cmd so
# stdout/stderr can be redirected to server.log — losing the startup banner and
# any yt-dlp errors would make this thing undebuggable.
$script:server = $null

function Start-Server {
    if (Test-Port $Port) { return $true }   # already running (e.g. started by hand)

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        [void][System.Windows.Forms.MessageBox]::Show(
            "Node.js was not found on your PATH.`r`nInstall it from https://nodejs.org and run this again.",
            "Liam's Multi-Tool")
        return $false
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName         = $env:ComSpec
    $psi.Arguments        = '/c node server.mjs > "' + $LogPath + '" 2>&1'
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute  = $false
    $psi.CreateNoWindow   = $true
    $script:server = [System.Diagnostics.Process]::Start($psi)

    for ($i = 0; $i -lt 50; $i++) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Stop-Server {
    if ($script:server -and -not $script:server.HasExited) {
        # /T because node is a child of the cmd shell that owns the redirect;
        # killing only the shell would leave the server running headless with
        # no window and no tray icon to stop it.
        & taskkill.exe /PID $script:server.Id /T /F 2>&1 | Out-Null
    }
}

# --- Tray icon ---
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = if (Test-Path $IcoPath) { New-Object System.Drawing.Icon($IcoPath) }
             else { [System.Drawing.SystemIcons]::Application }
$icon.Text    = "Liam's Multi-Tool"
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add('Open Multi-Tool')
$miOpen.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.add_Click({ Start-Process $Url })

$miFolder = $menu.Items.Add('Open downloads folder')
$miFolder.add_Click({
    # Ask the server where downloads actually go — it tracks the last-used
    # folder, which is rarely the default one.
    $dir = $null
    try { $dir = (Invoke-RestMethod "$Url/api/dl/tools" -TimeoutSec 4).data.dir } catch { }
    if (-not $dir) { $dir = Join-Path $Root 'downloads' }
    if (Test-Path $dir) { Start-Process explorer.exe -ArgumentList ('"' + $dir + '"') }
})

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miLog = $menu.Items.Add('View server log')
$miLog.add_Click({
    if (Test-Path $LogPath) { Start-Process notepad.exe -ArgumentList ('"' + $LogPath + '"') }
    else { [void][System.Windows.Forms.MessageBox]::Show('No log yet.', "Liam's Multi-Tool") }
})

$miRestart = $menu.Items.Add('Restart server')
$miRestart.add_Click({
    Stop-Server
    Start-Sleep -Milliseconds 800
    if (Start-Server) { $icon.ShowBalloonTip(2000, "Liam's Multi-Tool", 'Server restarted.', 'Info') }
})

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miQuit = $menu.Items.Add('Quit')
$miQuit.add_Click({
    $icon.Visible = $false
    Stop-Server
    [System.Windows.Forms.Application]::Exit()
})

$icon.ContextMenuStrip = $menu
$icon.add_MouseDoubleClick({ Start-Process $Url })

# --- Go ---
if (-not (Start-Server)) {
    $icon.Visible = $false
    $icon.Dispose()
    $mutex.ReleaseMutex()
    return
}

if (-not $NoBrowse) { Start-Process $Url }

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    # Whatever ends the message loop — Quit, a logoff, a crash — must not leave
    # an orphaned server behind.
    $icon.Visible = $false
    $icon.Dispose()
    Stop-Server
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
