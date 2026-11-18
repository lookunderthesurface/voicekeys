# 受控实验：先把爱奇艺窗口激活并播放（用现方案：窗口+空格），确认在播放；
# 再发媒体键，看是否能暂停；最后恢复（再空格）。
$ErrorActionPreference = 'Continue'

$csharp = @"
using System;
using System.Runtime.InteropServices;
public static class WinCtl {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] ps, int cb);
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public KEYBDINPUT ki; public long pad; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  const uint KEYEVENTF_SCANCODE = 0x0008;
  const uint KEYEVENTF_KEYUP = 0x0002;
  public static void Tap(ushort scan) {
    var d = new INPUT(); d.type = 1; d.ki.wScan = scan; d.ki.dwFlags = KEYEVENTF_SCANCODE;
    var u = new INPUT(); u.type = 1; u.ki.wScan = scan; u.ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
    SendInput(1, new[] { d }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(30);
    SendInput(1, new[] { u }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Space() { Tap(0x39); }
  public static void PlayPauseKey() { Tap(0xE2); }
}
"@
Add-Type -TypeDefinition $csharp -ErrorAction Stop

$peakSrc = @"
using System;
using System.Runtime.InteropServices;
public static class AudioPeak2 {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EnumObj { }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEnumerator2 {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IntPtr store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }
  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMeter { int GetPeakValue(out float peak); }
  public static float Peak() {
    try {
      var en = (IEnumerator2)new EnumObj();
      IDevice dev; if (en.GetDefaultAudioEndpoint(0, 1, out dev) != 0 || dev == null) return -1f;
      var iid = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
      object o; if (dev.Activate(ref iid, 1, IntPtr.Zero, out o) != 0 || o == null) return -2f;
      float p; return ((IMeter)o).GetPeakValue(out p) == 0 ? p : -3f;
    } catch { return -99f; }
  }
}
"@
Add-Type -TypeDefinition $peakSrc -ErrorAction Stop

function Measure-Max([string]$label) {
  $vals = New-Object System.Collections.Generic.List[double]
  for ($i = 0; $i -lt 12; $i++) { $vals.Add([AudioPeak2]::Peak()); Start-Sleep -Milliseconds 100 }
  $max = ($vals | Measure-Object -Maximum).Maximum
  Write-Host ("  " + $label + ": max=" + [math]::Round($max, 4))
  return $max
}

$qy = Get-Process -Name 'QyClient' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $qy) { Write-Host '  爱奇艺没开'; exit }
$hwnd = $qy.MainWindowHandle
$prevFg = [WinCtl]::GetForegroundWindow()
Write-Host ('  爱奇艺 hwnd=' + $hwnd + '  原前台=' + $prevFg)

Write-Host '=== A) 基线（未操作） ==='
$p0 = Measure-Max 'baseline'

Write-Host '=== B) 用现方案开始播放：激活窗口 + 空格 ==='
[WinCtl]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
Start-Sleep -Milliseconds 400
[WinCtl]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500
Write-Host ('  前台是否已切到爱奇艺: ' + ([WinCtl]::GetForegroundWindow() -eq $hwnd))
[WinCtl]::Space()
Start-Sleep -Milliseconds 1500
$p1 = Measure-Max 'after-space'

Write-Host '=== C) 现在发媒体键，看能否暂停 ==='
[WinCtl]::PlayPauseKey()
Start-Sleep -Milliseconds 1200
$p2 = Measure-Max 'after-media-key'

Write-Host '=== D) 恢复：媒体键再发一次 + 把焦点还给原来的窗口 ==='
[WinCtl]::PlayPauseKey()
Start-Sleep -Milliseconds 300
if ($prevFg -ne [IntPtr]::Zero) { [WinCtl]::SetForegroundWindow($prevFg) | Out-Null }

Write-Host '=== E) 判定 ==='
Write-Host ('  baseline=' + [math]::Round($p0,4) + '  after-space=' + [math]::Round($p1,4) + '  after-mediakey=' + [math]::Round($p2,4))
if ($p1 -gt 0.001 -and $p2 -lt 0.001) { Write-Host '  => 媒体键能暂停爱奇艺（有声音 -> 没声音）' }
elseif ($p1 -gt 0.001 -and $p2 -gt 0.001) { Write-Host '  => 媒体键对爱奇艺无效（空格能让它响，媒体键不能）' }
elseif ($p1 -lt 0.001) { Write-Host '  => 空格没能让爱奇艺出声（可能窗口不是播放器/被弹窗挡住），本次无法判定' }
