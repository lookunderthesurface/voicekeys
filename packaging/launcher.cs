// VoiceKeys 启动器 / 守护进程 + 通知区托盘图标（系统自带 csc 编译）
//
// 为什么是"守护进程"：2026-11-16 用户反馈"喊了没反应"，查下来是进程夜里没了。
// 桌面常驻应用必须自己看住自己：node 退出就按退避重启，每次重启写 supervisor.log。
//
// 2026-11-18 用户要求：后台运行时必须在 Windows 右下角通知区有托盘图标（和其他 APP 一样）。
// 所以主线程跑 WinForms 消息循环 + NotifyIcon，守护逻辑放在后台线程。
//
// 用法：
//   VoiceKeys.exe                启动（已在跑则只开浏览器）
//   VoiceKeys.exe --no-browser   启动但不自动开浏览器（开机自启用这个）
//   VoiceKeys.exe --stop         停止托盘守护与 node 子进程
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class VoiceKeysLauncher
{
    const int Port = 19600;
    const string Marker = "VoiceKeys supervisor";

    static volatile bool quit = false;
    static Process nodeProc = null;

    static string BaseDir() { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'); }
    static string DataDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VoiceKeys");
    }
    static string LogsDir() { return Path.Combine(DataDir(), "logs"); }

    static void Append(string name, string line)
    {
        try
        {
            Directory.CreateDirectory(LogsDir());
            lock (typeof(VoiceKeysLauncher))
            {
                File.AppendAllText(Path.Combine(LogsDir(), name),
                    DateTime.Now.ToString("HH:mm:ss.fff") + "  " + line + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch { }
    }

    static bool PortOpen()
    {
        try
        {
            using (var c = new TcpClient())
            {
                var ar = c.BeginConnect("127.0.0.1", Port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(300)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static void OpenBrowser()
    {
        try { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + Port + "/") { UseShellExecute = true }); }
        catch { }
    }

    static int[] FindSupervisors()
    {
        var list = new System.Collections.Generic.List<int>();
        try
        {
            var self = Process.GetCurrentProcess().Id;
            foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(System.Reflection.Assembly.GetExecutingAssembly().Location)))
            {
                if (p.Id != self) list.Add(p.Id);
            }
        }
        catch { }
        return list.ToArray();
    }

    static void KillNode()
    {
        try
        {
            if (nodeProc != null && !nodeProc.HasExited) nodeProc.Kill();
        }
        catch { }
        try
        {
            var pidFile = Path.Combine(DataDir(), "app.pid");
            if (File.Exists(pidFile))
            {
                int pid;
                if (int.TryParse(File.ReadAllText(pidFile).Trim(), out pid))
                {
                    try { Process.GetProcessById(pid).Kill(); Append("supervisor.log", "已结束 node PID " + pid); }
                    catch { }
                }
            }
        }
        catch { }
    }

    static void StopAll()
    {
        quit = true;
        KillNode();
        foreach (var pid in FindSupervisors())
        {
            try { Process.GetProcessById(pid).Kill(); Append("supervisor.log", "已结束另一个守护进程 PID " + pid); }
            catch { }
        }
    }

    /// 后台线程：起 node、转发日志、挂了就退避重启
    static void Supervise(string baseDir, bool noBrowser)
    {
        var node = Path.Combine(baseDir, "runtime", "node.exe");
        var server = Path.Combine(baseDir, "app", "server.js");
        int backoff = 1000;
        bool opened = false;

        while (!quit)
        {
            var psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = "\"" + server + "\" --port " + Port;
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            Process proc;
            try
            {
                proc = new Process();
                proc.StartInfo = psi;
                proc.OutputDataReceived += (s, e) => { if (e.Data != null) Append("stdout.log", e.Data); };
                proc.ErrorDataReceived += (s, e) => { if (e.Data != null) Append("stderr.log", e.Data); };
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                nodeProc = proc;
            }
            catch (Exception ex)
            {
                Append("supervisor.log", "启动 node 失败: " + ex.Message);
                Thread.Sleep(backoff);
                continue;
            }

            for (int i = 0; i < 120 && !proc.HasExited && !quit; i++)
            {
                Thread.Sleep(500);
                if (PortOpen())
                {
                    if (!opened && !noBrowser) { OpenBrowser(); opened = true; }
                    break;
                }
            }

            if (quit)
            {
                try { if (!proc.HasExited) proc.Kill(); } catch { }
                break;
            }

            proc.WaitForExit();
            int code = proc.ExitCode;
            Append("supervisor.log", "node 退出（代码 " + code + "），" + (backoff / 1000.0) + " 秒后重启");
            try { proc.Dispose(); } catch { }
            Thread.Sleep(backoff);
            backoff = Math.Min(backoff * 2, 30000);
            if (PortOpen()) { Thread.Sleep(3000); }
        }
    }

    /// Windows 11 默认把新托盘图标放进"隐藏的图标"溢出面板。
    /// 把 NotifyIconSettings 里本 exe 对应项的 IsPromoted 置 1，图标就会常驻通知区（和用户熟悉的其他 APP 一样）。
    /// shell 是在图标注册后才写这个键的，所以要轮询重试。
    static void PromoteNotifyIcon(string exePath)
    {
        for (int attempt = 0; attempt < 25; attempt++)
        {
            try
            {
                using (var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings", false))
                {
                    if (root != null)
                    {
                        foreach (var name in root.GetSubKeyNames())
                        {
                            using (var k = root.OpenSubKey(name, true))
                            {
                                if (k == null) continue;
                                var p = k.GetValue("ExecutablePath") as string;
                                if (string.IsNullOrEmpty(p)) continue;
                                if (!string.Equals(Path.GetFullPath(p), Path.GetFullPath(exePath), StringComparison.OrdinalIgnoreCase)) continue;
                                var cur = k.GetValue("IsPromoted");
                                if (cur is int && (int)cur == 1) return;
                                k.SetValue("IsPromoted", 1, Microsoft.Win32.RegistryValueKind.DWord);
                                Append("supervisor.log", "托盘图标已设为常驻通知区");
                                return;
                            }
                        }
                    }
                }
            }
            catch { }
            Thread.Sleep(300);
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        bool stop = false, noBrowser = false;
        foreach (var a in args)
        {
            if (a == "--stop") stop = true;
            if (a == "--no-browser") noBrowser = true;
        }

        if (stop) { StopAll(); return 0; }

        var baseDir = BaseDir();
        if (!File.Exists(Path.Combine(baseDir, "runtime", "node.exe")) ||
            !File.Exists(Path.Combine(baseDir, "app", "server.js")))
        {
            Append("supervisor.log", "安装不完整：缺 runtime\\node.exe 或 app\\server.js（" + baseDir + "）");
            return 2;
        }

        if (PortOpen())
        {
            if (!noBrowser) OpenBrowser();
            Append("supervisor.log", "已有实例在跑，只打开浏览器");
            return 0;
        }

        Append("supervisor.log", Marker + " 启动，安装目录 " + baseDir);

        var t = new Thread(() => Supervise(baseDir, noBrowser));
        t.IsBackground = true;
        t.Start();

        // ---- 通知区托盘图标 ----
        Icon trayIcon = null;
        try { trayIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        if (trayIcon == null) trayIcon = SystemIcons.Application;

        var ni = new NotifyIcon();
        ni.Icon = trayIcon;
        ni.Text = "VoiceKeys（正在听）";
        ni.Visible = true;
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开控制台", null, (s, e) => OpenBrowser());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出 VoiceKeys", null, (s, e) =>
        {
            Append("supervisor.log", "托盘菜单：退出");
            StopAll();
            ni.Visible = false;
            Application.Exit();
        });
        ni.ContextMenuStrip = menu;
        ni.DoubleClick += (s, e) => OpenBrowser();

        // 让托盘图标常驻通知区（Windows 11 默认会把新图标塞进"隐藏的图标"）
        var promote = new Thread(() => PromoteNotifyIcon(Application.ExecutablePath));
        promote.IsBackground = true;
        promote.Start();

        Application.Run();

        ni.Visible = false;
        ni.Dispose();
        StopAll();
        return 0;
    }
}
