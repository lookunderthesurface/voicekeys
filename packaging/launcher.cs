// VoiceKeys 启动器 / 守护进程（用系统自带 csc 编译，不需要额外工具链）
//
// 为什么是"守护进程"而不只是"启动一次"：
// 2026-11-16 用户反馈"喊了没反应"，查下来是进程在夜里没了（日志最后一条是麦克风读取失败）。
// 桌面常驻应用必须自己看住自己：node 退出就按退避重启，并把每次重启写进 supervisor.log。
//
// 用法：
//   VoiceKeys.exe            启动（若已在跑则只开浏览器）
//   VoiceKeys.exe --stop     停止守护进程与 node 子进程
//   VoiceKeys.exe --no-browser   启动但不自动打开浏览器
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;

class VoiceKeysLauncher
{
    const int Port = 19600;
    const string Marker = "VoiceKeys supervisor";

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
        // 用 WMI 找同名进程（不是本进程），避免重复守护
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

    static void StopAll()
    {
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
        foreach (var pid in FindSupervisors())
        {
            try { Process.GetProcessById(pid).Kill(); Append("supervisor.log", "已结束另一个守护进程 PID " + pid); }
            catch { }
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
        var node = Path.Combine(baseDir, "runtime", "node.exe");
        var server = Path.Combine(baseDir, "app", "server.js");
        if (!File.Exists(node) || !File.Exists(server))
        {
            Append("supervisor.log", "安装不完整：缺 runtime\\node.exe 或 app\\server.js（" + baseDir + "）");
            return 2;
        }

        // 已经有实例在跑：只开浏览器
        if (PortOpen())
        {
            if (!noBrowser) OpenBrowser();
            Append("supervisor.log", "已有实例在跑，只打开浏览器");
            return 0;
        }

        Append("supervisor.log", Marker + " 启动，安装目录 " + baseDir);

        int backoff = 1000;
        bool opened = false;
        while (true)
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
            }
            catch (Exception ex)
            {
                Append("supervisor.log", "启动 node 失败: " + ex.Message);
                Thread.Sleep(backoff);
                continue;
            }

            // 等端口就绪 → 开浏览器
            for (int i = 0; i < 60 && !proc.HasExited; i++)
            {
                Thread.Sleep(500);
                if (PortOpen())
                {
                    if (!opened && !noBrowser) { OpenBrowser(); opened = true; }
                    break;
                }
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
}
