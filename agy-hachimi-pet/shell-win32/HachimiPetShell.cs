using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HachimiPetShell
{
    static class Program
    {
        [DllImport("user32.dll")]
        private static extern IntPtr SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
            catch
            {
                try { SetProcessDPIAware(); } catch { }
            }

            int port = 17890;
            string envPort = Environment.GetEnvironmentVariable("HACHIMI_PET_PORT");
            if (string.IsNullOrEmpty(envPort)) envPort = Environment.GetEnvironmentVariable("AGY_WHALE_PORT");
            int parsedEnvPort;
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out parsedEnvPort) && parsedEnvPort > 0)
            {
                port = parsedEnvPort;
            }

            string targetUrl = string.Format("http://127.0.0.1:{0}/", port);
            string trayIconPath = null;
            int ownerPid = 0;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i] ?? "";
                if (a.StartsWith("--port="))
                {
                    int p;
                    if (int.TryParse(a.Substring("--port=".Length), out p) && p > 0) port = p;
                }
                else if (a.StartsWith("--url="))
                {
                    targetUrl = a.Substring("--url=".Length);
                }
                else if (a.StartsWith("--icon="))
                {
                    trayIconPath = a.Substring("--icon=".Length);
                }
                else if (a.StartsWith("--owner-pid="))
                {
                    int op;
                    if (int.TryParse(a.Substring("--owner-pid=".Length), out op) && op > 0) ownerPid = op;
                }
            }

            bool createdNew;
            using (Mutex singleInstance = new Mutex(true, string.Format("Global\\HachimiPetWebViewShell_{0}", port), out createdNew))
            {
                if (!createdNew)
                {
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new OverlayForm(port, targetUrl, trayIconPath, ownerPid));
            }
        }
    }

    public class OverlayForm : Form
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct MARGINS
        {
            public int cxLeftWidth;
            public int cxRightWidth;
            public int cyTopHeight;
            public int cyBottomHeight;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmExtendFrameIntoClientArea(IntPtr hWnd, ref MARGINS pMarInset);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        private const int GWL_EXSTYLE = -20;
        private const long WS_EX_LAYERED = 0x00080000L;
        private const long WS_EX_TRANSPARENT = 0x00000020L;
        private const long WS_EX_TOOLWINDOW = 0x00000080L;
        private const long WS_EX_TOPMOST = 0x00000008L;
        private const long WS_EX_NOACTIVATE = 0x08000000L;

        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_FRAMECHANGED = 0x0020;

        private const int WM_HOTKEY = 0x0312;
        private const int WM_DISPLAYCHANGE = 0x007E;
        private const int HOTKEY_ID = 1;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_SHIFT = 0x0004;

        private readonly int _port;
        private readonly string _targetUrl;
        private readonly string _trayIconPath;
        private readonly int _ownerPid;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        private WebView2 _webView;
        private NotifyIcon _tray;
        private ContextMenuStrip _trayMenu;
        private IntPtr _trayIconHandle = IntPtr.Zero;
        private System.Windows.Forms.Timer _cursorTimer;
        private bool _webViewReady = false;

        private bool _clickThroughLocked = false;
        private bool _wantedCapture = false;
        private long _leaseExpiresAtMs = 0;
        private bool? _appliedIgnore = null;

        private int _lastCursorX = -99999;
        private int _lastCursorY = -99999;
        private long _lastSentAtMs = 0;
        private long _lastTopmostAtMs = 0;
        private long _lastOwnerCheckAtMs = 0;

        private string _scheme = "astral";
        private string _roam = "free";
        private double _scale = 0.95;
        private double _opacity = 1.0;
        private bool _soundOn = true;
        private bool _updating = false;

        public OverlayForm(int port, string targetUrl, string trayIconPath, int ownerPid)
        {
            _port = port;
            _targetUrl = targetUrl;
            _trayIconPath = trayIconPath;
            _ownerPid = ownerPid;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.Black;

            ApplyWorkAreaBounds();

            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            _webView.DefaultBackgroundColor = Color.Transparent;
            Controls.Add(_webView);

            InitTray();
            Load += OnFormLoad;
            FormClosing += OnFormClosing;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= (int)(WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT);
                return cp;
            }
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        private void ApplyWorkAreaBounds()
        {
            Screen primary = Screen.PrimaryScreen;
            Rectangle wa = primary.WorkingArea;
            Rectangle full = primary.Bounds;
            int w = wa.Width;
            int h = wa.Height;
            if (wa.X == full.X && wa.Y == full.Y && w == full.Width && h == full.Height)
            {
                h = Math.Max(200, h - 2);
            }
            Bounds = new Rectangle(wa.X, wa.Y, w, h);
        }

        private void ExtendDwmGlass()
        {
            try
            {
                MARGINS m = new MARGINS { cxLeftWidth = -1, cxRightWidth = -1, cyTopHeight = -1, cyBottomHeight = -1 };
                DwmExtendFrameIntoClientArea(Handle, ref m);
            }
            catch { }
        }

        private static long NowMs()
        {
            return DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
        }

        private void ApplyMouseState()
        {
            if (IsDisposed || !IsHandleCreated) return;
            long now = NowMs();
            bool shouldCapture = !_clickThroughLocked && _wantedCapture && now < _leaseExpiresAtMs && Visible;
            bool shouldIgnore = !shouldCapture;
            if (_appliedIgnore.HasValue && _appliedIgnore.Value == shouldIgnore) return;
            _appliedIgnore = shouldIgnore;

            long ex = GetWindowLongPtr(Handle, GWL_EXSTYLE).ToInt64();
            if (shouldIgnore)
            {
                ex |= (WS_EX_LAYERED | WS_EX_TRANSPARENT);
            }
            else
            {
                ex |= WS_EX_LAYERED;
                ex &= ~WS_EX_TRANSPARENT;
            }
            SetWindowLongPtr(Handle, GWL_EXSTYLE, new IntPtr(ex));
            SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);

            ReportHostStateAsync(shouldIgnore);
        }

        private void ReportHostStateAsync(bool ignoringMouseEvents)
        {
            int port = _port;
            bool locked = _clickThroughLocked;
            bool wanted = _wantedCapture;
            long leaseRem = Math.Max(0, _leaseExpiresAtMs - NowMs());
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    string body = _json.Serialize(new Dictionary<string, object>
                    {
                        { "runtime", "webview2" },
                        { "clickThroughLocked", locked },
                        { "wantedCapture", wanted },
                        { "ignoringMouseEvents", ignoringMouseEvents },
                        { "leaseRemainingMs", leaseRem }
                    });
                    HttpPostJson(string.Format("http://127.0.0.1:{0}/api/host-state", port), body);
                }
                catch { }
            });
        }

        private void ReportRendererLogAsync(string level, string source, string message)
        {
            int port = _port;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    string body = _json.Serialize(new Dictionary<string, object>
                    {
                        { "level", level ?? "error" },
                        { "source", source ?? "webview2-shell" },
                        { "message", message ?? "" }
                    });
                    HttpPostJson(string.Format("http://127.0.0.1:{0}/api/renderer-log", port), body);
                }
                catch { }
            });
        }

        private async void OnFormLoad(object sender, EventArgs e)
        {
            ExtendDwmGlass();
            ApplyMouseState();
            RegisterHotKey(Handle, HOTKEY_ID, MOD_ALT | MOD_SHIFT, (uint)Keys.W);

            try
            {
                string userDataDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".hachimi-pet",
                    "webview2-data"
                );
                Directory.CreateDirectory(userDataDir);

                CoreWebView2EnvironmentOptions opts = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userDataDir, opts);
                await _webView.EnsureCoreWebView2Async(env);

                _webView.DefaultBackgroundColor = Color.Transparent;
                _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;

                string preloadScript = BuildPreloadScript(_port);
                await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(preloadScript);

                _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                _webView.CoreWebView2.WindowCloseRequested += delegate(object s, object ev)
                {
                    ReportRendererLogAsync("warn", "webview2-shell", "Blocked WindowCloseRequested from document/accelerator");
                };
                _webView.CoreWebView2.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs ev)
                {
                    string uri = ev.Uri ?? "";
                    string allowedPrefix = string.Format("http://127.0.0.1:{0}/", _port);
                    if (!uri.StartsWith(allowedPrefix, StringComparison.OrdinalIgnoreCase))
                    {
                        ev.Cancel = true;
                        ReportRendererLogAsync("warn", "webview2-shell", "Blocked external navigation: " + uri);
                    }
                };
                _webView.CoreWebView2.ProcessFailed += delegate(object s, CoreWebView2ProcessFailedEventArgs ev)
                {
                    ReportRendererLogAsync("error", "webview2-shell", "CoreWebView2 ProcessFailed: " + ev.ProcessFailedKind.ToString());
                    try
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            if (!IsDisposed && _webView != null && _webView.CoreWebView2 != null)
                            {
                                _webView.CoreWebView2.Navigate(_targetUrl);
                            }
                        });
                    }
                    catch { }
                };
                _webView.CoreWebView2.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs ev)
                {
                    if (!ev.IsSuccess)
                    {
                        ReportRendererLogAsync("error", "webview2-shell", "NavigationCompleted failed: " + ev.WebErrorStatus.ToString());
                    }
                    _webViewReady = true;
                    ExtendDwmGlass();
                    _appliedIgnore = null;
                    ApplyMouseState();
                };

                _webView.CoreWebView2.Navigate(_targetUrl);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Hachimi Pet WebView2 init failed:\n" + ex.Message, "Hachimi Pet", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            FetchSettingsFromBridge();

            _cursorTimer = new System.Windows.Forms.Timer();
            _cursorTimer.Interval = 33;
            _cursorTimer.Tick += OnCursorTick;
            _cursorTimer.Start();
        }

        private static string BuildPreloadScript(int port)
        {
            return @"(function() {
  if (window.petHost) return;
  var cursorListeners = [];
  var commandListeners = [];
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', function(ev) {
      var msg = ev && ev.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'cursor') {
        for (var i = 0; i < cursorListeners.length; i++) {
          try { cursorListeners[i](msg.payload); } catch (e) {}
        }
      } else if (msg.kind === 'command') {
        for (var j = 0; j < commandListeners.length; j++) {
          try { commandListeners[j](msg.payload); } catch (e) {}
        }
      }
    });
  }
  function postToHost(type, data) {
    try {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: type, data: data });
      }
    } catch (e) {}
  }
  window.petHost = {
    bridgePort: " + port.ToString() + @",
    setMouseCapture: function(capture) { postToHost('mouseCapture', { capture: !!capture }); },
    focusWindow: function() { postToHost('focusWindow', {}); },
    blurWindow: function() { postToHost('blurWindow', {}); },
    openExternal: function(url) { postToHost('openExternal', { url: url }); },
    quitApp: function() { postToHost('quit', {}); },
    pickDirectory: function() { return Promise.resolve(null); },
    onCursor: function(cb) {
      if (typeof cb !== 'function') return function() {};
      cursorListeners.push(cb);
      return function() {
        var idx = cursorListeners.indexOf(cb);
        if (idx >= 0) cursorListeners.splice(idx, 1);
      };
    },
    onCommand: function(cb) {
      if (typeof cb !== 'function') return function() {};
      commandListeners.push(cb);
      return function() {
        var idx = commandListeners.indexOf(cb);
        if (idx >= 0) commandListeners.splice(idx, 1);
      };
    }
  };
})();";
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                Dictionary<string, object> msg = _json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                if (msg == null || !msg.ContainsKey("type")) return;
                string type = Convert.ToString(msg["type"]);
                Dictionary<string, object> data = msg.ContainsKey("data") ? msg["data"] as Dictionary<string, object> : null;

                if (type == "mouseCapture")
                {
                    bool capture = data != null && data.ContainsKey("capture") && Convert.ToBoolean(data["capture"]);
                    _wantedCapture = capture;
                    _leaseExpiresAtMs = capture ? (NowMs() + 1600) : 0;
                    ApplyMouseState();
                }
                else if (type == "focusWindow")
                {
                    _wantedCapture = true;
                    _leaseExpiresAtMs = NowMs() + 5000;
                    _appliedIgnore = null;
                    ApplyMouseState();
                }
                else if (type == "blurWindow")
                {
                    _wantedCapture = false;
                    _leaseExpiresAtMs = 0;
                    _appliedIgnore = null;
                    ApplyMouseState();
                }
                else if (type == "openExternal" && data != null && data.ContainsKey("url"))
                {
                    string u = Convert.ToString(data["url"]);
                    if (!string.IsNullOrEmpty(u) && (u.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || u.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
                    {
                        Process.Start(new ProcessStartInfo(u) { UseShellExecute = true });
                    }
                }
                else if (type == "quit")
                {
                    ExitEverything();
                }
            }
            catch { }
        }

        private void OnCursorTick(object sender, EventArgs e)
        {
            if (IsDisposed || !IsHandleCreated) return;
            long now = NowMs();

            ApplyMouseState();

            if (now - _lastTopmostAtMs > 6000)
            {
                _lastTopmostAtMs = now;
                SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }

            if (_ownerPid > 0 && now - _lastOwnerCheckAtMs > 2000)
            {
                _lastOwnerCheckAtMs = now;
                try
                {
                    Process p = Process.GetProcessById(_ownerPid);
                    if (p == null || p.HasExited)
                    {
                        Close();
                        return;
                    }
                }
                catch
                {
                    Close();
                    return;
                }
            }

            if (!_webViewReady || _webView.CoreWebView2 == null) return;

            POINT pt;
            if (!GetCursorPos(out pt)) return;

            double scale = 1.0;
            try
            {
                uint dpi = GetDpiForWindow(Handle);
                if (dpi >= 96) scale = dpi / 96.0;
            }
            catch { }

            int rx = (int)Math.Round((pt.X - Left) / scale);
            int ry = (int)Math.Round((pt.Y - Top) / scale);
            int lw = (int)Math.Round(Width / scale);
            int lh = (int)Math.Round(Height / scale);

            if (rx != _lastCursorX || ry != _lastCursorY || now - _lastSentAtMs > 400)
            {
                _lastCursorX = rx;
                _lastCursorY = ry;
                _lastSentAtMs = now;

                string payload = _json.Serialize(new Dictionary<string, object>
                {
                    { "kind", "cursor" },
                    { "payload", new Dictionary<string, object>
                        {
                            { "x", rx },
                            { "y", ry },
                            { "insideWindow", rx >= 0 && ry >= 0 && rx <= lw && ry <= lh },
                            { "locked", _clickThroughLocked }
                        }
                    }
                });
                try { _webView.CoreWebView2.PostWebMessageAsJson(payload); }
                catch { }
            }
        }

        private void SendCommandToWeb(string cmdType)
        {
            if (!_webViewReady || _webView.CoreWebView2 == null) return;
            string payload = _json.Serialize(new Dictionary<string, object>
            {
                { "kind", "command" },
                { "payload", new Dictionary<string, object> { { "type", cmdType } } }
            });
            try { _webView.CoreWebView2.PostWebMessageAsJson(payload); }
            catch { }
        }

        private void InitTray()
        {
            _trayMenu = new ContextMenuStrip();
            _tray = new NotifyIcon();
            _tray.Text = "Hachimi Pet · Antigravity 哈基米伴侣 (右键托盘换色/设置)";
            _tray.ContextMenuStrip = _trayMenu;

            try
            {
                if (!string.IsNullOrEmpty(_trayIconPath) && File.Exists(_trayIconPath))
                {
                    using (Bitmap raw = new Bitmap(_trayIconPath))
                    using (Bitmap scaled = new Bitmap(raw, new Size(32, 32)))
                    {
                        _trayIconHandle = scaled.GetHicon();
                        _tray.Icon = Icon.FromHandle(_trayIconHandle);
                    }
                }
                else
                {
                    _tray.Icon = SystemIcons.Application;
                }
            }
            catch
            {
                _tray.Icon = SystemIcons.Application;
            }

            _tray.MouseClick += delegate(object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left)
                {
                    SendCommandToWeb("resetPosition");
                }
            };

            RebuildTrayMenu();
            _tray.Visible = true;
        }

        private void FetchSettingsFromBridge()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    string txt = HttpGet(string.Format("http://127.0.0.1:{0}/api/state", _port));
                    Dictionary<string, object> root = _json.Deserialize<Dictionary<string, object>>(txt);
                    Dictionary<string, object> st = root != null && root.ContainsKey("settings") ? root["settings"] as Dictionary<string, object> : null;
                    if (st != null && !IsDisposed)
                    {
                        if (st.ContainsKey("scheme")) _scheme = Convert.ToString(st["scheme"]) ?? "astral";
                        if (st.ContainsKey("roam")) _roam = Convert.ToString(st["roam"]) ?? "free";
                        if (st.ContainsKey("scale")) _scale = Convert.ToDouble(st["scale"]);
                        if (st.ContainsKey("opacity")) _opacity = Convert.ToDouble(st["opacity"]);
                        if (st.ContainsKey("soundOn")) _soundOn = Convert.ToBoolean(st["soundOn"]);
                        BeginInvoke((MethodInvoker)delegate { RebuildTrayMenu(); });
                    }
                }
                catch { }
            });
        }

        private void PostSettingsPatch(Dictionary<string, object> patch)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    HttpPostJson(string.Format("http://127.0.0.1:{0}/api/settings", _port), _json.Serialize(patch));
                }
                catch { }
            });
        }

        private void RebuildTrayMenu()
        {
            if (_trayMenu == null) return;
            _trayMenu.Items.Clear();

            var resetItem = new ToolStripMenuItem("📍 召唤回右下角");
            resetItem.Click += delegate { SendCommandToWeb("resetPosition"); };
            _trayMenu.Items.Add(resetItem);

            var statsItem = new ToolStripMenuItem("📊 模型消耗与缓存统计");
            statsItem.Click += delegate { SendCommandToWeb("openStats"); };
            _trayMenu.Items.Add(statsItem);

            var schemeMenu = new ToolStripMenuItem("🎨 切换哈基米配色");
            string[][] schemes = new string[][]
            {
                new string[] { "astral", "星瞳紫 (Astral · 原设)" },
                new string[] { "sakura", "樱桃粉 (Sakura)" },
                new string[] { "azure", "苍穹蓝 (Azure)" },
                new string[] { "emerald", "森灵翠 (Emerald)" },
                new string[] { "amber", "流光金 (Amber)" },
                new string[] { "crimson", "绯夜红 (Crimson)" },
                new string[] { "arctic", "霜月银 (Arctic)" },
                new string[] { "obsidian", "暗夜黑 (Obsidian)" }
            };
            foreach (string[] sc in schemes)
            {
                string id = sc[0];
                string label = sc[1];
                var item = new ToolStripMenuItem(label);
                item.Checked = (_scheme == id) || (id == "astral" && _scheme == "gemini");
                item.Click += delegate
                {
                    _scheme = id;
                    PostSettingsPatch(new Dictionary<string, object> { { "scheme", id }, { "outfit", "maid" } });
                    RebuildTrayMenu();
                };
                schemeMenu.DropDownItems.Add(item);
            }
            _trayMenu.Items.Add(schemeMenu);

            var sizeMenu = new ToolStripMenuItem("📏 桌宠大小");
            double[] sizeValues = new double[] { 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0, 1.1 };
            foreach (double sizeValue in sizeValues)
            {
                double value = sizeValue;
                var item = new ToolStripMenuItem(string.Format("{0}%", (int)Math.Round(value * 100)));
                item.Checked = Math.Abs(_scale - value) < 0.001;
                item.Click += delegate
                {
                    _scale = value;
                    PostSettingsPatch(new Dictionary<string, object> { { "scale", value } });
                    RebuildTrayMenu();
                };
                sizeMenu.DropDownItems.Add(item);
            }
            _trayMenu.Items.Add(sizeMenu);

            var hudSettingsItem = new ToolStripMenuItem("头顶文字设置…");
            hudSettingsItem.Click += delegate { SendCommandToWeb("openHudSettings"); };
            _trayMenu.Items.Add(hudSettingsItem);

            var opacityMenu = new ToolStripMenuItem("👻 桌宠透明度");
            double[] opacityValues = new double[] { 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4 };
            foreach (double opacityValue in opacityValues)
            {
                double value = opacityValue;
                string label = value >= 0.999 ? "100% (不透明)" : string.Format("{0}%", (int)Math.Round(value * 100));
                var item = new ToolStripMenuItem(label);
                item.Checked = Math.Abs(_opacity - value) < 0.001;
                item.Click += delegate
                {
                    _opacity = value;
                    PostSettingsPatch(new Dictionary<string, object> { { "opacity", value } });
                    RebuildTrayMenu();
                };
                opacityMenu.DropDownItems.Add(item);
            }
            _trayMenu.Items.Add(opacityMenu);

            var subMenu = new ToolStripMenuItem("🐱 子代理预览");
            var spawnItem = new ToolStripMenuItem("✨ 召唤测试子代理 (天降与淡出)");
            spawnItem.Click += delegate
            {
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try { HttpPostJson(string.Format("http://127.0.0.1:{0}/api/subagents", _port), "{}"); }
                    catch { }
                });
            };
            var clearItem = new ToolStripMenuItem("🧹 清空当前子代理");
            clearItem.Click += delegate
            {
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try { HttpPostJson(string.Format("http://127.0.0.1:{0}/api/subagents", _port), "{\"action\":\"clear\"}"); }
                    catch { }
                });
            };
            subMenu.DropDownItems.Add(spawnItem);
            subMenu.DropDownItems.Add(clearItem);
            _trayMenu.Items.Add(subMenu);

            _trayMenu.Items.Add(new ToolStripSeparator());

            var roamItem = new ToolStripMenuItem("🚶 允许自由散步");
            roamItem.Checked = (_roam == "free");
            roamItem.Click += delegate
            {
                _roam = (_roam == "free") ? "off" : "free";
                PostSettingsPatch(new Dictionary<string, object> { { "roam", _roam } });
                RebuildTrayMenu();
            };
            _trayMenu.Items.Add(roamItem);

            var soundItem = new ToolStripMenuItem("🔊 开启音效");
            soundItem.Checked = _soundOn;
            soundItem.Click += delegate
            {
                _soundOn = !_soundOn;
                PostSettingsPatch(new Dictionary<string, object> { { "soundOn", _soundOn } });
                RebuildTrayMenu();
            };
            _trayMenu.Items.Add(soundItem);

            var lockItem = new ToolStripMenuItem("🔒 鼠标完全穿透 (免打扰 · Alt+Shift+W)");
            lockItem.Checked = _clickThroughLocked;
            lockItem.Click += delegate
            {
                ToggleClickThroughLock();
            };
            _trayMenu.Items.Add(lockItem);

            _trayMenu.Items.Add(new ToolStripSeparator());

            var updateItem = new ToolStripMenuItem(_updating ? "⏳ 正在检测/更新..." : "⬆️ 检测并更新");
            updateItem.Enabled = !_updating;
            updateItem.Click += delegate { CheckAndApplyUpdate(); };
            _trayMenu.Items.Add(updateItem);

            var reloadItem = new ToolStripMenuItem("🔄 刷新桌宠界面");
            reloadItem.Click += delegate
            {
                try
                {
                    if (_webView != null && _webView.CoreWebView2 != null)
                    {
                        _webView.CoreWebView2.Navigate(_targetUrl);
                    }
                }
                catch { }
            };
            _trayMenu.Items.Add(reloadItem);

            var exitItem = new ToolStripMenuItem("🚪 退出哈基米桌宠");
            exitItem.Click += delegate { ExitEverything(); };
            _trayMenu.Items.Add(exitItem);
        }

        private void ToggleClickThroughLock()
        {
            _clickThroughLocked = !_clickThroughLocked;
            _wantedCapture = false;
            _leaseExpiresAtMs = 0;
            _appliedIgnore = null;
            ApplyMouseState();
            RebuildTrayMenu();
        }

        private void CheckAndApplyUpdate()
        {
            if (_updating) return;
            _updating = true;
            RebuildTrayMenu();
            int port = _port;

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    string checkJson = HttpGet(string.Format("http://127.0.0.1:{0}/api/update/check", port), 25000);
                    Dictionary<string, object> info = _json.Deserialize<Dictionary<string, object>>(checkJson);
                    bool ok = info != null && info.ContainsKey("ok") && Convert.ToBoolean(info["ok"]);
                    if (!ok)
                    {
                        string errMsg = info != null && info.ContainsKey("error") ? Convert.ToString(info["error"]) : "检查更新失败";
                        throw new Exception(errMsg);
                    }

                    bool hasUpdate = info.ContainsKey("hasUpdate") && Convert.ToBoolean(info["hasUpdate"]);
                    string curVer = info.ContainsKey("currentVersion") ? Convert.ToString(info["currentVersion"]) : "?";
                    string latVer = info.ContainsKey("latestVersion") ? Convert.ToString(info["latestVersion"]) : "?";
                    string notes = info.ContainsKey("notes") ? Convert.ToString(info["notes"]) : "";

                    if (!hasUpdate)
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            _updating = false;
                            RebuildTrayMenu();
                            MessageBox.Show(
                                string.Format("当前已是最新版本 (v{0})。", curVer),
                                "Hachimi Pet 检测更新",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Information
                            );
                        });
                        return;
                    }

                    string summary = string.IsNullOrEmpty(notes) ? "是否立即下载更新包并自动重启桌宠？" : (notes.Length > 360 ? notes.Substring(0, 360) + "..." : notes);
                    DialogResult ans = DialogResult.No;
                    Invoke((MethodInvoker)delegate
                    {
                        ans = MessageBox.Show(
                            string.Format("发现新版本 v{0}（当前 v{1}）\n\n{2}\n\n是否立即下载并更新？（完成后将自动重启桌宠）", latVer, curVer, summary),
                            "Hachimi Pet 发现新版本",
                            MessageBoxButtons.YesNo,
                            MessageBoxIcon.Question
                        );
                    });

                    if (ans != DialogResult.Yes)
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            _updating = false;
                            RebuildTrayMenu();
                        });
                        return;
                    }

                    string applyJson = HttpPostJsonWithResponse(string.Format("http://127.0.0.1:{0}/api/update/apply", port), "{}", 120000);
                    Dictionary<string, object> applyInfo = _json.Deserialize<Dictionary<string, object>>(applyJson);
                    bool applyOk = applyInfo != null && applyInfo.ContainsKey("ok") && Convert.ToBoolean(applyInfo["ok"]);
                    if (!applyOk)
                    {
                        string errMsg = applyInfo != null && applyInfo.ContainsKey("error") ? Convert.ToString(applyInfo["error"]) : "应用更新失败";
                        throw new Exception(errMsg);
                    }

                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (_tray != null)
                        {
                            _tray.ShowBalloonTip(2000, "Hachimi Pet", string.Format("正在更新至 v{0}，即将自动重启...", latVer), ToolTipIcon.Info);
                        }
                    });
                }
                catch (Exception ex)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        _updating = false;
                        RebuildTrayMenu();
                        MessageBox.Show(
                            "检查或下载更新失败：\n" + ex.Message,
                            "Hachimi Pet 更新提示",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning
                        );
                    });
                }
            });
        }

        private void ExitEverything()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { HttpPostJson(string.Format("http://127.0.0.1:{0}/api/quit", _port), "{}"); }
                catch { }
            });
            BeginInvoke((MethodInvoker)delegate { Close(); });
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID)
            {
                ToggleClickThroughLock();
            }
            else if (m.Msg == WM_DISPLAYCHANGE)
            {
                ApplyWorkAreaBounds();
                ExtendDwmGlass();
            }
            base.WndProc(ref m);
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            try { UnregisterHotKey(Handle, HOTKEY_ID); } catch { }
            if (_cursorTimer != null)
            {
                _cursorTimer.Stop();
                _cursorTimer.Dispose();
            }
            if (_tray != null)
            {
                _tray.Visible = false;
                _tray.Dispose();
            }
            if (_trayIconHandle != IntPtr.Zero)
            {
                try { DestroyIcon(_trayIconHandle); } catch { }
                _trayIconHandle = IntPtr.Zero;
            }
        }

        private static string HttpGet(string url, int timeoutMs = 2000)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }

        private static void HttpPostJson(string url, string jsonBody, int timeoutMs = 2000)
        {
            HttpPostJsonWithResponse(url, jsonBody, timeoutMs);
        }

        private static string HttpPostJsonWithResponse(string url, string jsonBody, int timeoutMs = 2000)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(jsonBody ?? "{}");
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json; charset=utf-8";
            req.ContentLength = bytes.Length;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            using (Stream s = req.GetRequestStream())
            {
                s.Write(bytes, 0, bytes.Length);
            }
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }
    }
}
