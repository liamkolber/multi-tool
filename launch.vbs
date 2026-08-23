' Starts the Media Library tray host with no window at all.
'
' PowerShell's -WindowStyle Hidden still flashes a console for a moment before
' it applies. Launching through WScript with window mode 0 never creates one,
' so the app comes up silently and only the tray icon appears.

Option Explicit

Dim shell, fso, root, cmd, args
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)

' Pass through any switches (e.g. -NoBrowse) handed to the .vbs
args = ""
Dim i
For i = 0 To WScript.Arguments.Count - 1
    args = args & " " & WScript.Arguments(i)
Next

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
      & root & "\tray.ps1""" & args

shell.Run cmd, 0, False
