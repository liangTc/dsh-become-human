param([ValidateSet('Install','Status','Start','Stop','Uninstall')][string]$Action='Status',[string]$DataHome,[string]$NodePath,[string]$Profile='web',[int]$Port=3090)
$ErrorActionPreference='Stop'
if(-not $DataHome){throw 'DATA_HOME_REQUIRED'}
$resolvedData=(Resolve-Path -LiteralPath $DataHome).Path
$taskHash=[System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($resolvedData.ToLowerInvariant()))).Replace('-','').Substring(0,12)
$taskName='DSH-Human-'+$taskHash
$serviceRunner=Join-Path $PSScriptRoot 'service-run.ps1'
if($Action -eq 'Status'){Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Select-Object TaskName,State;exit}
$existingTask=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existingTask -and $existingTask.Description -ne ('DSH Human managed home: '+$resolvedData)){throw 'SERVICE_TASK_OWNERSHIP_MISMATCH'}
if($Action -eq 'Install'){
  if($existingTask){throw 'SERVICE_ALREADY_INSTALLED'}
  if(-not $NodePath){$NodePath=(Get-Command node -ErrorAction Stop).Source}
  $resolvedNode=(Resolve-Path -LiteralPath $NodePath).Path
  if($Profile -notmatch '^[a-zA-Z0-9_-]+$' -or $Port -lt 1024 -or $Port -gt 65535){throw 'INVALID_SERVICE_CONFIGURATION'}
  $currentIdentity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskArguments='-NoProfile -WindowStyle Hidden -File "'+$serviceRunner+'" -NodePath "'+$resolvedNode+'" -DataHome "'+$resolvedData+'" -Profile '+$Profile+' -Port '+$Port
  $taskAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArguments -WorkingDirectory $PSScriptRoot
  $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
  $taskPrincipal=New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited
  $taskSettings=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description ('DSH Human managed home: '+$resolvedData) | Select-Object TaskName,State
  Write-Output 'Installed for the current logged-in Windows user. Worker cold starts remain paused. No model drive is resumed automatically.'
}elseif($Action -eq 'Start'){if(-not $existingTask){throw 'SERVICE_NOT_INSTALLED'};Start-ScheduledTask -TaskName $taskName}
elseif($Action -eq 'Stop'){
  if(-not $existingTask){throw 'SERVICE_NOT_INSTALLED'}
  if(-not $NodePath){$NodePath=(Get-Command node -ErrorAction Stop).Source}
  & $NodePath (Join-Path $PSScriptRoot 'service-stop.mjs') $resolvedData
  if($LASTEXITCODE -ne 0){throw 'SERVICE_STOP_FAILED'}
  Stop-ScheduledTask -TaskName $taskName
}
elseif($Action -eq 'Uninstall'){if(-not $existingTask){throw 'SERVICE_NOT_INSTALLED'};if($existingTask.State -eq 'Running'){throw 'STOP_SERVICE_BEFORE_UNINSTALL'};Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
