# Builds a portable zip of the project.
#
# Includes : source, node_modules (so it runs without npm install), .env.local,
#            supabase migrations, scripts, docs.
# Excludes : .next (666 MB of regenerable build cache, and it corrupted once),
#            any existing zip in the parent folder, and this script's own temp files.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\make-zip.ps1 [-Out <path>]

param(
  [string]$Out = "D:\harness-session\infomist-updated.zip"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (Test-Path $Out) { Remove-Item $Out -Force }

# Everything except the build cache.
$excludeDirs = @("$root\.next")

Write-Host "collecting files from $root …"
$files = Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object {
    $p = $_.FullName
    -not ($excludeDirs | Where-Object { $p.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) })
  }
Write-Host ("  {0} files, {1:N1} MB" -f $files.Count, (($files | Measure-Object -Property Length -Sum).Sum / 1MB))

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$fs = [System.IO.File]::Open($Out, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)

$i = 0
foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length).TrimStart('\')
  $entryName = "infomist/" + ($rel -replace '\\', '/')
  try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  } catch {
    Write-Warning "skipped $rel : $($_.Exception.Message)"
  }
  $i++
  if ($i % 2000 -eq 0) { Write-Host "  added $i / $($files.Count)" }
}

$zip.Dispose()
$fs.Dispose()
$sw.Stop()

$size = (Get-Item $Out).Length
Write-Host ("`nDONE  {0}" -f $Out) -ForegroundColor Green
Write-Host ("  {0:N1} MB in {1:N0}s" -f ($size / 1MB), $sw.Elapsed.TotalSeconds)

# Prove it is a readable archive and show the top level.
$z = [System.IO.Compression.ZipFile]::OpenRead($Out)
Write-Host ("  entries: {0}" -f $z.Entries.Count)
Write-Host "  top level:"
$z.Entries | ForEach-Object { ($_.FullName -split '/')[1] } | Where-Object { $_ } | Sort-Object -Unique | Select-Object -First 25 | ForEach-Object { "    $_" }
$z.Dispose()
