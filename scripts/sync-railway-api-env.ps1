param(
  [string]$EnvFile = ".env",
  [string]$Environment = "production",
  [string]$Service = "",
  [switch]$SkipDeploys
)

$ErrorActionPreference = "Stop"

$allowedVariables = @(
  "HOTEL_BILLING_FROM_NAME",
  "GMAIL_USER",
  "GMAIL_APP_PASS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ADMIN_CHAT_ID",
  "CONCIERGE_TIMEZONE",
  "GEMINI_API_KEY",
  "GROQ_API_KEY"
)

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Env file not found: $EnvFile"
}

$values = @{}
Get-Content -LiteralPath $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#") -or $line -notmatch "^[A-Za-z_][A-Za-z0-9_]*=") {
    return
  }

  $parts = $line -split "=", 2
  $key = $parts[0].Trim()
  $value = if ($parts.Count -gt 1) { $parts[1].Trim() } else { "" }

  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }

  if ($allowedVariables -contains $key -and $value) {
    $values[$key] = $value
  }
}

if (-not $values.Count) {
  throw "No API variables with values found in $EnvFile"
}

Write-Host "Syncing API variables to Railway environment '$Environment'..."
Write-Host "Only whitelisted API variables will be sent. Values will not be printed."

foreach ($key in $allowedVariables) {
  if (-not $values.ContainsKey($key)) {
    continue
  }

  $argsList = @("-y", "@railway/cli@latest", "variable", "set", "--environment", $Environment, "--stdin", $key)
  if ($Service) {
    $argsList += @("--service", $Service)
  }
  if ($SkipDeploys) {
    $argsList += "--skip-deploys"
  }

  Write-Host "Setting $key"
  $values[$key] | & npx @argsList
}

Write-Host "Done. Railway should redeploy unless -SkipDeploys was used."
