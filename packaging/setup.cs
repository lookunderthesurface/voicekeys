// VoiceKeys 安装程序（单文件，用系统自带 csc 编译，payload 以 zip 资源嵌入）
//
// 为什么自己写：Inno Setup / NSIS 本机没有，而 .NET Framework 的 csc 是 Windows 自带，
// 不需要用户额外安装任何工具，也不需要管理员权限（按用户安装）。
//
// 安装位置（跟主流客户端一致，全部在用户目录，不需要 UAC）：
//   程序  %LOCALAPPDATA%\Programs\VoiceKeys
//   数据  %LOCALAPPDATA%\VoiceKeys          （首次运行时创建，卸载默认保留）
//
// 参数：--silent 静默安装（测试/自动部署用）；--uninstall 卸载
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

class VoiceKeysSetup
{
    const string AppName = "VoiceKeys";
    const string PayloadResource = "payload.zip";

    static string InstallDir()
    {
        // 测试用：允许用环境变量指定安装目录（正常安装时为空，走标准位置）
        var over = Environment.GetEnvironmentVariable("VOICEKEYS_INSTALL_DIR");
        if (!string.IsNullOrEmpty(over)) return over;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
    }
    static string DataDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName);
    }
    static void Log(string msg)
    {
        try
        {
            var over = Environment.GetEnvironmentVariable("VOICEKEYS_LOG_FILE");
            if (!string.IsNullOrEmpty(over))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(over));
                File.AppendAllText(over,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine);
                return;
            }
            Directory.CreateDirectory(DataDir());
            File.AppendAllText(Path.Combine(DataDir(), "install.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine);
        }
        catch { }
    }

    static void KillRunning()
    {
        try
        {
            foreach (var p in Process.GetProcessesByName("VoiceKeys"))
            {
                try { p.Kill(); Log("结束进程 VoiceKeys " + p.Id); } catch { }
            }
            var pidFile = Path.Combine(DataDir(), "app.pid");
            if (File.Exists(pidFile))
            {
                int pid;
                if (int.TryParse(File.ReadAllText(pidFile).Trim(), out pid))
                {
                    try { Process.GetProcessById(pid).Kill(); Log("结束 node " + pid); } catch { }
                }
            }
        }
        catch { }
    }

    static void Shortcut(string path, string target)
    {
        try
        {
            var dir = Path.GetDirectoryName(path);
            Directory.CreateDirectory(dir);
            // 用 WScript.Shell COM 建 .lnk，不需要任何额外依赖
            var t = Type.GetTypeFromProgID("WScript.Shell");
            var shell = Activator.CreateInstance(t);
            var lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
            lnk.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lnk.GetType().InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(target) });
            lnk.GetType().InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "VoiceKeys — 用说话控制电脑" });
            lnk.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }
        catch (Exception e) { Log("创建快捷方式失败 " + path + ": " + e.Message); }
    }

    static void Install(bool silent, bool noShortcuts)
    {
        string dir = InstallDir();
        Log("开始安装到 " + dir + (silent ? "（静默）" : ""));
        KillRunning();
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);

        // 直接在内存里解压 payload，不落临时文件：
        // ① 少一次 45MB 的磁盘写入；② 目标机 TEMP 被限制（企业策略/沙箱）时也不会失败。
        var asm = Assembly.GetExecutingAssembly();
        using (var stream = asm.GetManifestResourceStream(PayloadResource))
        {
            if (stream == null) { Log("payload 资源缺失，安装失败"); throw new InvalidOperationException("payload.zip 资源缺失"); }
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                // 注意：Compress-Archive 生成的目录条目既可能以 "/" 结尾，也可能带反斜杠，
                // 还有可能是零字节文件；一律先判断再落盘，否则 Path.Combine 出 "dir\" 会炸。
                foreach (var entry in zip.Entries)
                {
                    var name = entry.FullName.Replace('\\', '/');
                    if (name.EndsWith("/"))
                    {
                        Directory.CreateDirectory(Path.Combine(dir, name.TrimEnd('/').Replace('/', Path.DirectorySeparatorChar)));
                        continue;
                    }
                    var target = Path.Combine(dir, name.Replace('/', Path.DirectorySeparatorChar));
                    var parent = Path.GetDirectoryName(target);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    using (var src = entry.Open())
                    using (var dst = File.Create(target)) src.CopyTo(dst);
                }
            }
        }
        Log("文件已解压: " + dir);

        if (noShortcuts) { Log("跳过快捷方式/注册表（--no-shortcuts）"); return; }

        // 快捷方式
        string exe = Path.Combine(dir, "VoiceKeys.exe");
        string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName);
        Shortcut(Path.Combine(startMenu, "VoiceKeys.lnk"), exe);
        Shortcut(Path.Combine(startMenu, "停止 VoiceKeys.lnk"), Path.Combine(dir, "stop.cmd"));
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        Shortcut(Path.Combine(desktop, "VoiceKeys.lnk"), exe);

        // 开始菜单里的卸载入口 + 控制面板的卸载项（HKCU，不需要管理员）
        // payload 里自带一个小卸载器（约 10KB），不要再把自己复制一份（那是 45MB 的重复）
        string uninstaller = Path.Combine(dir, "uninstall.exe");
        if (!File.Exists(uninstaller)) Log("警告：payload 里没有 uninstall.exe");
        using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceKeys"))
        {
            if (k != null)
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayIcon", exe);
                k.SetValue("DisplayVersion", "0.2.0");
                k.SetValue("Publisher", "lookunderthesurface");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + uninstaller + "\" --uninstall");
                k.SetValue("NoModify", 1, Microsoft.Win32.RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, Microsoft.Win32.RegistryValueKind.DWord);
            }
        }
        Log("快捷方式与卸载入口已创建");
    }

    static void Uninstall()
    {
        Log("开始卸载");
        KillRunning();
        // 自启动项
        try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Run\VoiceKeys", false); }
        catch { }
        try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceKeys", false); }
        catch { }
        try { Directory.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName), true); } catch { }
        try { File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "VoiceKeys.lnk")); } catch { }
        // 程序目录延迟删除（自己还在里面运行）
        try
        {
            var dir = InstallDir();
            Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + dir + "\"") { CreateNoWindow = true, UseShellExecute = false });
        }
        catch { }
        Log("卸载完成（数据目录 " + DataDir() + " 已保留）");
    }

    [STAThread]
    static int Main(string[] args)
    {
        bool silent = Array.IndexOf(args, "--silent") >= 0;
        bool uninstall = Array.IndexOf(args, "--uninstall") >= 0;
        bool noShortcuts = Array.IndexOf(args, "--no-shortcuts") >= 0;

        if (uninstall) { Uninstall(); return 0; }

        try
        {
            Install(silent, noShortcuts);
        }
        catch (Exception e)
        {
            Log("安装失败: " + e);
            if (!silent) MessageBox.Show("安装失败：" + e.Message, AppName);
            return 1;
        }

        if (!silent)
        {
            var r = MessageBox.Show("安装完成。现在启动 VoiceKeys 吗？", AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r == DialogResult.Yes)
            {
                try { Process.Start(Path.Combine(InstallDir(), "VoiceKeys.exe")); } catch { }
            }
        }
        return 0;
    }
}
