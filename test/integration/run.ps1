# Інтеграційний тест у справжньому VS Code: окремий профіль і тимчасова робоча папка,
# ваші вікна й налаштування не зачіпаються. Вікно відкриється на кілька секунд і закриється.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("task-kanban-it-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$ws = Join-Path $tmp 'ws'
New-Item -ItemType Directory -Force (Join-Path $ws 'Tasks\_template'), (Join-Path $ws 'Tasks\1_new') | Out-Null
Set-Content (Join-Path $ws 'Tasks\_template\task.md') "# Task <номер>`n`n- **Статус:** нове`n" -Encoding UTF8

$code = Join-Path (Split-Path (Split-Path (Get-Command code).Source)) 'Code.exe'
# у терміналі VS Code ця змінна змушує Code.exe працювати як Node
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:TASK_KANBAN_IT_RESULT = Join-Path $tmp 'result.txt'

$codeArgs = @(
    '--user-data-dir', "`"$tmp\ud`"", '--extensions-dir', "`"$tmp\ext`"", '--disable-extensions',
    "--extensionDevelopmentPath=`"$root`"", "--extensionTestsPath=`"$PSScriptRoot\index.js`"", "`"$ws`""
)
$p = Start-Process -FilePath $code -ArgumentList $codeArgs -PassThru -Wait -WindowStyle Minimized `
    -RedirectStandardOutput "$tmp\out.txt" -RedirectStandardError "$tmp\err.txt"

if (Test-Path $env:TASK_KANBAN_IT_RESULT) { Get-Content $env:TASK_KANBAN_IT_RESULT -Encoding UTF8 }
else { Write-Warning 'Результату немає'; Get-Content "$tmp\err.txt" -Tail 20 }
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 0) { Write-Host "Помилка (код $($p.ExitCode))" -ForegroundColor Red; exit 1 }
Write-Host 'Інтеграційний тест пройшов' -ForegroundColor Green
