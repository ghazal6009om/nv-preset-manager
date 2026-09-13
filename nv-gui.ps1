# NV Preset Manager - GUI (شبيه NVIDIA Game Filters)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tool    = Join-Path $Root 'tool\nv.mjs'
$Node    = 'node'
$Collect = Join-Path $Root 'collected'
$Backups = Join-Path $Root 'backups'
$LiveJson = Join-Path $env:TEMP 'nv-gui-live.json'

function Invoke-NV([string[]]$CallArgs) {
    $out = & $Node $Tool @CallArgs 2>&1 | Out-String
    return $out.Trim()
}

function Get-Arabic-Flasks {
    for ($try = 1; $try -le 3; $try++) {
        try { Invoke-NV @('json', $LiveJson) | Out-Null } catch { }
        if ((-not (Test-Path $LiveJson)) -or ((Get-Item $LiveJson).Length -lt 10)) { Start-Sleep -Milliseconds 500; continue }
        try { return Get-Content -LiteralPath $LiveJson -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    return $null
}

function Get-ControlSummary($f) {
    if (-not $f.controls) { return '' }
    return (($f.controls | ForEach-Object { $_.displayName + ' = ' + $_.currentUIValue }) -join ', ')
}

function Refresh-Slots {
    $dgv.Rows.Clear()
    $fp = Get-Arabic-Flasks
    if (-not $fp -or -not $fp.filterPresets) {
        $lblStatus.Text = 'لم تُعثر بيانات فلاتر. افتح Freestyle مرة أولى داخل اللعبة.'
        return
    }
    $exe = ($fp.filterPresets.PSObject.Properties | Select-Object -First 1).Name
    $mes = $fp.filterPresets.$exe.modsSlotsInfo
    foreach ($slot in ($mes.slots | Where-Object { $_.id -ge 1 -and $_.id -le 3 })) {
        $filters = @($slot.filterStack.filters)
        if ($filters.Count -eq 0) {
            $dgv.Rows.Add($slot.id, '(فارغ)', '') > $null
            continue
        }
        foreach ($f in $filters) {
            $dgv.Rows.Add($slot.id, $f.name, (Get-ControlSummary $f)) > $null
        }
    }
    $lblStatus.Text = "اللعبة: $exe  (حدث $($fp.filterPresets.$exe.modsSlotsInfo.lastSlotIdx))"
    Refresh-Backups
}

function Refresh-Backups {
    $cboBackup.Items.Clear()
    if (Test-Path $Backups) {
        Get-ChildItem -LiteralPath $Backups -Directory | Sort-Object LastWriteTime -Descending | ForEach-Object { $cboBackup.Items.Add($_.Name) > $null }
    }
    if ($cboBackup.Items.Count -gt 0) { $cboBackup.SelectedIndex = 0 }
}

function Show-Result($msg) {
    [System.Windows.Forms.MessageBox]::Show($msg, 'NV Preset Manager', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}

function Run-Import {
    $slot = $cboSlot.SelectedItem
    $preset = $cboPreset.SelectedItem
    if (-not $slot -or -not $preset) { $lblStatus.Text = 'اختر الخانة والبريست.'; return }
    $lblStatus.Text = 'جار التطبيق... أغلق NVIDIA App إذا طُلب ذلك.'
    $res = Invoke-NV @('import', $slot, $preset)
    $lblStatus.Text = 'تم تنفيذ الاستيراد.'
    Show-Result $res
    Refresh-Slots
}

function Run-Export {
    $name = 'export-' + (Get-Date -Format 'yyyy-MM-dd-HHmmss')
    $res = Invoke-NV @('export', $name)
    $lblStatus.Text = 'تم التصدير.'
    Show-Result $res
}

function Run-Backup {
    $lblStatus.Text = 'جار أخذ نسخة احتياطية...'
    $res = Invoke-NV @('backup')
    $lblStatus.Text = 'تم النسخ الاحتياطي.'
    Show-Result $res
    Refresh-Backups
}

function Run-Restore {
    $label = $cboBackup.SelectedItem
    if (-not $label) { $lblStatus.Text = 'اختر نسخة أولاً.'; return }
    $q = [System.Windows.Forms.MessageBox]::Show('أغلق NVIDIA App واللعبة أولاً، ثم استعيد النسخة:' + [Environment]::NewLine + $label + [Environment]::NewLine + 'متابعة؟', 'استعادة', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($q -ne 'Yes') { return }
    $res = Invoke-NV @('restore', $label)
    Show-Result $res
    Refresh-Slots
}

# ---- بناء الواجهة ----
$form = New-Object System.Windows.Forms.Form
$form.Text = 'NV Preset Manager - شبيه NVIDIA Game Filters'
$form.Size = New-Object System.Drawing.Size(760, 620)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)

$dgv = New-Object System.Windows.Forms.DataGridView
$dgv.Location = New-Object System.Drawing.Point(12, 90)
$dgv.Size = New-Object System.Drawing.Size(720, 360)
$dgv.AllowUserToAddRows = $false
$dgv.AllowUserToDeleteRows = $false
$dgv.ReadOnly = $true
$dgv.RowHeadersVisible = $false
$dgv.AutoSizeColumnsMode = 'Fill'
$colSlot = $dgv.Columns.Add('خانة', 'خانة')
$colFilter = $dgv.Columns.Add('الفلتر', 'الفلتر')
$colVals = $dgv.Columns.Add('القيم', 'القيم (أسماء المقابلة = القيمة)')
$form.Controls.Add($dgv)

# شريط البريسات
$lblSlot = New-Object System.Windows.Forms.Label
$lblSlot.Text = 'الخانة:'
$lblSlot.Location = New-Object System.Drawing.Point(12, 12)
$lblSlot.AutoSize = $true
$form.Controls.Add($lblSlot)

$cboSlot = New-Object System.Windows.Forms.ComboBox
$cboSlot.Location = New-Object System.Drawing.Point(70, 9)
$cboSlot.DropDownStyle = 'DropDownList'
$cboSlot.Items.Add('1') > $null
$cboSlot.Items.Add('2') > $null
$cboSlot.Items.Add('3') > $null
$cboSlot.SelectedIndex = 0
$form.Controls.Add($cboSlot)

$lblPreset = New-Object System.Windows.Forms.Label
$lblPreset.Text = 'البريست:'
$lblPreset.Location = New-Object System.Drawing.Point(140, 12)
$lblPreset.AutoSize = $true
$form.Controls.Add($lblPreset)

$cboPreset = New-Object System.Windows.Forms.ComboBox
$cboPreset.Location = New-Object System.Drawing.Point(200, 9)
$cboPreset.DropDownStyle = 'DropDownList'
$cboPreset.Items.Add('vibrant-anime') > $null
$cboPreset.Items.Add('soft-cinematic') > $null
$cboPreset.Items.Add('crisp-realistic') > $null
$cboPreset.SelectedIndex = 0
$form.Controls.Add($cboPreset)

$btnImport = New-Object System.Windows.Forms.Button
$btnImport.Text = 'استيراد إلى الخانة'
$btnImport.Location = New-Object System.Drawing.Point(380, 7)
$btnImport.Size = New-Object System.Drawing.Size(140, 28)
$btnImport.Add_Click({ Run-Import })
$form.Controls.Add($btnImport)

# صف الأزرار السفلي
$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = 'تحديث'
$btnRefresh.Location = New-Object System.Drawing.Point(12, 465)
$btnRefresh.Size = New-Object System.Drawing.Size(90, 30)
$btnRefresh.Add_Click({ Refresh-Slots })
$form.Controls.Add($btnRefresh)

$btnExport = New-Object System.Windows.Forms.Button
$btnExport.Text = 'تصدير'
$btnExport.Location = New-Object System.Drawing.Point(108, 465)
$btnExport.Size = New-Object System.Drawing.Size(90, 30)
$btnExport.Add_Click({ Run-Export })
$form.Controls.Add($btnExport)

$lblBackup = New-Object System.Windows.Forms.Label
$lblBackup.Text = 'النسخ الاحتياطية:'
$lblBackup.Location = New-Object System.Drawing.Point(210, 472)
$lblBackup.AutoSize = $true
$form.Controls.Add($lblBackup)

$cboBackup = New-Object System.Windows.Forms.ComboBox
$cboBackup.Location = New-Object System.Drawing.Point(330, 469)
$cboBackup.DropDownStyle = 'DropDownList'
$cboBackup.Width = 150
$form.Controls.Add($cboBackup)

$btnRestore = New-Object System.Windows.Forms.Button
$btnRestore.Text = 'استعادة'
$btnRestore.Location = New-Object System.Drawing.Point(488, 465)
$btnRestore.Size = New-Object System.Drawing.Size(90, 30)
$btnRestore.Add_Click({ Run-Restore })
$form.Controls.Add($btnRestore)

$btnBackup = New-Object System.Windows.Forms.Button
$btnBackup.Text = 'نسخ احتياطي الآن'
$btnBackup.Location = New-Object System.Drawing.Point(584, 465)
$btnBackup.Size = New-Object System.Drawing.Size(150, 30)
$btnBackup.Add_Click({ Run-Backup })
$form.Controls.Add($btnBackup)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(12, 508)
$lblStatus.Size = New-Object System.Drawing.Size(710, 60)
$lblStatus.ForeColor = [System.Drawing.Color]::DarkSlateGray
$form.Controls.Add($lblStatus)

$form.Add_Shown({ Refresh-Slots })
$silent = $form.ShowDialog()