# Fetches the two binaries the Download tab needs into .\bin (gitignored), so
# nothing is installed system-wide. Re-run it to update them.
#
#   yt-dlp  - the extractor/downloader itself
#   ffmpeg  - merges the separate video and audio streams YouTube serves
#             above 720p; without it the tab is capped at 720p
#
# Prefer a system-wide install instead? These do the same job:
#   winget install yt-dlp.yt-dlp
#   winget install Gyan.FFmpeg

$ErrorActionPreference = 'Stop'
$BinDir = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# TLS 1.2 for Windows PowerShell 5.1, whose default can be too old for GitHub.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-File($Url, $OutFile, $Label) {
    Write-Host "  downloading $Label ..." -ForegroundColor Cyan
    $progressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

Write-Host "`nFetching downloader tools into $BinDir`n"

# --- yt-dlp: a single self-contained exe ---
$ytdlp = Join-Path $BinDir 'yt-dlp.exe'
try {
    Get-File 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' $ytdlp 'yt-dlp'
    Write-Host "  yt-dlp  OK" -ForegroundColor Green
} catch {
    Write-Host "  yt-dlp  FAILED - $($_.Exception.Message)" -ForegroundColor Red
}

# --- ffmpeg: shipped as a zip; we only want ffmpeg.exe out of it ---
$ffmpeg = Join-Path $BinDir 'ffmpeg.exe'
if (Test-Path $ffmpeg) {
    Write-Host "  ffmpeg  already present, skipping" -ForegroundColor DarkGray
} else {
    $zip = Join-Path $env:TEMP 'ffmpeg-essentials.zip'
    $tmp = Join-Path $env:TEMP 'ffmpeg-extract'
    try {
        Get-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip 'ffmpeg (~80 MB)'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $found = Get-ChildItem -Path $tmp -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
        if ($found) {
            Copy-Item $found.FullName $ffmpeg -Force
            Write-Host "  ffmpeg  OK" -ForegroundColor Green
        } else {
            Write-Host "  ffmpeg  FAILED - ffmpeg.exe not found in the archive" -ForegroundColor Red
        }
    } catch {
        Write-Host "  ffmpeg  FAILED - $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "          try: winget install Gyan.FFmpeg" -ForegroundColor DarkGray
    } finally {
        Remove-Item $zip -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- deno: yt-dlp's JavaScript runtime for YouTube extraction ---
# Without one, yt-dlp warns that "some formats may be missing" — the best
# stream can silently drop out of the list, which defeats the point.
$deno = Join-Path $BinDir 'deno.exe'
if (Test-Path $deno) {
    Write-Host "  deno    already present, skipping" -ForegroundColor DarkGray
} else {
    $zip = Join-Path $env:TEMP 'deno-win.zip'
    $tmp = Join-Path $env:TEMP 'deno-extract'
    try {
        Get-File 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' $zip 'deno (~40 MB)'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $found = Get-ChildItem -Path $tmp -Filter 'deno.exe' -Recurse | Select-Object -First 1
        if ($found) {
            Copy-Item $found.FullName $deno -Force
            Write-Host "  deno    OK" -ForegroundColor Green
        } else {
            Write-Host "  deno    FAILED - deno.exe not found in the archive" -ForegroundColor Red
        }
    } catch {
        Write-Host "  deno    FAILED - $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "          optional; without it some YouTube formats may be missing" -ForegroundColor DarkGray
    } finally {
        Remove-Item $zip -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`nDone. Restart the server (or hit Re-check in the Download tab).`n"
