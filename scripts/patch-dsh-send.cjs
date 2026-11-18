// 打补丁：新增 dsh.send 原语（UIA 点 DSH 发送按钮 + 草稿校验/去重），并把「发送」类绑定切过去
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// ---------- 1) worker.ps1：加函数 + switch case ----------
{
  const f = path.join(ROOT, 'runtime', 'worker.ps1');
  let s = fs.readFileSync(f, 'utf8');

  const fn = `
# ---------------- dsh.send：发送 DeepSeek Harness 输入框里的草稿 ----------------
# 为什么不用 Enter：Enter 会把正在输入的法/或残留草稿直接发出去；用 UI Automation 直接点
# 「发送」按钮更安全，而且不需要抢焦点、不怕输入法组词。点之前校验：草稿非空、与上次不同、
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

    $dataDir = Join-Path $env:LOCALAPPDATA 'VoiceKeys'
    $lastFile = Join-Path $dataDir 'dsh-last-sent.txt'
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
        # 兜底按名字找「发送」按钮
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
    const anchor = "Send-Reply @{ ok = $true; ready = $true; pid = $PID }";
    s = s.replace(anchor, fn + '\n' + anchor);
  }

  const caseBlock = `            'dsh.send' {
                $r = Send-DshMessage ([bool]$cmd.dedupe)
                Send-Reply $r
            }
`;
  if (!s.includes("'dsh.send'")) {
    const anchor2 = `                [Keys]::Press([uint16]$spec[0], [uint16]$spec[1], [bool]$spec[2])
                Send-Reply @{ ok = $true; key = $key }
            }`;
    s = s.replace(anchor2, anchor2 + '\n' + caseBlock);
  }
  fs.writeFileSync(f, s, 'utf8');
  console.log('  worker.ps1: 函数=' + s.includes('function Send-DshMessage') + '  case=' + s.includes("'dsh.send'"));
}

// ---------- 2) core.js：加原语 ----------
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

// ---------- 3) plans.json：发送类绑定改走 dsh.send ----------
{
  const f = path.join(ROOT, '..', '..', '..', '..', '..', 'AppData', 'Local', 'VoiceKeys', 'plans.json');
  const dataFile = path.join(process.env.LOCALAPPDATA, 'VoiceKeys', 'plans.json');
  const target = fs.existsSync(dataFile) ? dataFile : null;
  if (!target) {
    console.log('  plans.json: 未找到（跳过）');
  } else {
    const backup = path.join(process.env.TEMP, 'plans.json.bak-' + Date.now());
    fs.copyFileSync(target, backup);
    const obj = JSON.parse(fs.readFileSync(target, 'utf8'));
    let n = 0;
    for (const [word, entry] of Object.entries(obj)) {
      if (!/^发送/.test(word)) continue;
      if (!entry || !entry.plan) continue;
      entry.plan = { steps: [{ op: 'dsh.send' }] };
      entry.boundAt = entry.boundAt || new Date().toISOString();
      n += 1;
    }
    fs.writeFileSync(target, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    console.log('  plans.json: 改了 ' + n + ' 条发送绑定；备份=' + backup);
  }
}
