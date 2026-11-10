# Replaces a personal Singularity IDE installation folder with a newly built package, with a backup and a way back.
# It never runs on its own: every step that changes something needs -Confirm, and it refuses while agents are working.
#
#   Check only (changes nothing):
#     powershell -File scripts/update-personal-install.ps1 -Package D:\dev\claude\fullbuild\VSCode-win32-x64 -Install D:\dev\claude\VSCode-win32-x64
#   Update (asks nothing else; you already decided):
#     powershell -File scripts/update-personal-install.ps1 -Package <new> -Install <current> -Confirm
#   Go back to the backup made by the update:
#     powershell -File scripts/update-personal-install.ps1 -Install <current> -Rollback <backup folder> -Confirm
#
# What is kept: everything outside the installation folder. Settings, sessions, history, paired devices, authorised workspaces, the request
# ledger and provider logins live in %LOCALAPPDATA%\Singularity, in the IDE profile and in each provider's own folder; none of them is touched.
param(
  [string]$Package,
  [Parameter(Mandatory)][string]$Install,
  [string]$Rollback,
  [string]$BackupRoot,
  [switch]$Confirm
)
$ErrorActionPreference = 'Stop'
function Say($text) { Write-Host $text }
function Fail($text) { Write-Host "RECUSADO: $text" -ForegroundColor Red; exit 1 }

$Install = (Resolve-Path $Install).Path
if (-not (Test-Path (Join-Path $Install 'Singularity IDE.exe'))) { Fail "não parece uma instalação do Singularity: $Install" }
$source = if ($Rollback) { (Resolve-Path $Rollback).Path } else { if (-not $Package) { Fail 'informe -Package ou -Rollback' }; (Resolve-Path $Package).Path }
if (-not (Test-Path (Join-Path $source 'Singularity IDE.exe'))) { Fail "a origem não é um pacote do Singularity: $source" }
if ($source -eq $Install) { Fail 'a origem e a instalação são a mesma pasta' }

function ProductOf($root) { Get-Content (Join-Path $root 'resources\app\product.json') -Raw | ConvertFrom-Json }
$current = ProductOf $Install
$next = ProductOf $source
Say "Instalação atual : $Install"
Say "  versão $($current.singularityVersion), commit $($current.commit)"
Say "$(if ($Rollback) { 'Backup a restaurar' } else { 'Pacote novo      ' }): $source"
Say "  versão $($next.singularityVersion), commit $($next.commit)"

# ---- what is running from the installation ----
$running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Install, [System.StringComparison]::OrdinalIgnoreCase) })
$ide = @($running | Where-Object { $_.Name -eq 'Singularity IDE.exe' })
$hubNode = Join-Path $Install 'resources\app\singularity-hub\runtime\node.exe'
$cli = Join-Path $Install 'resources\app\singularity-hub\dist\cli.js'
$status = $null
try { $status = (& $hubNode $cli status 2>$null | Select-Object -Last 1) | ConvertFrom-Json } catch { }
$sessions = if ($status -and $status.running) { [int]$status.sessions } else { 0 }
$gatewayFile = Join-Path $env:LOCALAPPDATA 'Singularity\Hub\remote\gateway.json'
$gateway = if (Test-Path $gatewayFile) { Get-Content $gatewayFile -Raw | ConvertFrom-Json } else { $null }
Say "Em execução a partir da instalação: $($running.Count) processo(s); janelas da IDE: $($ide.Count); Hub: $(if ($status -and $status.running) { "ativo, $sessions sessão(ões)" } else { 'parado' }); gateway remoto: $(if ($gateway) { "ativo na porta $($gateway.publicPort)" } else { 'desligado' })"

if (-not $Confirm) {
  Say ''
  Say 'Somente verificação: nada foi alterado. Para atualizar, feche a IDE, confira que não há agente trabalhando e rode de novo com -Confirm.'
  exit 0
}

