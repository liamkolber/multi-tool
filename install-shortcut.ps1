# Creates (or refreshes) "Media Library" shortcuts on your Desktop and in the
# Start Menu that start the local server and open the app in your browser. Re-run
# this if you move the project folder.

$ErrorActionPreference = 'Stop'

$Root         = $PSScriptRoot
$LauncherPath = Join-Path $Root 'launch.vbs'
$IcoPath      = Join-Path $Root 'media.ico'
$WScriptExe   = Join-Path $env:SystemRoot 'System32\wscript.exe'

# --- Generate a themed icon: blue rounded square with a white play triangle ---
try {
    Add-Type -AssemblyName System.Drawing
    $size = 256
    $bmp  = New-Object System.Drawing.Bitmap($size, $size)
    $g    = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $m = 16; $r = 48
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($m,             $m,             $r, $r, 180, 90)
    $path.AddArc($size-$m-$r,    $m,             $r, $r, 270, 90)
    $path.AddArc($size-$m-$r,    $size-$m-$r,    $r, $r,   0, 90)
    $path.AddArc($m,             $size-$m-$r,    $r, $r,  90, 90)
    $path.CloseFigure()
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(91, 140, 255))
    $g.FillPath($bg, $path)

    $tri = New-Object 'System.Drawing.PointF[]' 3
    $tri[0] = New-Object System.Drawing.PointF([float]104, [float]86)
    $tri[1] = New-Object System.Drawing.PointF([float]104, [float]170)
    $tri[2] = New-Object System.Drawing.PointF([float]178, [float]128)
    $g.FillPolygon([System.Drawing.Brushes]::White, $tri)
    $g.Dispose()

    $hicon = $bmp.GetHicon()
    $icon  = [System.Drawing.Icon]::FromHandle($hicon)
    $fs    = [System.IO.File]::Create($IcoPath)
    $icon.Save($fs)
    $fs.Close(); $icon.Dispose(); $bmp.Dispose()
    Write-Host "Icon written: $IcoPath"
} catch {
    Write-Host "Icon generation skipped ($($_.Exception.Message)); using default icon."
    $IcoPath = $null
}

# --- Create the shortcuts (Desktop + Start Menu) ---
$shell = New-Object -ComObject WScript.Shell

function New-AppShortcut([string]$LnkPath) {
    $sc = $shell.CreateShortcut($LnkPath)
    # wscript runs the launcher with no console at all, so the app appears only
    # as a tray icon. The window style below is irrelevant to it.
    $sc.TargetPath       = $WScriptExe
    $sc.Arguments        = "`"$LauncherPath`""
    $sc.WorkingDirectory = $Root
    $sc.WindowStyle      = 1
    $sc.Description      = 'Start Media Library in the tray and open it in your browser'
    if ($IcoPath -and (Test-Path $IcoPath)) { $sc.IconLocation = "$IcoPath,0" }
    $sc.Save()
    Write-Host "Shortcut created: $LnkPath"
}

# 'Programs' is the current user's Start Menu\Programs folder (no admin needed).
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop'))  'Media Library.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Media Library.lnk')
)
foreach ($t in $targets) { New-AppShortcut $t }
