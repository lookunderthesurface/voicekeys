// VoiceKeys 卸载器（10KB 级别的小程序，编译进安装包 payload）
//
// 为什么单独写：之前 uninstall.exe 是 setup.exe 的副本，等于把整个 45MB payload 又存了一份，
// 安装体积 166MB 里有 45MB 是重复的。这个小程序只做卸载该做的事。
//
// 删什么：
//   程序目录   %LOCALAPPDATA%\Programs\VoiceKeys
//   开始菜单   %APPDATA%\...\Start Menu\Programs\VoiceKeys\
//   桌面快捷方式 VoiceKeys.lnk
//   注册表     HKCU\...\Uninstall\VoiceKeys（控制面板里的条目）
//              HKCU\...\Run\VoiceKeys（如果用户自己加过开机自启）
// 不删什么：
//   数据目录   %LOCALAPPDATA%\VoiceKeys（模型、词表、设置、录音素材）
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

class VoiceKeysUninstall
{
    static string InstallDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "VoiceKeys");
    }
    static string DataDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VoiceKeys");
    }
    static void Log(string msg)
    {
        try
        {
            Directory.CreateDirectory(DataDir());
            File.AppendAllText(Path.Combine(DataDir(), "uninstall.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine);
        }
        catch { }
    }

    static void KillAll()
    {
        // 先停守护进程，再停 node 子进程，避免它们又把文件占住
        foreach (var name in new[] { "VoiceKeys" })
        {
            foreach (var p in Process.GetProcessesByName(name))
            {
                try { p.Kill(); Log("结束进程 " + name + " " + p.Id); } catch { }
            }
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

    [STAThread]
    static void Main(string[] args)
    {
        bool silent = Array.IndexOf(args, "--silent") >= 0;
        if (!silent)
        {
            var r = MessageBox.Show(
                "确定卸载 VoiceKeys 吗？\n\n程序会被删除；你的数据（模型、关键词、设置、录音素材）会保留在：\n" + DataDir(),
                "卸载 VoiceKeys", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return;
        }

        Log("开始卸载");
        KillAll();

        // 开始菜单 + 桌面
        try
        {
            var menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "VoiceKeys");
            if (Directory.Exists(menu)) { Directory.Delete(menu, true); Log("已删开始菜单项"); }
        }
        catch (Exception e) { Log("删开始菜单失败: " + e.Message); }
        try
        {
            var lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "VoiceKeys.lnk");
            if (File.Exists(lnk)) { File.Delete(lnk); Log("已删桌面快捷方式"); }
        }
        catch (Exception e) { Log("删桌面快捷方式失败: " + e.Message); }

        // 注册表（HKCU，不需要管理员）
        try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceKeys", false); Log("已删卸载项"); }
        catch (Exception e) { Log("删卸载项失败: " + e.Message); }
        try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Run\VoiceKeys", false); }
        catch { }

        // 程序目录：自己还在里面运行，交给 cmd 延迟删
        var dir = InstallDir();
        try
        {
            Process.Start(new ProcessStartInfo("cmd.exe",
                "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + dir + "\"")
            { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
            Log("已安排删除程序目录 " + dir);
        }
        catch (Exception e) { Log("删除程序目录失败: " + e.Message); }

        Log("卸载完成；数据目录保留: " + DataDir());
        if (!silent)
        {
            MessageBox.Show("卸载完成。\n\n数据（模型/关键词/设置）保留在：\n" + DataDir() + "\n\n想彻底清空就手动删掉这个目录。",
                "VoiceKeys", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
