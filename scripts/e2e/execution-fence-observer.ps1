param([Parameter(Mandatory=$true)][string]$ProcessIds)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FenceObserver {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$handles = @()
try {
  foreach ($processIdText in $ProcessIds.Split(',')) {
    $handle = [FenceObserver]::OpenProcess(0x100000, $false, [uint32]$processIdText)
    if ($handle -eq [IntPtr]::Zero) { throw "Cannot observe original process $processIdText" }
    $handles += $handle
    if ([FenceObserver]::WaitForSingleObject($handle, 0) -ne 258) { throw "Process already exited before observer capture" }
  }
  [Console]::Out.WriteLine('captured')
  [Console]::Out.Flush()
  foreach ($handle in $handles) {
    if ([FenceObserver]::WaitForSingleObject($handle, 15000) -ne 0) { throw 'Original process exit was not confirmed' }
  }
  [Console]::Out.WriteLine('exited')
} finally {
  foreach ($handle in $handles) { [void][FenceObserver]::CloseHandle($handle) }
}
