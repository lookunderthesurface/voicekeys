# VoiceKeys 原语执行器（常驻）
#
# 从 stdin 逐行读 JSON 命令，执行一条安全的系统原语，把结果以单行 JSON 写回 stdout。
# 之所以常驻：每条命令 spawn 一次 PowerShell 要 200-300ms，语音控制的体感全毁在这里。
#
# 只实现「可逆、无持久副作用、参数有界」的原语；写文件/起进程/联网的活都不在这里。

$ErrorActionPreference = 'Stop'
# 输入输出都锁 UTF-8：默认按控制台代码页解码 stdin，中文会变成乱码。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
public enum EDataFlow { Render = 0, Capture = 1, All = 2 }
public enum ERole { Console = 0, Multimedia = 1, Communications = 2 }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    // Keep the vtable order identical to the real interface: the channel methods cannot be skipped,
    // otherwise SetMute/GetMute land on the wrong slot and throw.
    int NotImpl1();
    int NotImpl2();
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    // BOOL is 4 bytes: marshal it explicitly or the call throws.
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}

public static class Audio {
    static IAudioEndpointVolume Ep() {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        IMMDevice dev;
        en.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out dev);
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        dev.Activate(ref iid, 1, IntPtr.Zero, out o);
        return (IAudioEndpointVolume)o;
    }
    public static float GetVolume() { float v; Ep().GetMasterVolumeLevelScalar(out v); return v; }
    public static void SetVolume(float v) {
        if (v < 0f) v = 0f;
        if (v > 1f) v = 1f;
        Ep().SetMasterVolumeLevelScalar(v, Guid.Empty);
    }
    public static bool GetMute() { bool m; Ep().GetMute(out m); return m; }
    public static void SetMute(bool m) { Ep().SetMute(m, Guid.Empty); }
}

public static class Keys {
    // INPUT must be the size of the largest union member (MOUSEINPUT = 32 bytes) plus
    // type (4) and alignment padding => 40 bytes on x64. A 32-byte struct makes SendInput
    // return 0 and silently do nothing.
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
        [FieldOffset(8)] public HARDWAREINPUT hi;
    }
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    const uint EXTENDED = 0x0001;
    const uint KEYUP = 0x0002;

    static void One(ushort vk, ushort scan, bool extended, bool up) {
        INPUT[] a = new INPUT[1];
        a[0].type = 1;
        a[0].ki.wVk = vk;
        a[0].ki.wScan = scan;
        a[0].ki.dwFlags = (extended ? EXTENDED : 0) | (up ? KEYUP : 0);
        SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Press(ushort vk, ushort scan, bool extended) {
        One(vk, scan, extended, false);
        System.Threading.Thread.Sleep(30);
        One(vk, scan, extended, true);
    }
}

public static class Win {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

