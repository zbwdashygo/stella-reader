# Stella 星阅 —— 安装桌面快捷方式
# 用法：右键「使用 PowerShell 运行」，或在项目目录执行：
#   powershell -ExecutionPolicy Bypass -File .\安装到桌面.ps1
# 可选：-RegisterEpub 同时把 .epub 默认打开方式指向本程序（仅当前用户）
param([switch]$RegisterEpub)

$ErrorActionPreference = 'Stop'
$appDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs      = Join-Path $appDir 'Stella星阅.vbs'
$icon     = Join-Path $appDir 'shell\icon.ico'
$wscript  = Join-Path $env:WINDIR 'System32\wscript.exe'

if (-not (Test-Path $vbs))  { throw "找不到 $vbs" }
if (-not (Test-Path $icon)) { throw "找不到图标 $icon" }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Stella 星阅.lnk'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath       = $wscript
$lnk.Arguments        = '"' + $vbs + '"'
$lnk.WorkingDirectory = $appDir
$lnk.IconLocation     = $icon + ',0'
$lnk.Description      = '本地 EPUB 阅读器，支持朗读'
$lnk.Save()
Write-Host "已创建桌面快捷方式：$lnkPath" -ForegroundColor Green

if ($RegisterEpub) {
  $exe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $exe)) { throw "缺少 Electron：$exe" }
  New-Item -Path 'HKCU:\Software\Classes\.epub' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Classes\.epub' -Name '(default)' -Value 'TingShu.Epub'
  New-Item -Path 'HKCU:\Software\Classes\TingShu.Epub' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Classes\TingShu.Epub' -Name '(default)' -Value 'EPUB 电子书'
  New-Item -Path 'HKCU:\Software\Classes\TingShu.Epub\DefaultIcon' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Classes\TingShu.Epub\DefaultIcon' -Name '(default)' -Value ($icon + ',0')
  New-Item -Path 'HKCU:\Software\Classes\TingShu.Epub\shell\open\command' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Classes\TingShu.Epub\shell\open\command' -Name '(default)' `
    -Value ('"' + (Join-Path $appDir 'node_modules\electron\dist\electron.exe') + '" "' + $appDir + '" "%1"')
  Write-Host "已把 .epub 关联到Stella星阅（双击 epub 即可打开）" -ForegroundColor Green
}

Write-Host '完成。' -ForegroundColor Cyan
