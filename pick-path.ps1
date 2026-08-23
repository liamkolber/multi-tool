# Native "Save as" / folder picker for the Download tab.
#
# Every input arrives as an environment variable, never as a command-line
# argument, so a video title can't be interpolated into anything executable:
#
#   DL_PICK_MODE  file | folder
#   DL_PICK_DIR   directory to open in
#   DL_PICK_NAME  suggested file name, extension included (file mode)
#
# Writes the chosen path to stdout and exits 0; exits 1 if the user cancels.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# A dialog owned by nothing opens behind the browser, so it gets a stray
# top-most owner window to force it to the front.
#
# That owner must sit in the MIDDLE OF THE SCREEN, not parked off-screen:
# ShowDialog() centres the dialog on its owner, so an off-screen owner puts the
# whole dialog somewhere the user can't see it. Opacity 0 keeps it invisible
# without moving it out of view.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = 'Manual'
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$owner.Location = New-Object System.Drawing.Point(
    [int]($area.X + $area.Width / 2),
    [int]($area.Y + $area.Height / 2))
$owner.Show()
$owner.Activate()

$chosen = $null

if ($env:DL_PICK_MODE -eq 'folder') {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Choose where to save the downloads'
    if ($env:DL_PICK_DIR -and (Test-Path $env:DL_PICK_DIR)) { $dlg.SelectedPath = $env:DL_PICK_DIR }
    $result = $dlg.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $chosen = $dlg.SelectedPath }
} else {
    $dlg = New-Object System.Windows.Forms.SaveFileDialog
    $dlg.Title = 'Save video as'
    $dlg.OverwritePrompt = $true
    $dlg.RestoreDirectory = $false
    $dlg.Filter = 'Matroska video (*.mkv)|*.mkv|MP4 video (*.mp4)|*.mp4|WebM video (*.webm)|*.webm|Audio (*.m4a;*.opus;*.webm)|*.m4a;*.opus;*.webm|All files (*.*)|*.*'

    # Preselect the filter matching the suggested extension, so the dropdown
    # agrees with the name already in the box.
    $ext = ''
    if ($env:DL_PICK_NAME) { $ext = [System.IO.Path]::GetExtension($env:DL_PICK_NAME).TrimStart('.').ToLower() }
    switch ($ext) {
        'mkv'  { $dlg.FilterIndex = 1 }
        'mp4'  { $dlg.FilterIndex = 2 }
        'webm' { $dlg.FilterIndex = 3 }
        'm4a'  { $dlg.FilterIndex = 4 }
        'opus' { $dlg.FilterIndex = 4 }
        default { $dlg.FilterIndex = 5 }
    }
    if ($ext) { $dlg.DefaultExt = $ext }

    if ($env:DL_PICK_DIR -and (Test-Path $env:DL_PICK_DIR)) { $dlg.InitialDirectory = $env:DL_PICK_DIR }
    if ($env:DL_PICK_NAME) { $dlg.FileName = $env:DL_PICK_NAME }

    $result = $dlg.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $chosen = $dlg.FileName }
}

$owner.Close()

if ($chosen) {
    [Console]::Out.Write($chosen)
    exit 0
}
exit 1
