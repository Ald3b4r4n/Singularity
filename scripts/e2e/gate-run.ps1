# Runs the whole packaged-build validation of a gate, one script after another, and keeps every log.
#   powershell -File scripts/e2e/gate-run.ps1 -Package D:\dev\claude\fullbuild\VSCode-win32-x64 -Out D:\dev\claude\e2e-out\gate
# Real inference, where a script needs it, uses only OpenCode Go (Muse Spark 1.3 Contributor / DeepSeek V4.1 Flash).
param([Parameter(Mandatory)][string]$Package, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $Package 'Singularity IDE.exe'
$hub = Join-Path $Package 'resources\app\singularity-hub'
$node = Join-Path $hub 'runtime\node.exe'
New-Item -ItemType Directory -Force $Out | Out-Null
Set-Location $repo
$env:SINGULARITY_E2E_OPENCODE_MODEL = 'muse-spark-1.3-contributor'
$steps = @(
  @{ name = 'multiagent-ui'; args = @('scripts/e2e/remote-multiagent-ui.cjs', '--out', "$Out/multiagent-ui", '--hub', $hub) },
  @{ name = 'comparison-ui'; args = @('scripts/e2e/comparison-ui.cjs') },
  @{ name = 'provider-diagnostics-ui'; args = @('scripts/e2e/provider-diagnostics-ui.cjs') },
  @{ name = 'remote-ide'; args = @('scripts/e2e/remote-ide-check.cjs', '--exe', $exe, '--out', "$Out/remote-ide") },
  @{ name = 'run'; args = @('scripts/e2e/run.cjs', '--exe', $exe, '--hub', '--out', "$Out/run") },
  @{ name = 'browser'; args = @('scripts/e2e/browser-check.cjs', '--exe', $exe, '--out', "$Out/browser") },
  @{ name = 'agents'; args = @('scripts/e2e/agents-check.cjs', '--exe', $exe, '--out', "$Out/agents") },
  @{ name = 'remote-check'; args = @('scripts/e2e/remote-check.cjs', '--out', "$Out/remote", '--hub', $hub, '--node', $node) },
  @{ name = 'reliability'; args = @('scripts/e2e/reliability-check.cjs', '--out', "$Out/reliability", '--hub', $hub, '--node', $node) },
  @{ name = 'multiagent'; args = @('scripts/e2e/remote-multiagent-check.cjs', '--out', "$Out/multiagent", '--hub', $hub, '--node', $node) }
)
foreach ($step in $steps) {
  $log = Join-Path $Out ($step.name + '.log')
  $start = Get-Date
  & node @($step.args) *> $log
  $code = $LASTEXITCODE
  "$($step.name) exit=$code seconds=$([int]((Get-Date) - $start).TotalSeconds)" | Add-Content (Join-Path $Out 'summary.txt')
}
'finished' | Add-Content (Join-Path $Out 'summary.txt')
