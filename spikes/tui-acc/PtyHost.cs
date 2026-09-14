// PtyHost: 验收用 ConPTY 桥（源码在 spikes/tui-acc/ 入库；编译产物 PtyHost.exe 不入库）。
// 用法：PtyHost.exe <cols> <rows> <pidFile> -- <cmd> [args...]
// 行为：
//   - 建 ConPTY（cols x rows），在其内启动子进程（独立进程组）；
//   - 线程 A：自身 stdin → ConPTY 输入（原样字节）；
//   - 线程 B：ConPTY 输出 → 自身 stdout（原样字节）；
//   - 子进程 PID 写 pidFile（供驱动 taskkill 模拟崩溃）；
//   - 自身 stdin EOF → 向子进程组发 CTRL_C_EVENT（走优雅退出路径）；
//   - 子进程退出码原样透传。
// C# 5 语法（本机只有 .NET Framework 4.x 自带 csc）。
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class PtyHost
{
    [StructLayout(LayoutKind.Sequential)]
    private struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetStdHandle(int nStdHandle, IntPtr hHandle);

    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    private const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CTRL_C_EVENT = 0;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;

    private static int Main(string[] argv)
    {
        int sep = Array.IndexOf(argv, "--");
        if (sep != 3 || argv.Length < 5)
        {
            Console.Error.WriteLine("usage: PtyHost.exe <cols> <rows> <pidFile> -- <cmd> [args...]");
            return 2;
        }
        short cols = short.Parse(argv[0]);
        short rows = short.Parse(argv[1]);
        string pidFile = argv[2];
        string[] rest = new string[argv.Length - sep - 1];
        Array.Copy(argv, sep + 1, rest, 0, rest.Length);
        StringBuilder cmdLine = new StringBuilder();
        foreach (string a in rest)
        {
            if (cmdLine.Length > 0) cmdLine.Append(' ');
            cmdLine.Append('"').Append(a.Replace("\"", "\\\"")).Append('"');
        }

        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.bInheritHandle = true;

        IntPtr ptyInputRead, ourInputWrite;   // 我们写 ourInputWrite，pty 读 ptyInputRead
        IntPtr ptyOutputWrite, ourOutputRead; // pty 写 ptyOutputWrite，我们读 ourOutputRead
        if (!CreatePipe(out ptyInputRead, out ourInputWrite, ref sa, 0)) Fail("CreatePipe(in)");
        if (!CreatePipe(out ourOutputRead, out ptyOutputWrite, ref sa, 0)) Fail("CreatePipe(out)");
        // 我方端不可继承（子进程只继承 pty 侧）
        SetHandleInformation(ourInputWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(ourOutputRead, HANDLE_FLAG_INHERIT, 0);

        COORD size; size.X = cols; size.Y = rows;
        IntPtr hPC;
        int hr = CreatePseudoConsole(size, ptyInputRead, ptyOutputWrite, 0, out hPC);
        if (hr != 0) Fail("CreatePseudoConsole hr=" + hr);
        CloseHandle(ptyInputRead);
        CloseHandle(ptyOutputWrite);

        IntPtr attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        IntPtr attrList = Marshal.AllocHGlobal(attrSize);
        if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) Fail("InitAttrList");
        if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) Fail("UpdateAttr");

        // 子进程拿到 ConPTY 控制台句柄的关键：spawn 前把本进程 std 句柄置空——
        // 否则本进程被父进程管道重定向的 std 句柄会原样继承给子进程（实测 isTTY=undefined）。
        // 先缓存收发流供线程中继，再置空。
        Stream stdinStream = Console.OpenStandardInput();
        Stream stdoutStream = Console.OpenStandardOutput();
        SetStdHandle(STD_INPUT_HANDLE, IntPtr.Zero);
        SetStdHandle(STD_OUTPUT_HANDLE, IntPtr.Zero);
        SetStdHandle(STD_ERROR_HANDLE, IntPtr.Zero);

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.lpAttributeList = attrList;
        PROCESS_INFORMATION pi;
        // 不用 CREATE_NEW_PROCESS_GROUP：该标志会屏蔽子进程组的 CTRL_C_EVENT（文档行为），
        // 优雅退出依赖 Ctrl+C 投递。退出时 PtyHost 先忽略自身 Ctrl+C 再广播到伪控制台。
        if (!CreateProcessW(null, cmdLine, IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref si, out pi))
            Fail("CreateProcess err=" + Marshal.GetLastWin32Error() + " cmd=" + cmdLine);
        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(attrList);
        CloseHandle(pi.hThread);

        File.WriteAllText(pidFile, pi.dwProcessId.ToString());

        // 线程 B：pty 输出 → stdout（用事先缓存的流——本进程 std 句柄已在 spawn 前置空）
        Thread outThread = new Thread(delegate ()
        {
            try
            {
                using (FileStream src = new FileStream(new SafeFileHandle(ourOutputRead, false), FileAccess.Read, 4096, false))
                {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        stdoutStream.Write(buf, 0, n);
                        stdoutStream.Flush();
                    }
                }
            }
            catch { }
        });
        outThread.IsBackground = true;
        outThread.Start();

        // 线程 A：stdin → pty 输入；EOF → 发 CTRL_C_EVENT 让子进程走优雅退出
        Thread inThread = new Thread(delegate ()
        {
            try
            {
                using (FileStream dst = new FileStream(new SafeFileHandle(ourInputWrite, false), FileAccess.Write, 4096, false))
                {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = stdinStream.Read(buf, 0, buf.Length)) > 0)
                    {
                        dst.Write(buf, 0, n);
                        dst.Flush();
                    }
                }
            }
            catch { }
            // stdin EOF：通知子进程优雅退出。GenerateConsoleCtrlEvent 只投递给与调用方
            // 共享同一控制台的进程组，故先 AttachConsole 到子进程的（伪）控制台再发 CTRL_C；
            // 5 秒未退出则兜底强杀（验收不允许悬挂）。
            try
            {
                FreeConsole();
                if (AttachConsole((uint)pi.dwProcessId))
                {
                    // 本进程忽略 Ctrl+C，再把事件广播给伪控制台上所有进程（即子进程）；
                    // 不用组定向——CREATE_NEW_PROCESS_GROUP 已移除，组 id 不可靠
                    SetConsoleCtrlHandler(IntPtr.Zero, true);
                    GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
                    if (WaitForSingleObject(pi.hProcess, 5000) == 0) return;
                }
            }
            catch { }
            try { TerminateProcess(pi.hProcess, 1); } catch { }
        });
        inThread.IsBackground = true;
        inThread.Start();

        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hProcess);
        ClosePseudoConsole(hPC);
        // 给输出线程一个把尾部字节吐完的窗口
        Thread.Sleep(300);
        return (int)code;
    }

    private static void Fail(string where)
    {
        Console.Error.WriteLine("PtyHost fatal: " + where);
        Environment.Exit(3);
    }
}
