// 新增原语 dsh.focus：把键盘焦点（光标）放进 DSH 输入框；并把「输入框」「写消息」绑上
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// ---------- 1) worker.ps1（UTF-8 with BOM）：加 Focus-DshComposer + case ----------
{
  const f = path.join(ROOT, 'runtime', 'worker.ps1');
  let s = fs.readFileSync(f, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

  const FN = `
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
`;

  if (!s.includes('function Focus-DshComposer')) {
    const anchor = 'function Send-DshMessage(';
    s = s.replace(anchor, FN + '\n' + anchor);
  }

  const CASE = `            'dsh.focus' {
                $r = Focus-DshComposer
                Send-Reply $r
            }
`;
  if (!s.includes("'dsh.focus'")) {
    const anchor2 = '            \'window.find\' {';
    if (!s.includes(anchor2)) { console.log('  worker: anchor2 not found'); } else {
      s = s.replace(anchor2, CASE + anchor2);
    }
  }

  fs.writeFileSync(f, Buffer.from('\ufeff' + s, 'utf8'));
  const back = fs.readFileSync(f, 'utf8');
  console.log('  worker.ps1: fn=' + back.includes('function Focus-DshComposer') + "  case=" + back.includes("'dsh.focus'"));
}

// ---------- 2) core.js：加原语 ----------
{
  const f = path.join(ROOT, 'src', 'core.js');
  let s = fs.readFileSync(f, 'utf8');
  const BLOCK = `
  {
    id: 'dsh.focus',
    kind: 'system',
    desc: '把键盘焦点（光标）放进 DeepSeek Harness 的输入框：必要时把 DSH 窗口调到前台；不输入内容、不动已有草稿',
    params: {},
    reversible: false,
    risk: 'safe',
    toWorker: () => ({ op: 'dsh.focus' }),
  },
`;
  if (!s.includes("id: 'dsh.focus'")) {
    const anchor = `  {
    id: 'dsh.send',`;
    s = s.replace(anchor, BLOCK + '\n' + anchor);
  }
  fs.writeFileSync(f, s, 'utf8');
  console.log('  core.js: 原语=' + s.includes("id: 'dsh.focus'"));
}
