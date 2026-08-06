param(
    [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (
        Resolve-Path -LiteralPath (
            Join-Path $PSScriptRoot "..\.."
        )
    ).Path
}

$ProjectRoot = (
    Resolve-Path -LiteralPath $ProjectRoot
).Path

Set-Location -LiteralPath $ProjectRoot

$SecretPath = Join-Path $ProjectRoot ".env.database"
$SqlPath = Join-Path `
    $ProjectRoot `
    "database\foundation\001_database_foundation.sql"

if (-not (Test-Path $SecretPath)) {
    throw "File secret tidak ditemukan: $SecretPath"
}

if (-not (Test-Path $SqlPath)) {
    throw "SQL foundation tidak ditemukan: $SqlPath"
}

$Secrets = @{}

Get-Content $SecretPath | ForEach-Object {
    $line = $_.Trim()

    if ($line -and -not $line.StartsWith("#")) {
        $parts = $line.Split("=", 2)

        if ($parts.Count -eq 2) {
            $Secrets[$parts[0].Trim()] = $parts[1].Trim()
        }
    }
}

$Required = @(
    "VIND_MIGRATOR_PASSWORD",
    "VIND_APP_RUNTIME_PASSWORD",
    "VIND_IMPORTER_PASSWORD",
    "VIND_READONLY_PASSWORD"
)

foreach ($key in $Required) {
    if (-not $Secrets.ContainsKey($key) -or
        [string]::IsNullOrWhiteSpace($Secrets[$key])) {
        throw "Secret wajib tidak ditemukan: $key"
    }
}

docker compose up -d --wait

Get-Content $SqlPath -Raw |
    docker compose exec -T postgres psql `
        -U vind_bootstrap `
        -d vind_app_dev `
        -v ON_ERROR_STOP=1 `
        -v "migrator_password=$($Secrets['VIND_MIGRATOR_PASSWORD'])" `
        -v "runtime_password=$($Secrets['VIND_APP_RUNTIME_PASSWORD'])" `
        -v "importer_password=$($Secrets['VIND_IMPORTER_PASSWORD'])" `
        -v "readonly_password=$($Secrets['VIND_READONLY_PASSWORD'])"

if ($LASTEXITCODE -ne 0) {
    throw "Database Foundation gagal diterapkan."
}

Get-Content `
    "$ProjectRoot\database\foundation\verify_database_foundation.sql" `
    -Raw |
    docker compose exec -T postgres psql `
        -U vind_bootstrap `
        -d vind_app_dev `
        -P pager=off `
        -v ON_ERROR_STOP=1

if ($LASTEXITCODE -ne 0) {
    throw "Verifikasi Database Foundation gagal."
}