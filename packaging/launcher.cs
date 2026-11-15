// VoiceKeys 启动器（.NET Framework 自带 csc 编译，不需要额外工具链）
//
// 为什么要有它：用户下载 zip 解压后双击一个 exe 就能用，不需要装 Node、不弹黑框。
// 它做的事：① 如果 19600 已经在监听 → 直接开浏览器；② 否则静默拉起 runtime\node.exe app\server.js，
// 把 stdout/stderr 写进 %LOCALAPPDATA%\VoiceKeys\logs\；③ 等端口起来再开浏览器。
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;

class VoiceKeysLauncher
{
    const int Port = 19600;

    static string BaseDir()
    {
        return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    }

    static string DataDir()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(local, "VoiceKeys");
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

    [STAThread]
    static int Main(string[] args)
    {
        var baseDir = BaseDir();
        var node = Path.Combine(baseDir, "runtime", "node.exe");
        var server = Path.Combine(baseDir, "app", "server.js");

        if (!File.Exists(node) || !File.Exists(server))
        {
            Console.Error.WriteLine("安装不完整：找不到 runtime\\node.exe 或 app\\server.js");
            return 2;
        }

        // 已经在跑：直接开浏览器
        if (PortOpen())
        {
            OpenBrowser();
            return 0;
        }

        var logs = Path.Combine(DataDir(), "logs");
        Directory.CreateDirectory(logs);

        var psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = "\"" + server + "\" --port " + Port;
        psi.WorkingDirectory = baseDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;

        var proc = new Process();
        proc.StartInfo = psi;
        proc.OutputDataReceived += (s, e) => { if (e.Data != null) Append(Path.Combine(logs, "stdout.log"), e.Data); };
        proc.ErrorDataReceived += (s, e) => { if (e.Data != null) Append(Path.Combine(logs, "stderr.log"), e.Data); };
        proc.Start();
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        // 等端口（最多 30 秒），起来就开浏览器
        for (int i = 0; i < 60; i++)
        {
            Thread.Sleep(500);
            if (PortOpen()) { OpenBrowser(); return 0; }
            if (proc.HasExited)
            {
                Append(Path.Combine(logs, "stdout.log"), "[launcher] node 退出，代码 " + proc.ExitCode);
                return (int)proc.ExitCode;
            }
        }

        Append(Path.Combine(logs, "stdout.log"), "[launcher] 30 秒内端口未就绪，请看 logs/ 下的日志");
        return 3;
    }

    static void Append(string file, string line)
    {
        try
        {
            lock (typeof(VoiceKeysLauncher))
            {
                File.AppendAllText(file, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + line + Environment.NewLine);
            }
        }
        catch { }
    }
}
