param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$DataHome,[string]$Profile='web',[int]$Port=3090)
$ErrorActionPreference='Stop'
$serviceEntry=Join-Path $PSScriptRoot 'service-host.mjs'
$resolvedNode=(Resolve-Path -LiteralPath $NodePath).Path
$resolvedData=(Resolve-Path -LiteralPath $DataHome).Path
if($Profile -notmatch '^[a-zA-Z0-9_-]+$' -or $Port -lt 1024 -or $Port -gt 65535){throw 'INVALID_SERVICE_CONFIGURATION'}
if(Test-Path -LiteralPath (Join-Path $resolvedData '.human-offline.lock')){throw 'OFFLINE_STORE_LOCKED'}
$serviceProcess=Start-Process -FilePath $resolvedNode -ArgumentList @('"'+$serviceEntry+'"','--home','"'+$resolvedData+'"','--profile',$Profile,'--port',[string]$Port) -WindowStyle Hidden -PassThru -Wait
exit $serviceProcess.ExitCode
