using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class TitleLocker
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool SetWindowText(IntPtr hWnd, string lpString);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    [DllImport("user32.dll")]
    static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
        WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

    [DllImport("user32.dll")]
    static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    const uint GW_CHILD = 5;
    const uint GW_HWNDNEXT = 2;
    const uint WM_NULL = 0x0000;

    class Target
    {
        public IntPtr ParentHwnd;
        public string Title;
        public IntPtr ChildHwnd;
    }

    static List<Target> targets = new List<Target>();
    static WinEventDelegate eventDelegate;
    static IntPtr hook;
    static volatile bool running = true;

    static void WinEventCallback(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
    {
        if (idObject != 0 || idChild != 0) return;
        if (hwnd == IntPtr.Zero) return;

        foreach (var t in targets)
        {
            if (hwnd == t.ChildHwnd || IsChildOf(hwnd, t.ParentHwnd))
            {
                var sb = new StringBuilder(256);
                GetWindowText(hwnd, sb, 256);
                if (sb.ToString() != t.Title)
                {
                    SetWindowText(hwnd, t.Title);
                }
                if (t.ChildHwnd == IntPtr.Zero) t.ChildHwnd = hwnd;
                break;
            }
        }
    }

    static bool IsChildOf(IntPtr hwnd, IntPtr parent)
    {
        if (!IsWindow(parent)) return false;
        var child = GetWindow(parent, GW_CHILD);
        while (child != IntPtr.Zero)
        {
            if (child == hwnd) return true;
            child = GetWindow(child, GW_HWNDNEXT);
        }
        return false;
    }

    static IntPtr FindChildWindow(IntPtr parent)
    {
        var child = FindWindowEx(parent, IntPtr.Zero, "Chrome_RenderWidgetHostHWND", null);
        if (child == IntPtr.Zero)
            child = FindWindowEx(parent, IntPtr.Zero, "Chrome Legacy Window", null);
        return child;
    }

    static void InitTargets()
    {
        foreach (var t in targets)
        {
            if (!IsWindow(t.ParentHwnd)) continue;
            if (t.ChildHwnd != IntPtr.Zero && IsWindow(t.ChildHwnd)) continue;
            var child = FindChildWindow(t.ParentHwnd);
            if (child != IntPtr.Zero)
            {
                t.ChildHwnd = child;
                SetWindowText(child, t.Title);
            }
        }
    }

    static void Main(string[] args)
    {
        // args: "parentHwnd1,title1" "parentHwnd2,title2" ...
        foreach (var arg in args)
        {
            var idx = arg.IndexOf(',');
            if (idx < 0) continue;
            var parentHwnd = (IntPtr)long.Parse(arg.Substring(0, idx));
            var title = arg.Substring(idx + 1);
            targets.Add(new Target { ParentHwnd = parentHwnd, Title = title });
        }

        if (targets.Count == 0) return;

        // Initial setup: try to find child windows (may not exist yet)
        InitTargets();

        // Retry after delay for windows still loading
        var initTimer = new Timer(_ => InitTargets(), null, 3000, 3000);

        // Set up event hook for real-time title change detection
        eventDelegate = new WinEventDelegate(WinEventCallback);
        hook = SetWinEventHook(EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE,
            IntPtr.Zero, eventDelegate, 0, 0, WINEVENT_OUTOFCONTEXT);

        // Message loop (required for SetWinEventHook callback)
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        if (hook != IntPtr.Zero) UnhookWinEvent(hook);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessage(ref MSG lpMsg);
}
