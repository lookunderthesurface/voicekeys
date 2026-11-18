// 把 dsh.send 注入 worker.ps1（UTF-16LE + BOM），用 indexOf 定位而不是整段 replace
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const f = path.join(ROOT, 'runtime', 'worker.ps1');

let s = fs.readFileSync(f, 'utf8');
if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

const A1 = 'Send-Reply @{ ok = $true; ready = $true; pid = $PID }';
const A2 = '            \'window.find\' {';

const i1 = s.indexOf(A1);
const i2 = s.indexOf(A2);
console.log('anchor1=' + i1 + '  anchor2=' + i2 + '  len=' + s.length);
if (i1 < 0 || i2 < 0) {
  const k = s.indexOf('Send-Reply @{ ok = $true');
  console.log('near ready:', JSON.stringify(s.slice(k - 40, k + 160)));
  process.exit(1);
}

const FN = `
# ---------------- dsh.send：发送 DeepSeek Harness 输入框里的草稿 ----------------
# 不用 Enter：Enter 会把输入法正在组词/残留草稿直接发出去。这里用 UI Automation 直接点
# 「发送」按钮：不抢焦点、不怕输入法；点前校验草稿非空、与上次不同、按钮不是「停止生成」。
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

`;

const CASE = `            'dsh.send' {
                $r = Send-DshMessage ([bool]$cmd.dedupe)
                Send-Reply $r
            }
`;

s = s.slice(0, i1) + FN + s.slice(i1);
// 重新定位（插入函数后索引变化）
const i2b = s.indexOf(A2);
if (i2b < 0) { console.log('case anchor lost'); process.exit(1); }
s = s.slice(0, i2b) + CASE + s.slice(i2b);

fs.writeFileSync(f, s, 'utf8');
const back = fs.readFileSync(f, 'utf8');
console.log('done: fn=' + back.includes('function Send-DshMessage') + "  case=" + back.includes("'dsh.send'"));
