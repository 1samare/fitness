Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cliPath = $env:WECHAT_DEVTOOLS_CLI

function Test-WeChatDevToolsCli {
  param([string]$CandidatePath)

  if ([string]::IsNullOrWhiteSpace($CandidatePath) -or -not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) {
    return $false
  }

  $productExecutable = Join-Path (Split-Path -Parent $CandidatePath) 'wechatdevtools.exe'
  return Test-Path -LiteralPath $productExecutable -PathType Leaf
}

if (-not (Test-WeChatDevToolsCli -CandidatePath $cliPath)) {
  $cliPath = $null
  $programsPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $shell = New-Object -ComObject WScript.Shell
  $shortcutPaths = Get-ChildItem -LiteralPath $programsPath -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
  foreach ($shortcutPath in $shortcutPaths) {
    $targetPath = $shell.CreateShortcut($shortcutPath.FullName).TargetPath
    if ([string]::IsNullOrWhiteSpace($targetPath)) {
      continue
    }
    $shortcutCli = Join-Path (Split-Path -Parent $targetPath) 'cli.bat'
    if (Test-WeChatDevToolsCli -CandidatePath $shortcutCli) {
      $cliPath = $shortcutCli
      break
    }
  }
}

if ([string]::IsNullOrWhiteSpace($cliPath)) {
  $candidates = @(
    'C:\Program Files (x86)\Tencent\WeChatDevTools\cli.bat',
    'C:\Program Files\Tencent\WeChatDevTools\cli.bat'
  )
  $cliPath = $candidates | Where-Object { Test-WeChatDevToolsCli -CandidatePath $_ } | Select-Object -First 1
}

if (-not (Test-WeChatDevToolsCli -CandidatePath $cliPath)) {
  throw 'WeChat DevTools CLI was not found or could not be verified. Set WECHAT_DEVTOOLS_CLI to the absolute cli.bat path.'
}

& $cliPath open --project $repositoryRoot
if ($LASTEXITCODE -ne 0) {
  throw "WeChat DevTools CLI failed with exit code $LASTEXITCODE."
}
