param([string]$OutDir = (Join-Path $PSScriptRoot 'dist'))
# Збирає <name>-<version>.vsix без Node/vsce: zip з extension.vsixmanifest, [Content_Types].xml
# і файлами розширення в extension/. Що не пакувати — .vscodeignore (маски відносно кореня проекту).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$esc = { param($s) [System.Security.SecurityElement]::Escape([string]$s) }

# --- які файли пакувати ---
$ignore = @('.git/**', 'dist/**', '*.vsix', 'pack.ps1', '.vscodeignore')
$ignoreFile = Join-Path $root '.vscodeignore'
if (Test-Path $ignoreFile) {
    $ignore += Get-Content $ignoreFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }
}
function Test-Ignored([string]$rel) {
    foreach ($m in $ignore) {
        $re = '^' + ([regex]::Escape($m) -replace '\\\*\\\*/', '(.*/)?' -replace '\\\*\\\*', '.*' -replace '\\\*', '[^/]*') + '$'
        if ($rel -match $re) { return $true }
    }
    return $false
}
$files = Get-ChildItem $root -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
    if (-not (Test-Ignored $rel)) { [pscustomobject]@{ Rel = $rel; Full = $_.FullName } }
}

# --- маніфести ---
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(& $esc $pkg.name)" Version="$(& $esc $pkg.version)" Publisher="$(& $esc $pkg.publisher)" />
    <DisplayName>$(& $esc $pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$(& $esc $pkg.description)</Description>
    <Tags></Tags>
    <Categories>$(& $esc ($pkg.categories -join ','))</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(& $esc $pkg.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$types = @{ '.json' = 'application/json'; '.js' = 'application/javascript'; '.css' = 'text/css'; '.md' = 'text/markdown';
            '.vsixmanifest' = 'text/xml'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.txt' = 'text/plain' }
$exts = @('.vsixmanifest') + ($files | ForEach-Object { [IO.Path]::GetExtension($_.Rel).ToLower() }) | Where-Object { $_ } | Sort-Object -Unique
$ct = '<?xml version="1.0" encoding="utf-8"?>' + "`n" + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + "`n"
foreach ($e in $exts) {
    $t = $types[$e]; if (-not $t) { $t = 'application/octet-stream' }
    $ct += "  <Default Extension=`"$e`" ContentType=`"$t`" />`n"
}
$ct += '</Types>'

# --- zip (імена з '/', як вимагає VS Code) ---
New-Item -ItemType Directory -Force $OutDir | Out-Null
$out = Join-Path $OutDir "$($pkg.name)-$($pkg.version).vsix"
if (Test-Path $out) { Remove-Item $out -Force }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($entry in @(@{ Name = 'extension.vsixmanifest'; Text = $manifest }, @{ Name = '[Content_Types].xml'; Text = $ct })) {
        $w = New-Object System.IO.StreamWriter($zip.CreateEntry($entry.Name).Open(), $utf8)
        $w.Write($entry.Text); $w.Dispose()
    }
    foreach ($f in $files) {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.Full, "extension/$($f.Rel)")
    }
} finally { $zip.Dispose() }

Write-Host "Зібрано: $out ($($files.Count) файлів)"
$files | ForEach-Object { Write-Host "  extension/$($_.Rel)" }
Write-Host "Встановлення: code --install-extension `"$out`""
