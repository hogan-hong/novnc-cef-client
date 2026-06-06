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

    [DllImport("user32.dll", SetLastError = true)]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    const uint GW_CHILD = 5;
    const uint GW_HWNDNEXT = 2;
    const uint WM_NULL = 0x0000;
    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const int WS_CAPTION = 0x00C00000;
    const int WS_BORDER = 0x00800000;
    const int WS_DLGFRAME = 0x00400000;
    const int WS_THICKFRAME = 0x00040000;
    const int WS_SYSMENU = 0x00080000;
    const int WS_EX_DLGMODALFRAME = 0x00000001;
    const int WS_EX_CLIENTEDGE = 0x00000200;
    const int WS_EX_STATICEDGE = 0x00020000;
    const int WS_EX_WINDOWEDGE = 0x00000100;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOREDRAW = 0x0008;

    static void StripWindowFrame(IntPtr hwnd)
    {
        int style = GetWindowLong(hwnd, GWL_STYLE);
        int newStyle = style & ~(WS_CAPTION | WS_BORDER | WS_DLGFRAME | WS_THICKFRAME | WS_SYSMENU);
        if (newStyle != style) SetWindowLong(hwnd, GWL_STYLE, newStyle);

        int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        int newExStyle = exStyle & ~(WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_WINDOWEDGE);
        if (newExStyle != exStyle) SetWindowLong(hwnd, GWL_EXSTYLE, newExStyle);

        // 应用样式变化(SWP_NOREDRAW避免重绘瞬间闪烁)
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOREDRAW);
    }

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
                // 每次事件来都重新去掉边框样式(Chrome可能恢复)
                StripWindowFrame(hwnd);
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
                StripWindowFrame(child);
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
