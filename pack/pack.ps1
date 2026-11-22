# Builds the download: dist\Player Four\ (the program and its README) and a zip of that folder.
# usage: powershell -ExecutionPolicy Bypass -File pack\pack.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$version = (Select-String -Path "$root\pc\Cargo.toml" -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value

cargo build --release --quiet --manifest-path "$root\pc\Cargo.toml"
if ($LASTEXITCODE) { throw 'cargo build failed' }

$folder = "$root\dist\Player Four"
$zip = "$root\dist\PlayerFour-$version-windows.zip"
if (Test-Path $folder) { Remove-Item -Recurse -Force $folder }
if (Test-Path $zip) { Remove-Item -Force $zip }
New-Item -ItemType Directory -Force $folder | Out-Null

Copy-Item "$root\pc\target\release\player-four.exe" "$folder\Player Four.exe"
(Get-Content "$PSScriptRoot\README.txt" -Raw).Replace('{version}', $version) | Set-Content -Encoding UTF8 "$folder\README.txt"
Compress-Archive -Path $folder -DestinationPath $zip

"Player Four $version"
Get-ChildItem $folder, $zip | ForEach-Object { "  {0,-34} {1,6:N1} MB" -f $_.FullName.Substring($root.Length + 1), ($_.Length / 1MB) }
