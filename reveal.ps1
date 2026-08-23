# Reveals a downloaded file in Explorer and brings that window to the front.
#
# Launching `explorer.exe /select,"..."` on its own is not enough: if a window
# is already showing that folder, Explorer reuses it and leaves it wherever it
# was in the z-order — usually behind the browser — so the click looks like it
# did nothing. And a background process can't just call SetForegroundWindow;
# Windows ignores it unless the caller is already the foreground app, hence the
# AttachThreadInput dance below.
#
# Inputs (environment variables, never command-line text):
#   DL_REVEAL_PATH    absolute path to the file, or to a folder
#   DL_REVEAL_SELECT  "1" to select a file inside its folder, "0" to open a folder

$ErrorActionPreference = 'SilentlyContinue'

$target = $env:DL_REVEAL_PATH
if (-not $target) { exit 1 }

$select = $env:DL_REVEAL_SELECT -eq '1'
$folder = if ($select) { Split-Path -Parent $target } else { $target }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);

  // Windows refuses SetForegroundWindow from a process that hasn't received
  // input — which is exactly our situation, since the click happened in the
  // browser. Synthesising a stray ALT tap counts as input and lifts the lock.
  // AttachThreadInput alone was tested here and did NOT work.
  public static bool Raise(IntPtr h) {
    keybd_event(0x12, 0, 0, IntPtr.Zero);   // VK_MENU down
    keybd_event(0x12, 0, 2, IntPtr.Zero);   // VK_MENU up (KEYEVENTF_KEYUP)
    if (IsIconic(h)) { ShowWindow(h, 9); }  // SW_RESTORE
    BringWindowToTop(h);
    return SetForegroundWindow(h);
  }
}
'@

function Get-WindowFor([string]$Path) {
    $want = $Path.TrimEnd('\')
    $shell = New-Object -ComObject Shell.Application
    foreach ($w in $shell.Windows()) {
        try {
            $p = $w.Document.Folder.Self.Path
            if ($p -and $p.TrimEnd('\') -ieq $want) { return $w }
        } catch { }
    }
    return $null
}

# Ask Explorer to show it. Quotes wrap the path only — explorer.exe rejects a
# fully quoted "/select,path" argument and silently opens Documents instead.
if ($select) {
    Start-Process 'explorer.exe' -ArgumentList ('/select,"' + $target + '"')
} else {
    Start-Process 'explorer.exe' -ArgumentList ('"' + $folder + '"')
}

# The window may already exist (reused) or take a moment to appear (new).
$win = $null
for ($i = 0; $i -lt 25; $i++) {
    $win = Get-WindowFor $folder
    if ($win) { break }
    Start-Sleep -Milliseconds 200
}

if ($win) {
    Start-Sleep -Milliseconds 150
    if ([Fg]::Raise([IntPtr][int64]$win.HWND)) { exit 0 }
    exit 2   # window found but Windows refused to raise it
}

exit 1
