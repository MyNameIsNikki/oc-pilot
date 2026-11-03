# Builds one marketplace-ready zip per skill.
#
# Agensi expects a listing to be a zip whose root contains SKILL.md with valid
# front matter, so each archive holds the *contents* of skills/<name>/ rather
# than the directory itself.
#
# Usage: pwsh scripts/build-skills.ps1 [-OutDir dist-skills]

param([string]$OutDir = "dist-skills")

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$skillsDir = Join-Path $root "skills"
$out = Join-Path $root $OutDir

if (-not (Test-Path $skillsDir)) {
  throw "skills directory not found: $skillsDir"
}

if (Test-Path $out) {
  Remove-Item $out -Recurse -Force
}
New-Item -ItemType Directory -Path $out | Out-Null

$built = 0
foreach ($skill in Get-ChildItem $skillsDir -Directory | Sort-Object Name) {
  $entry = Join-Path $skill.FullName "SKILL.md"
  if (-not (Test-Path $entry)) {
    Write-Warning "skipping $($skill.Name): no SKILL.md"
    continue
  }

  $target = Join-Path $out "$($skill.Name).zip"
  Compress-Archive -Path (Join-Path $skill.FullName "*") -DestinationPath $target -CompressionLevel Optimal

  $size = [math]::Round((Get-Item $target).Length / 1KB, 1)
  Write-Output ("{0,-24} {1,7} KB" -f "$($skill.Name).zip", $size)
  $built += 1
}

Write-Output ""
Write-Output "$built archive(s) in $out"
