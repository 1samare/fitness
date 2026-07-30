Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cliPath = $env:WECHAT_DEVTOOLS_CLI

if ([string]::IsNullOrWhiteSpace($cliPath) -or -not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
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
    if (Test-Path -LiteralPath $shortcutCli -PathType Leaf) {
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
  $cliPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($cliPath)) {
  throw 'WeChat DevTools CLI was not found. Set WECHAT_DEVTOOLS_CLI to the absolute cli.bat path.'
}

& $cliPath open --project $repositoryRoot
if ($LASTEXITCODE -ne 0) {
  throw "WeChat DevTools CLI failed with exit code $LASTEXITCODE."
}