    // Returns "hwnd|title|cls" for the best matching visible window, or "" when nothing matches.
    public static string Find(string pattern) {
        string best = "";
        int bestScore = -1;
        EnumWindows((h, p) => {
            if (!IsWindowVisible(h)) return true;
            var t = new System.Text.StringBuilder(256); GetWindowTextW(h, t, 256);
            if (t.Length == 0) return true;
            var c = new System.Text.StringBuilder(128); GetClassNameW(h, c, 128);
            string title = t.ToString(), cls = c.ToString();
            string both = title + " " + cls;
            if (!System.Text.RegularExpressions.Regex.IsMatch(both, pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return true;
            if (System.Text.RegularExpressions.Regex.IsMatch(cls, "Shadow|LyraUI|Overlay|Tooltip", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return true;
            int score = System.Text.RegularExpressions.Regex.IsMatch(cls, "BasicWindow|MainWindow", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ? 10 : 1;
            if (score > bestScore) { bestScore = score; best = h.ToInt64() + "|" + title + "|" + cls; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    public static long Activate(long handle) {
        IntPtr target = new IntPtr(handle);
        IntPtr prev = GetForegroundWindow();
        if (prev == target) return prev.ToInt64();   // 已经是前台：什么都不做
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(prev, out dummy);
        uint myThread = GetCurrentThreadId();
        // 关键：SW_RESTORE(9) 会把"最大化/全屏"窗口还原成普通大小。
        // 只有真正最小化时才用 9，否则用 SW_SHOW(5)，绝不改变窗口大小。
        if (IsIconic(target)) ShowWindow(target, 9); else ShowWindow(target, 5);
        if (fgThread != myThread) AttachThreadInput(myThread, fgThread, true);
        BringWindowToTop(target);
        SetForegroundWindow(target);
        if (fgThread != myThread) AttachThreadInput(myThread, fgThread, false);
        return prev.ToInt64();
    }
}
'@

# Allowed keys only: reversible, common, harmless
$script:KeyMap = @{
    'space'            = @(0x20, 0x39, $false)
    'enter'            = @(0x0D, 0x1C, $false)
    'esc'              = @(0x1B, 0x01, $false)
    'up'               = @(0x26, 0x48, $true)
    'down'             = @(0x28, 0x50, $true)
    'left'             = @(0x25, 0x4B, $true)
    'right'            = @(0x27, 0x4D, $true)
    'media_play_pause' = @(0xB3, 0x22, $true)
    'media_next'       = @(0xB0, 0x19, $true)
    'media_prev'       = @(0xB1, 0x10, $true)
    'media_stop'       = @(0xB2, 0x24, $true)
    'volume_mute'      = @(0xAD, 0x20, $true)
    'volume_up'        = @(0xAF, 0x30, $true)
    'volume_down'      = @(0xAE, 0x2E, $true)
}

function Get-Brightness {
    $m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop
    if (-not $m) { throw 'no internal display' }
    return [int](($m | Select-Object -First 1).CurrentBrightness)
}

function Set-Brightness([int]$percent) {
    $methods = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
    if (-not $methods) { throw 'no internal display' }
    foreach ($m in $methods) {
        Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]$percent } -ErrorAction Stop | Out-Null
    }
    return (Get-Brightness)
}

function Send-Reply($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}



# ---------------- dsh.send：发送 DeepSeek Harness 输入框里的草稿 ----------------
# 不用 Enter：Enter 会把输入法正在组词/残留草稿直接发出去。这里用 UI Automation 直接点
# 「发送」按钮：不抢焦点、不怕输入法；点前校验草稿非空、与上次不同、按钮不是「停止生成」。

# ---------------- dsh.focus：把光标放进 DSH 输入框 ----------------
# 只做两件事：把 DSH 窗口调到前台、把 UIA 焦点设到 composer。不输入内容、不抢已有草稿。
function Focus-DshComposer() {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop

    $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
    if (-not $procs) { return @{ ok = $false; error = '找不到 DeepSeek Harness 窗口（可能已关闭）' } }
    $win = $procs | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
    if (-not $win) { $win = $procs | Select-Object -First 1 }

    $null = [Win]::Activate([int64]$win.MainWindowHandle)
    Start-Sleep -Milliseconds 250
    $fg = [Win]::GetForegroundWindow().ToInt64()
    if ($fg -ne [int64]$win.MainWindowHandle) {
        $null = [Win]::Activate([int64]$win.MainWindowHandle)
        Start-Sleep -Milliseconds 300
        $fg = [Win]::GetForegroundWindow().ToInt64()
    }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($win.MainWindowHandle)
    $cp = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'GRgSLq_input')
    $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cp)
    if (-not $edit) {
        $condType = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condType)
        foreach ($e in $edits) {
            if ($e.Current.Name -match '发消息|发送消息|消息或任务|composer') { $edit = $e; break }
        }
    }
    if (-not $edit) { return @{ ok = $false; error = '找不到 DSH 输入框（DSH 版本可能更新了）' } }

    try { $edit.SetFocus() } catch { return @{ ok = $false; error = ('设置焦点失败: ' + $_.Exception.Message) } }
    Start-Sleep -Milliseconds 150

    $focusedOk = $false
    try {
        $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($fe) { $focusedOk = ($fe.Current.ClassName -eq $edit.Current.ClassName) }
    } catch { }

    return @{ ok = $true; focused = $focusedOk; foreground = ([int64]$fg -eq [int64]$win.MainWindowHandle); title = [string]$win.MainWindowTitle; note = '光标已放进 DSH 输入框' }
}

function Send-DshMessage([bool]$dedupe) {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop

    $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
    if (-not $procs) { return @{ ok = $false; error = '找不到 DeepSeek Harness 窗口' } }
    $win = $procs | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
    if (-not $win) { $win = $procs | Select-Object -First 1 }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($win.MainWindowHandle)
    $cp = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'GRgSLq_input')
    $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cp)
    if (-not $edit) {
        $condType = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condType)
        foreach ($e in $edits) {
            if ($e.Current.Name -match '发消息|发送消息|消息或任务|composer') { $edit = $e; break }
        }
    }
    if (-not $edit) { return @{ ok = $false; error = '找不到 DSH 输入框（DSH 版本可能更新了）' } }

    $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $draft = [string]$vp.Current.Value
    if ([string]::IsNullOrWhiteSpace($draft)) { return @{ ok = $false; error = '草稿为空，未发送' } }

    $lastFile = Join-Path (Join-Path $env:LOCALAPPDATA 'VoiceKeys') 'dsh-last-sent.txt'
    if ($dedupe -and (Test-Path $lastFile)) {
        try {
            $last = (Get-Content $lastFile -Raw -ErrorAction Stop)
            if ($last) { $last = $last.Trim() }
            if ($last -and $last -eq $draft.Trim()) {
                return @{ ok = $false; error = '草稿与上次发送内容相同，疑似重复，未发送' }
            }
        } catch { }
    }

    $cb = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'GRgSLq_primary')
    $btn = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cb)
    if (-not $btn) {
        $condBtn = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
        $btns = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condBtn)
        foreach ($b in $btns) {
            if ($b.Current.Name -match '发送') { $btn = $b; break }
        }
    }
    if (-not $btn) { return @{ ok = $false; error = '找不到 DSH 发送按钮' } }
    $btnName = [string]$btn.Current.Name
    if ($btnName -match '停止') { return @{ ok = $false; error = ('DSH 正在生成，按钮是「' + $btnName + '」，已取消') } }

    try {
        $inv = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $inv.Invoke()
    } catch {
        return @{ ok = $false; error = ('点击发送按钮失败: ' + $_.Exception.Message) }
    }
    Start-Sleep -Milliseconds 400
    $cleared = $false
    try { $cleared = [string]::IsNullOrWhiteSpace([string]$vp.Current.Value) } catch { }
    try { Set-Content -Path $lastFile -Value $draft -Encoding UTF8 -Force } catch { }
    return @{ ok = $true; button = $btnName; chars = $draft.Length; cleared = $cleared; note = ('已点击「' + $btnName + '」发送（' + $draft.Length + ' 字符）') }
}

