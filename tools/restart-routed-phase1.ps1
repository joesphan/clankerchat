# restart-routed-phase1.ps1 - one-shot detached watcher (armed 2026-10-04 by the
# routed-prompts port session). Restarts the daemon and the inject consumer ONCE
# each, but only at an idle moment, so no live worker run dies with its parent:
#   - daemon: when the verified daemon.js PID has no 'claude' worker descendants
#     -> kill that PID tree only -> relaunch the daemon exactly as it ran before
#        (cmd /c npm run daemon >> daemon.out.log 2>> daemon.err.log).
#   - consumer: when the spool holds no *.inject.json AND the verified
#     inject-consumer.mjs PID has no 'claude' descendants -> kill that PID tree
#     only; the Task Scheduler wrapper (botlink-consumer.cmd retry loop) respawns
#     it within ~10s from the EDITED consumer (outcome emit half).
# PID law: every kill re-verifies the command line first - a dead or reused PID
# is never killed. Hard timeout 90 min -> exit doing nothing (a later session or
# the human restarts by hand). Log: tools/restart-routed-phase1.log.
# ASCII-only on purpose: PS 5.1 parses BOM-less UTF-8 as ANSI.
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\joesp\Documents\GitHub\clankerchat'
$log = Join-Path $repo 'tools\restart-routed-phase1.log'
$deadline = (Get-Date).AddMinutes(90)
$daemonPid = 15940
$consumerPid = 9888
$daemonDone = $false
$consumerDone = $false

function Write-Log($line) {
  $s = "{0} {1}" -f (Get-Date -Format o), $line
  Add-Content -Path $log -Value $s -Encoding utf8
}

function Get-VerifiedPid($pid_, $match) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid_" -ErrorAction SilentlyContinue
  if ($p -and $p.CommandLine -and $p.CommandLine -match $match) { return $p }
  return $null
}

function Get-Descendants($rootPid) {
  $all = Get-CimInstance Win32_Process
  $seen = @()
  $frontier = @($rootPid)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($id_ in $frontier) {
      if ($seen -notcontains $id_) {
        $seen += $id_
        $next += @($all | Where-Object { $_.ParentProcessId -eq $id_ } | ForEach-Object { $_.ProcessId })
      }
    }
    $frontier = @($next | Where-Object { $seen -notcontains $_ })
  }
  return @($all | Where-Object { $seen -contains $_.ProcessId })
}

Write-Log "watcher armed: daemon=$daemonPid consumer=$consumerPid deadline=$deadline"
while ((Get-Date) -lt $deadline -and -not ($daemonDone -and $consumerDone)) {
  Start-Sleep -Seconds 15

  if (-not $daemonDone) {
    $d = Get-VerifiedPid $daemonPid 'daemon\.js'
    if (-not $d) {
      Write-Log "daemon PID $daemonPid gone or mismatched - checking for any daemon.js before relaunch"
      $any = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dist[/\\]daemon\.js' }
      if ($any) {
        Write-Log ("another daemon.js runs (PID " + ($any | Select-Object -First 1).ProcessId + ") - someone restarted already; daemon half done")
        $daemonDone = $true
      } else {
        Start-Process cmd.exe -ArgumentList '/c npm run daemon >> daemon.out.log 2>> daemon.err.log' -WorkingDirectory $repo -WindowStyle Hidden
        Write-Log "daemon was down - relaunched detached"
        $daemonDone = $true
      }
    } else {
      $desc = Get-Descendants $daemonPid
      $busy = @($desc | Where-Object { $_.CommandLine -match 'claude' })
      if ($busy.Count -eq 0) {
        taskkill /PID $daemonPid /T /F | Out-Null
        Write-Log "daemon idle - killed verified PID tree $daemonPid; relaunching"
        Start-Sleep -Seconds 3
        Start-Process cmd.exe -ArgumentList '/c npm run daemon >> daemon.out.log 2>> daemon.err.log' -WorkingDirectory $repo -WindowStyle Hidden
        Write-Log "daemon relaunched detached (routed-prompt sweep wiring live)"
        $daemonDone = $true
      }
    }
  }

  if (-not $consumerDone) {
    $c = Get-VerifiedPid $consumerPid 'inject-consumer\.mjs'
    if (-not $c) {
      Write-Log "consumer PID $consumerPid gone or mismatched - wrapper will have respawned it from the edited file; consumer half done"
      $consumerDone = $true
    } else {
      $pending = @(Get-ChildItem (Join-Path $repo 'botlink-spool') -Filter '*.inject.json' -ErrorAction SilentlyContinue)
      $desc = Get-Descendants $consumerPid
      $busy = @($desc | Where-Object { $_.CommandLine -match 'claude' })
      if ($pending.Count -eq 0 -and $busy.Count -eq 0) {
        taskkill /PID $consumerPid /T /F | Out-Null
        Write-Log "consumer idle (spool empty, no worker) - killed verified PID tree $consumerPid; botlink-consumer.cmd respawns it with the outcome-emit half"
        $consumerDone = $true
      }
    }
  }
}
Write-Log ("watcher exit: daemonDone=$daemonDone consumerDone=$consumerDone")
