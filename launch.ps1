# Liam's Multi-Tool launcher — terminal entry point.
#
# The app lives in the system tray now, so this just hands off to tray.ps1,
# which starts the server with no console window and owns the tray icon.
# It stays in the foreground running the tray's message loop; close it with the
# tray icon's Quit, or Ctrl+C here.
#
# The Desktop / Start Menu shortcut uses launch.vbs instead, which does the same
# thing without any window at all.
#
# Run with -NoBrowse to start without opening the browser.
# To watch server output live instead, just run:  node server.mjs

param([switch]$NoBrowse)

& (Join-Path $PSScriptRoot 'tray.ps1') @PSBoundParameters
