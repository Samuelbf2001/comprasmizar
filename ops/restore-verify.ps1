param(
  [Parameter(Mandatory = $true)]
  [string]$DumpPath,
  [Parameter(Mandatory = $true)]
  [string]$VerificationDatabaseUrl
)

$ErrorActionPreference = "Stop"
$resolvedDump = [System.IO.Path]::GetFullPath($DumpPath)
if (-not (Test-Path -LiteralPath $resolvedDump -PathType Leaf)) {
  throw "Dump not found: $resolvedDump"
}

$checksumPath = "$resolvedDump.sha256"
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
  throw "Checksum not found: $checksumPath"
}
$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0]
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedDump).Hash
if (-not $expectedHash -or $expectedHash -ne $actualHash) {
  throw "Backup checksum mismatch: $resolvedDump"
}

pg_restore --clean --if-exists --no-owner --no-acl --dbname=$VerificationDatabaseUrl $resolvedDump
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }
psql $VerificationDatabaseUrl -v ON_ERROR_STOP=1 -c "select count(*) as migration_count from supabase_migrations.schema_migrations;"
if ($LASTEXITCODE -ne 0) { throw "Restore verification query failed" }
