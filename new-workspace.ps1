param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Force
)
# Creates (or completes) a task-kanban working folder from workspace/:
# AGENTS.md, CLAUDE.md, settings.yaml, .vscode/.claude settings, kanban-* skills, Tasks/_template, Obsidian vault.
# Existing files are kept unless -Force (skills are always refreshed: they belong to task-kanban).
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'workspace'
if (-not (Test-Path $src)) { throw "Kit not found: $src" }
$dst = [IO.Path]::GetFullPath($Path)
New-Item -ItemType Directory -Force $dst | Out-Null

$created = 0; $updated = 0; $kept = 0
Get-ChildItem $src -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length).TrimStart('\', '/')
    $target = Join-Path $dst $rel
    $isSkill = $rel -like '.claude\skills\kanban-*'
    if (Test-Path $target) {
        if ($Force -or $isSkill) {
            Copy-Item $_.FullName $target -Force; $updated++; Write-Host "  updated  $rel"
        } else {
            $kept++; Write-Host "  kept     $rel"
        }
    } else {
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item $_.FullName $target; $created++; Write-Host "  created  $rel"
    }
}
Write-Host "Done: $dst (created $created, updated $updated, kept $kept)"
if ($kept) { Write-Host 'Kept files were not changed; merge them with workspace/ by hand if needed (or rerun with -Force).' }
Write-Host 'Next: open the folder in VS Code (status bar: Projects), open Obsidian/ as a vault in Obsidian,'
Write-Host 'and ask the agent to add a project (skill kanban-project).'