Send-Reply @{ ok = $true; ready = $true; pid = $PID }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    try {
        $cmd = $line | ConvertFrom-Json
        switch ($cmd.op) {
            'ping' {
                Send-Reply @{ ok = $true; pong = $true }
            }
            'audio.get' {
                Send-Reply @{ ok = $true; volume = [math]::Round(([Audio]::GetVolume()), 3); muted = [Audio]::GetMute() }
            }
            'audio.set' {
                [Audio]::SetVolume([double]$cmd.value)
                Send-Reply @{ ok = $true; volume = [math]::Round(([Audio]::GetVolume()), 3); muted = [Audio]::GetMute() }
            }
            'audio.mute' {
                # Read the real state and write the real state: no remembered flag,
                # so consecutive commands can never pollute each other.
                $current = [Audio]::GetMute()
                $desired = $null
                if ($null -ne $cmd.value -and "$($cmd.value)" -ne '') { $desired = [bool]$cmd.value }
                elseif ($cmd.toggle) { $desired = -not $current }
                if ($null -eq $desired) { $desired = $current }
                if ($desired -ne $current) {
                    [Audio]::SetMute([bool]$desired)
                    Start-Sleep -Milliseconds 60
                }
                Send-Reply @{ ok = $true; muted = [Audio]::GetMute(); volume = [math]::Round(([Audio]::GetVolume()), 3); changed = ($desired -ne $current) }
            }
            'display.get' {
                Send-Reply @{ ok = $true; brightness = (Get-Brightness) }
            }
            'display.set' {
                Send-Reply @{ ok = $true; brightness = (Set-Brightness ([int]$cmd.value)) }
            }
            'key.press' {
                $key = [string]$cmd.key
                if (-not $script:KeyMap.ContainsKey($key)) { throw ('key not allowed: ' + $key) }
                $spec = $script:KeyMap[$key]
                [Keys]::Press([uint16]$spec[0], [uint16]$spec[1], [bool]$spec[2])
                Send-Reply @{ ok = $true; key = $key }
            }
            'dsh.send' {
                $r = Send-DshMessage ([bool]$cmd.dedupe)
                Send-Reply $r
            }
            'dsh.focus' {
                $r = Focus-DshComposer
                Send-Reply $r
            }
            'window.find' {
                $m = [Win]::Find([string]$cmd.match)
                if ($m -eq '') { Send-Reply @{ ok = $false; error = 'no match' } }
                else {
                    $parts = $m -split '\|', 3
                    Send-Reply @{ ok = $true; hwnd = [int64]$parts[0]; title = $parts[1]; cls = $parts[2] }
                }
            }
            'window.activate' {
                $prev = [Win]::Activate([int64]$cmd.hwnd)
                Start-Sleep -Milliseconds 120
                Send-Reply @{ ok = $true; prev = $prev; foreground = [Win]::GetForegroundWindow().ToInt64() }
            }
            'window.state' {
                $h2 = [int64]$cmd.hwnd
                $tp = [IntPtr]$h2
                Send-Reply @{ ok = $true; maximized = [Win]::IsZoomed($tp); minimized = [Win]::IsIconic($tp) }
            }
            'window.restore' {
                if ([int64]$cmd.hwnd -ne 0) { $null = [Win]::Activate([int64]$cmd.hwnd); Start-Sleep -Milliseconds 80 }
                Send-Reply @{ ok = $true; foreground = [Win]::GetForegroundWindow().ToInt64() }
            }            'wait' {
                Start-Sleep -Milliseconds ([int]$cmd.ms)
                Send-Reply @{ ok = $true; waited = [int]$cmd.ms }
            }
            default {
                throw ('unknown op: ' + $cmd.op)
            }
        }
    } catch {
        Send-Reply @{ ok = $false; error = $_.Exception.Message }
    }
}
