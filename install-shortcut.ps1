# Creates (or refreshes) "Liam's Multi-Tool" shortcuts on your Desktop and in the
# Start Menu that start the local server and open the app in your browser. Re-run
# this if you move the project folder.

$ErrorActionPreference = 'Stop'

$Root         = $PSScriptRoot
$LauncherPath = Join-Path $Root 'launch.vbs'
$IcoPath      = Join-Path $Root 'multitool.ico'
$WScriptExe   = Join-Path $env:SystemRoot 'System32\wscript.exe'

# --- Generate a themed icon: blue rounded square with a white 2x2 tool grid ---
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

    # Four rounded tiles — a launcher grid, one tile per tool.
    $tile = 46; $gap = 18
    $originX = ($size - (2 * $tile + $gap)) / 2
    $originY = $originX
    foreach ($col in 0, 1) {
        foreach ($row in 0, 1) {
            $x = $originX + $col * ($tile + $gap)
            $y = $originY + $row * ($tile + $gap)
            $tr = 14
            $tp = New-Object System.Drawing.Drawing2D.GraphicsPath
            $tp.AddArc($x,                 $y,                 $tr, $tr, 180, 90)
            $tp.AddArc($x + $tile - $tr,   $y,                 $tr, $tr, 270, 90)
            $tp.AddArc($x + $tile - $tr,   $y + $tile - $tr,   $tr, $tr,   0, 90)
            $tp.AddArc($x,                 $y + $tile - $tr,   $tr, $tr,  90, 90)
            $tp.CloseFigure()
            $g.FillPath([System.Drawing.Brushes]::White, $tp)
            $tp.Dispose()
        }
    }
    $g.Dispose()

    # Write the .ico by hand. Icon.Save(bmp.GetHicon()) round-trips through a
    # legacy HICON and flattens the background to silver, so instead we wrap the
    # bitmap's own DIB in an icon directory. A BMP payload (rather than a PNG
    # one) keeps System.Drawing able to read it back — tray.ps1 does exactly
    # that to put the icon in the notification area.
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmpBytes = $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()

    # Drop the 14-byte BITMAPFILEHEADER; an icon entry starts at the DIB header.
    $dib = New-Object 'byte[]' ($bmpBytes.Length - 14)
    [Array]::Copy($bmpBytes, 14, $dib, 0, $dib.Length)

    # Icons store the colour rows and a 1-bit AND mask stacked together, so the
    # recorded height is doubled. The mask stays all-zero: alpha does the work.
    $maskBytes = ($size / 8) * $size
    [Array]::Copy([BitConverter]::GetBytes([int]($size * 2)), 0, $dib, 8, 4)
    [Array]::Copy([BitConverter]::GetBytes([uint32]($size * $size * 4 + $maskBytes)), 0, $dib, 20, 4)

    $payload = New-Object 'byte[]' ($dib.Length + $maskBytes)
    [Array]::Copy($dib, $payload, $dib.Length)

    $fs = [System.IO.File]::Create($IcoPath)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([uint16]0)                  # reserved
    $bw.Write([uint16]1)                  # type: icon
    $bw.Write([uint16]1)                  # image count
    $bw.Write([byte]0)                    # width  (0 means 256)
    $bw.Write([byte]0)                    # height (0 means 256)
    $bw.Write([byte]0)                    # palette size
    $bw.Write([byte]0)                    # reserved
    $bw.Write([uint16]1)                  # colour planes
    $bw.Write([uint16]32)                 # bits per pixel
    $bw.Write([uint32]$payload.Length)    # payload size
    $bw.Write([uint32]22)                 # payload offset (6 + 16)
    $bw.Write($payload)
    $bw.Flush(); $bw.Dispose(); $fs.Dispose()
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
    $sc.Description      = "Start Liam's Multi-Tool in the tray and open it in your browser"
    if ($IcoPath -and (Test-Path $IcoPath)) { $sc.IconLocation = "$IcoPath,0" }
    $sc.Save()
    Write-Host "Shortcut created: $LnkPath"
}

# 'Programs' is the current user's Start Menu\Programs folder (no admin needed).
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop'))  'Liams Multi-Tool.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Liams Multi-Tool.lnk')
)
foreach ($t in $targets) { New-AppShortcut $t }

# The app used to be called "Media Library"; clear away those old shortcuts so
# you aren't left with two icons pointing at the same thing.
$stale = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop'))  'Media Library.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Media Library.lnk')
)
foreach ($s in $stale) {
    if (Test-Path $s) { Remove-Item $s -Force; Write-Host "Removed old shortcut: $s" }
}
