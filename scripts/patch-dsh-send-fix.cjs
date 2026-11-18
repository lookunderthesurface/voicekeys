// 修正版补丁：worker.ps1 是 UTF-16LE（带 BOM），必须用 utf16le 读写；core.js 是 UTF-8
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// ---------- 1) worker.ps1（UTF-16LE） ----------
{
  const f = path.join(ROOT, 'runtime', 'worker.ps1');
  let s = fs.readFileSync(f, 'utf16le');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

  const fn = `
# ---------------- dsh.send：发送 DeepSeek Harness 输入框里的草稿 ----------------
# 为什么不用 Enter：Enter 会把正在输入的法和残留草稿直接发出去；用 UI Automation 直接点
# 「发送」按钮更安全，不需要抢焦点，也不怕输入法组词。点之前校验：草稿非空、与上次不同、
# 按钮不是「停止生成」。
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
        # 兜底：按控件类型 + 名字找 composer（CSS 类名会随 DSH 版本变）
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
            if ($b.Current.Name -match '^发送$|^发送消息$|^排队发送$') { $btn = $b; break }
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

  if (!s.includes('function Send-DshMessage')) {
    s = s.replace('Send-Reply @{ ok = $true; ready = $true; pid = $PID }', fn + '\nSend-Reply @{ ok = $true; ready = $true; pid = $PID }');
  }

  const caseBlock = `            'dsh.send' {
                $r = Send-DshMessage ([bool]$cmd.dedupe)
                Send-Reply $r
            }
`;
  if (!s.includes("'dsh.send'")) {
    const anchor = `                Send-Reply @{ ok = $true; key = $key }
            }
            'window.find' {`;
    if (!s.includes(anchor)) {
      console.log('  worker.ps1: 锚点未匹配！');
    } else {
      s = s.replace(anchor, `                Send-Reply @{ ok = $true; key = $key }
            }
` + caseBlock + `            'window.find' {`);
    }
  }

  const out = Buffer.from('\ufeff' + s, 'utf16le');
  fs.writeFileSync(f, out);
  const check = fs.readFileSync(f, 'utf16le');
  console.log('  worker.ps1: 函数=' + check.includes('function Send-DshMessage') + "  case=" + check.includes("'dsh.send'") + '  BOM=' + (fs.readFileSync(f)[0] === 0xFF));
}

// ---------- 2) core.js（UTF-8） ----------
{
  const f = path.join(ROOT, 'src', 'core.js');
  let s = fs.readFileSync(f, 'utf8');
  const block = `
  {
    id: 'dsh.send',
    kind: 'system',
    desc: '发送 DeepSeek Harness 输入框里的草稿：UI Automation 直接点「发送」按钮（不抢焦点、不怕输入法）；草稿为空 / 与上次相同 / DSH 正在生成时拒绝',
    params: { dedupe: { type: 'boolean', default: true } },
    reversible: false,
    risk: 'safe',
    toWorker: (p) => ({ op: 'dsh.send', dedupe: p.dedupe !== false }),
  },
`;
  if (!s.includes("id: 'dsh.send'")) {
    const anchor = `      return { ok: true, changed: true, recording: want, note: want ? '已开始 Handy 录音' : '已停止 Handy 录音' };
    },
  },`;
    s = s.replace(anchor, anchor + '\n' + block);
  }
  fs.writeFileSync(f, s, 'utf8');
  console.log('  core.js: 原语=' + s.includes("id: 'dsh.send'"));
}
