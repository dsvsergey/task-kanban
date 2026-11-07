param([switch]$Uninstall)
# Встановлення розширення з каталогу проекту без збірки: junction у ~/.vscode/extensions.
$ErrorActionPreference = 'Stop'
$pkg = Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$extDir = Join-Path $env:USERPROFILE '.vscode\extensions'
$name = "$($pkg.publisher).$($pkg.name)"

# прибрати попередні версії (лише junction-и на цей проект)
Get-ChildItem $extDir -Directory -Filter "$name-*" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.LinkType -eq 'Junction') {
        cmd /c rmdir "$($_.FullName)" | Out-Null
        Write-Host "Видалено $($_.FullName)"
    } else {
        Write-Warning "$($_.FullName) — не junction, не чіпаю"
    }
}
if ($Uninstall) { Write-Host 'Готово. Перезавантажте вікно VS Code.'; return }

$target = Join-Path $extDir "$name-$($pkg.version)"
New-Item -ItemType Junction -Path $target -Target $PSScriptRoot | Out-Null
Write-Host "Встановлено: $target -> $PSScriptRoot"
Write-Host 'Перезавантажте вікно VS Code (Developer: Reload Window).'
