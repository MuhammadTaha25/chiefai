# Starts a STABLE public bridge for the local dev server.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-tunnel.ps1
#
# This uses ngrok, because this machine's ngrok account has a RESERVED domain:
# every run gets the SAME public URL. That is what makes the bridge permanent —
# a cloudflare quick tunnel gets a new URL on every restart, so the Zernio
# webhooks and every Twilio number's VoiceUrl silently rot.
#
# The script:
#   1. stops any previous tunnel so they do not accumulate,
#   2. starts ngrok against the local server,
#   3. waits until the public URL actually answers,
#   4. writes it into .env.local,
#   5. asks the app to re-point the Zernio webhooks and the Twilio numbers.
#
# A named Cloudflare tunnel or a real deployment would remove the need for a
# local tunnel entirely, but both require an account — see VOICE_SETUP.md.

param(
  [string]$Port = "3000",
  [string]$AppUrl = "http://localhost:3000",
  [switch]$SkipSync
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envFile = Join-Path $root ".env.local"

if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
  Write-Error "ngrok is not on PATH. Install it, or run a cloudflare quick tunnel and call /api/cron/sync-endpoints manually."
}

# --- 1. stop any previous tunnel ---------------------------------------------
Get-Process ngrok -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "stopping previous ngrok (pid $($_.Id))"
  Stop-Process -Id $_.Id -Force
}
Start-Sleep -Seconds 2

# --- 2. start the tunnel -----------------------------------------------------
$log = Join-Path $env:TEMP "ngrok-dev.log"
foreach ($f in @($log, "$log.err")) { if (Test-Path $f) { Remove-Item $f -Force } }
Write-Host "starting ngrok -> http://localhost:$Port"
Start-Process -FilePath "ngrok" -ArgumentList "http", $Port, "--log=stdout" `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden

# --- 3. read the public URL it was given -------------------------------------
$publicUrl = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'url=(https://[a-z0-9.-]+\.ngrok-free\.(dev|app))' -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($m) { $publicUrl = $m.Matches[0].Groups[1].Value; break }
  }
}
if (-not $publicUrl) {
  Write-Error "could not read the ngrok URL; see $log"
}
Write-Host "public URL: $publicUrl" -ForegroundColor Green

# --- 4. keep .env.local pointed at it ----------------------------------------
$lines = Get-Content $envFile
if ($lines -match '^PUBLIC_APP_URL=') {
  $lines = $lines -replace '^PUBLIC_APP_URL=.*', "PUBLIC_APP_URL=$publicUrl"
} else {
  $lines += "PUBLIC_APP_URL=$publicUrl"
}
Set-Content -Path $envFile -Value $lines -Encoding UTF8
Write-Host "PUBLIC_APP_URL updated in .env.local"

# --- 5. wait until the tunnel actually serves the app ------------------------
Write-Host "waiting for the tunnel to answer…"
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "$publicUrl/api/voice/twiml" -TimeoutSec 15 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if ($healthy) { Write-Host "tunnel is serving the app" -ForegroundColor Green }
else { Write-Warning "tunnel did not answer yet — the sync below may report reachable=false" }

if ($SkipSync) { Write-Host "skipping endpoint sync (-SkipSync)"; exit 0 }

# --- 6. re-point the webhooks and the numbers --------------------------------
$cron = (Select-String -Path $envFile -Pattern '^CRON_SECRET=' | Select-Object -First 1)
if (-not $cron) { Write-Warning "no CRON_SECRET in .env.local — cannot trigger the sync"; exit 0 }
$secret = $cron.Line.Split('=', 2)[1].Trim()

Write-Host "re-pointing webhooks and numbers at the current origin…"
try {
  $res = Invoke-RestMethod -Method Post -Uri "$AppUrl/api/cron/sync-endpoints" `
    -Headers @{ Authorization = "Bearer $secret" } -TimeoutSec 180
  $res | ConvertTo-Json -Depth 6
} catch {
  Write-Warning "sync call failed: $($_.Exception.Message)"
  Write-Warning "is 'npm run dev' running? start it, then re-run without -SkipSync"
}
