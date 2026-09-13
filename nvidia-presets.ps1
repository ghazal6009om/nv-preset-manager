param(
    [Parameter(Position = 0)]
    [ValidateSet("list", "show", "new", "help", "path")]
    [string]$Command = "help",

    [Parameter(Position = 1)]
    [string]$Name = ""
)

# -*- mode: powershell; encoding: utf-8 -*-
# NVIDIA Game Filters - Preset Library Manager
# Reads/writes presets from .\presets\*.json
# Each preset = one Freestyle style (a stack of filters for NVIDIA App).

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PresetsDir = Join-Path $Root "presets"
if (-not (Test-Path -LiteralPath $PresetsDir)) { New-Item -ItemType Directory -Path $PresetsDir | Out-Null }

function Get-Preset {
    param([string]$file)
    $raw = [System.IO.File]::ReadAllText($file)
    return $raw | ConvertFrom-Json
}

function Get-AllPresets {
    $list = @()
    foreach ($f in (Get-ChildItem -LiteralPath $PresetsDir -Filter "*.json" | Sort-Object Name)) {
        try { $list += Get-Preset $f.FullName } catch {}
    }
    return $list
}

function Show-PresetCard {
    param($p)
    $nl = [System.Environment]::NewLine
    $out = "=== " + $p.name + " ===" + $nl
    $out += "    " + $p.description + $nl
    $idx = 0
    foreach ($filter in $p.filters.PSObject.Properties) {
        $idx++
        $out += $nl + "[$idx] فلتر " + $filter.Name + $nl
        foreach ($slider in $filter.Value.PSObject.Properties) {
            $out += "   - " + $slider.Name + ": " + $slider.Value + $nl
        }
    }
    $out += $nl + "تطبيق يدوي: داخل اللعبة اضغط Alt+F3 ثم انشئ ستايل جديد وأدخل هذه القيم لكل فلتر." + $nl
    return $out
}

switch ($Command) {
    "list" {
        $presets = Get-AllPresets
        if ($presets.Count -eq 0) { Write-Output "لا توجد بريسيتات بعد. شغّل: .\nvidia-presets.ps1 new <name>" }
        foreach ($p in $presets) {
            Write-Output ("- {0}  |  {1}" -f $p.name, $p.description)
        }
    }
    "show" {
        if ([string]::IsNullOrWhiteSpace($Name)) { Write-Output "الاستخدام: .\nvidia-presets.ps1 show <name-or-file>"; break }
        $target = if (Test-Path -LiteralPath $Name) { $Name } else { Join-Path $PresetsDir ($Name.TrimEnd(".json") + ".json") }
        if (-not (Test-Path -LiteralPath $target)) { Write-Output "لم يوجد بريسيت باسم: $Name"; break }
        $p = Get-Preset $target
        Write-Output (Show-PresetCard $p)
    }
    "new" {
        if ([string]::IsNullOrWhiteSpace($Name)) { Write-Output "الاستخدام: .\nvidia-presets.ps1 new <name>"; break }
        $safe = $Name.Trim() -replace "[^a-zA-Z0-9_-]", "-"
        $file = Join-Path $PresetsDir ($safe + ".json")
        if (Test-Path -LiteralPath $file) { Write-Output "موجود مسبقاً: $file"; break }
        $template = Get-Preset (Join-Path $PresetsDir "vibrant-anime.json")
        $json = @{
            name        = $Name
            description = "بريسات جديد - عدّل القيم في ملفه ثم شغّل: .\nvidia-presets.ps1 show $safe"
            filters     = $template.filters
        } | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output "تم إنشاء: $file"
        Write-Output ("عدّل القيم مباشرة في الملف (بلغة JSON) ثم اعرض البطاقة عبر: .\nvidia-presets.ps1 show " + $safe)
    }
    "path" {
        Write-Output $PresetsDir
    }
    default {
        Write-Output "استخدام مكتبة البريسات NVIDIA:"
        Write-Output "  .\nvidia-presets.ps1 list                 - عرض كل البريسات"
        Write-Output "  .\nvidia-presets.ps1 show <name>          - بطاقة قيم جاهزة للتطبيق على الفلاتر"
        Write-Output "  .\nvidia-presets.ps1 new  <name>          - بريسيت جديد (يبدأ من نسخة حيوي أنيمي)"
        Write-Output "  .\nvidia-presets.ps1 path                 - مجلد ملفات البريسات (JSON)"
        Write-Output "ملاحظة: الفلاتر تطبق يدوياً فقط عبر NVIDIA App (Alt+F3) - لا يوجد API لتطبيقها آلياً."
    }
}