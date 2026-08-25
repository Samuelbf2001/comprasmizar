param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl,
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dumpPath = Join-Path $resolvedDestination "mizar-$stamp.dump"
pg_dump --format=custom --no-owner --no-acl --file=$dumpPath $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $dumpPath
"$($hash.Hash)  $([System.IO.Path]::GetFileName($dumpPath))" | Set-Content -LiteralPath "$dumpPath.sha256"
$expiredDumps = Get-ChildItem -LiteralPath $resolvedDestination -Filter "mizar-*.dump" |
  Where-Object LastWriteTime -lt (Get-Date).AddDays(-35)
foreach ($expiredDump in $expiredDumps) {
  Remove-Item -LiteralPath $expiredDump.FullName -Force
  $expiredChecksum = "$($expiredDump.FullName).sha256"
  if (Test-Path -LiteralPath $expiredChecksum -PathType Leaf) {
    Remove-Item -LiteralPath $expiredChecksum -Force
  }
}