# ---- refusals: nothing is closed or stopped for you ----
if ($ide.Count) { Fail 'feche as janelas da Singularity IDE antes de atualizar (nenhuma janela é fechada por este script).' }
if ($status -and $status.running) {
  # An agent is "working" when its session is running or waiting. A session that finished keeps an idle helper process; stopping the Hub
  # ends that helper and the session stays in the history, so it does not block the update (and the person is told about it below).
  $probe = @'
const {HubConnection}=require(process.argv[2]);
HubConnection.connect({clientName:'update-check',timeoutMs:15000}).then(async c=>{const s=await c.request('sessions.list');console.log(JSON.stringify(s.filter(x=>!x.historical).map(x=>({id:x.id.slice(0,8),status:x.status}))));process.exit(0)}).catch(()=>{console.log('null');process.exit(0)});
'@
  $probeFile = Join-Path $env:TEMP 'singularity-update-probe.cjs'; Set-Content $probeFile $probe
  $live = $null
  try { $live = (& $hubNode $probeFile ((Join-Path $Install 'resources\app\singularity-hub\dist\client.js') -replace '\\', '/') 2>$null | Select-Object -Last 1) | ConvertFrom-Json } catch { }
  if ($null -eq $live) { Fail 'não foi possível ler as sessões do Hub; nada foi alterado.' }
  $working = @($live | Where-Object { $_.status -in 'running', 'waiting' })
  if ($working.Count) { Fail "há $($working.Count) agente(s) trabalhando. Espere terminarem ou encerre-os pela IDE; nenhuma sessão é encerrada por este script." }
  $idle = @($live | Where-Object { $_.status -notin 'running', 'waiting' })
  if ($idle.Count) { Say "Sessões vivas e ociosas: $($idle.Count). Elas seguem no histórico depois que o Hub reiniciar (podem ser reabertas pela IDE)." }
}

# ---- backup ----
if (-not $BackupRoot) { $BackupRoot = Join-Path (Split-Path -Parent $Install) 'backup' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $BackupRoot ("VSCode-win32-x64-$($current.singularityVersion)-$($current.commit.Substring(0,10))-$stamp")
if (-not $Rollback) {
  Say "Backup da instalação atual em: $backup"
  New-Item -ItemType Directory -Force $backup | Out-Null
  robocopy $Install $backup /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "o backup falhou (robocopy $LASTEXITCODE); nada foi alterado." }
  if ((ProductOf $backup).commit -ne $current.commit) { Fail 'o backup não confere com a instalação; nada foi alterado.' }
}

# ---- the Hub and the gateway are stopped through their own shutdown, and started again afterwards ----
$gatewayWasOn = [bool]$gateway
$hubWasOn = [bool]($status -and $status.running)
if ($gatewayWasOn) {
  Say 'Parando o gateway remoto pelo próprio controle dele (dispositivos, workspaces e o Tailscale Serve não são alterados)...'
  $control = (Join-Path $Install 'resources\app\singularity-hub\dist\remote\control.js') -replace '\\', '/'
  & $hubNode -e "require('$control').stopGateway().then(()=>process.exit(0),()=>process.exit(1))"
}
if ($hubWasOn) { Say 'Parando o Hub pelo próprio encerramento dele...'; & $hubNode $cli stop | Out-Null; Start-Sleep 3 }
$left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Install, [System.StringComparison]::OrdinalIgnoreCase) })
if ($left.Count) { Fail "ainda há $($left.Count) processo(s) usando a instalação (por exemplo um Hub de outro perfil). Encerre-os por 'Singularity: Processos do Hub' e tente de novo. Nada foi substituído." }

Say 'Substituindo os arquivos da instalação...'
robocopy $source $Install /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "a cópia falhou (robocopy $LASTEXITCODE). Restaure com: -Install `"$Install`" -Rollback `"$backup`" -Confirm" }
$after = ProductOf $Install
if ($after.commit -ne $next.commit) { Fail 'a instalação não ficou com o commit esperado. Restaure o backup.' }

$hubNode = Join-Path $Install 'resources\app\singularity-hub\runtime\node.exe'
$cli = Join-Path $Install 'resources\app\singularity-hub\dist\cli.js'
if ($hubWasOn) { Say 'Iniciando o Hub...'; & $hubNode $cli start | Out-Null }
if ($gatewayWasOn) {
  Say 'Iniciando o gateway remoto...'
  $control = (Join-Path $Install 'resources\app\singularity-hub\dist\remote\control.js') -replace '\\', '/'
  $nodeArg = $hubNode -replace '\\', '/'
  & $hubNode -e "require('$control').startGateway('$nodeArg').then(i=>{console.log('gateway na porta '+i.publicPort);process.exit(0)},e=>{console.log(e.message);process.exit(1)})"
  Say 'O gateway escolhe uma porta nova ao iniciar. Se a rede privada estava publicada, abra a IDE: ela avisa que a publicação ficou em porta antiga e oferece reativar.'
}
Say ''
Say "Pronto: $Install está em $($after.singularityVersion), commit $($after.commit)."
if (-not $Rollback) { Say "Para voltar: powershell -File scripts/update-personal-install.ps1 -Install `"$Install`" -Rollback `"$backup`" -Confirm" }
