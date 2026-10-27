// 局域网同步 · 桌面启动器
//
// 目标：双击即用，不依赖机器上装没装 Node。
// 做法：便携目录里自带 node.exe，这个窗口负责在后台把 server.js 拉起来，
//       探测到端口就绪后把地址显示出来（并可直接打开界面）；关窗口就把服务一起收掉。
//
// 注意：用 .NET Framework 自带的 csc 编译（机器上必然有），所以只写 C# 4 能编译的语法。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace CommSync
{
    public class LauncherForm : Form
    {
        private const int FirstPort = 47800;
        private const int LastPort = 47830;

        private readonly string exeDir;
        private readonly string appDir;
        private readonly string dataDir;

        private Process child;
        private string baseUrl = string.Empty;
        private readonly StringBuilder logBuffer = new StringBuilder();
        private readonly object logLock = new object();

        private Label titleLabel;
        private Label statusLabel;
        private Label urlLabel;
        private Button openButton;
        private Button copyButton;
        private Button stopButton;
        private TextBox logBox;

        public LauncherForm()
        {
            exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            appDir = Path.Combine(exeDir, "app");
            dataDir = Path.Combine(exeDir, "data");

            BuildUi();
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }

        private void BuildUi()
        {
            Text = "局域网同步";
            ClientSize = new Size(560, 380);
            MinimumSize = new Size(480, 320);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(11, 16, 32);
            ForeColor = Color.FromArgb(248, 250, 252);
            Font = new Font("Microsoft YaHei UI", 9F);

            titleLabel = new Label();
            titleLabel.Text = "局域网同步";
            titleLabel.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold);
            titleLabel.ForeColor = Color.FromArgb(248, 250, 252);
            titleLabel.SetBounds(20, 18, 300, 34);
            Controls.Add(titleLabel);

            Label sub = new Label();
            sub.Text = "与局域网里的其他机器按文件夹同步";
            sub.ForeColor = Color.FromArgb(154, 168, 189);
            sub.SetBounds(22, 52, 400, 20);
            Controls.Add(sub);

            statusLabel = new Label();
            statusLabel.Text = "正在启动服务…";
            statusLabel.ForeColor = Color.FromArgb(251, 191, 36);
            statusLabel.SetBounds(22, 88, 510, 22);
            Controls.Add(statusLabel);

            urlLabel = new Label();
            urlLabel.Text = "";
            urlLabel.Font = new Font("Consolas", 10F);
            urlLabel.ForeColor = Color.FromArgb(56, 189, 248);
            urlLabel.SetBounds(22, 112, 510, 22);
            Controls.Add(urlLabel);

            openButton = new Button();
            openButton.Text = "打开界面";
            openButton.SetBounds(22, 146, 120, 32);
            openButton.Enabled = false;
            openButton.Click += delegate { OpenUi(); };
            Controls.Add(openButton);

            copyButton = new Button();
            copyButton.Text = "复制地址";
            copyButton.SetBounds(152, 146, 100, 32);
            copyButton.Enabled = false;
            copyButton.Click += delegate { CopyUrl(); };
            Controls.Add(copyButton);

            stopButton = new Button();
            stopButton.Text = "停止并退出";
            stopButton.SetBounds(262, 146, 120, 32);
            stopButton.Click += delegate { Close(); };
            Controls.Add(stopButton);

            Label logTitle = new Label();
            logTitle.Text = "运行日志";
            logTitle.ForeColor = Color.FromArgb(154, 168, 189);
            logTitle.SetBounds(22, 192, 200, 20);
            Controls.Add(logTitle);

            logBox = new TextBox();
            logBox.Multiline = true;
            logBox.ReadOnly = true;
            logBox.ScrollBars = ScrollBars.Vertical;
            logBox.BackColor = Color.FromArgb(15, 23, 42);
            logBox.ForeColor = Color.FromArgb(148, 163, 184);
            logBox.Font = new Font("Consolas", 8.5F);
            logBox.SetBounds(22, 214, 516, 142);
            logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(logBox);

            FormClosing += delegate { StopServer(); };
            Shown += delegate
            {
                Thread worker = new Thread(StartServer);
                worker.IsBackground = true;
                worker.Start();
            };
        }

        /* ------------------------------------------------------------ 启动 */

        private void StartServer()
        {
            if (!Directory.Exists(appDir))
            {
                SetStatus("缺少 app 目录：请把整个解压后的文件夹一起用", Color.FromArgb(248, 113, 113));
                return;
            }
            Directory.CreateDirectory(dataDir);

            string nodeExe = Path.Combine(exeDir, "node.exe");
            if (!File.Exists(nodeExe))
            {
                string onPath = FindOnPath("node.exe");
                if (onPath == null)
                {
                    SetStatus("找不到 node.exe（便携版应自带）", Color.FromArgb(248, 113, 113));
                    return;
                }
                nodeExe = onPath;
                AppendLog("使用系统的 node：" + nodeExe);
            }

            ProcessStartInfo info = new ProcessStartInfo(nodeExe, "server.js");
            info.WorkingDirectory = appDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables["LAN_SYNC_NO_BROWSER"] = "1";
            info.EnvironmentVariables["LAN_SYNC_DATA"] = dataDir;

            try
            {
                child = Process.Start(info);
            }
            catch (Exception ex)
            {
                SetStatus("启动失败：" + ex.Message, Color.FromArgb(248, 113, 113));
                return;
            }

            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data)) AppendLog(e.Data);
            };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data)) AppendLog(e.Data);
            };
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();

            for (int i = 0; i < 120; i++)
            {
                string url = ProbePorts();
                if (url != null)
                {
                    SetReady(url);
                    return;
                }
                if (child != null && child.HasExited)
                {
                    // 多半是"同一个数据目录已经在跑"，那就直接用那个实例
                    break;
                }
                Thread.Sleep(250);
            }

            string existing = ProbePorts();
            if (existing != null)
            {
                SetReady(existing);
                return;
            }
            SetStatus("服务没能启动，看下面的日志", Color.FromArgb(248, 113, 113));
        }

        private static string FindOnPath(string fileName)
        {
            string path = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(path)) return null;
            string[] parts = path.Split(Path.PathSeparator);
            for (int i = 0; i < parts.Length; i++)
            {
                if (string.IsNullOrEmpty(parts[i])) continue;
                string candidate = Path.Combine(parts[i].Trim(), fileName);
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        /** 逐个端口问一句"你是 commsync 吗"，第一个回话的就是我们的服务 */
        private static string ProbePorts()
        {
            for (int port = FirstPort; port <= LastPort; port++)
            {
                string url = "http://127.0.0.1:" + port;
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/api/ping");
                    request.Timeout = 600;
                    request.ReadWriteTimeout = 600;
                    request.Proxy = null;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        if (body.Contains("commsync")) return url + "/";
                    }
                }
                catch (Exception)
                {
                    // 端口没服务，继续
                }
            }
            return null;
        }

        /* ------------------------------------------------------------ 交互 */

        private void SetReady(string url)
        {
            baseUrl = url;
            BeginInvoke((MethodInvoker)delegate
            {
                urlLabel.Text = url;
                statusLabel.Text = "服务运行中";
                statusLabel.ForeColor = Color.FromArgb(34, 197, 94);
                openButton.Enabled = true;
                copyButton.Enabled = true;
                AcceptButton = openButton;
            });
            AppendLog("服务就绪：" + url);
        }

        private void SetStatus(string text, Color color)
        {
            BeginInvoke((MethodInvoker)delegate
            {
                statusLabel.Text = text;
                statusLabel.ForeColor = color;
            });
        }

        private void OpenUi()
        {
            if (baseUrl.Length == 0) return;
            try
            {
                Process.Start(baseUrl);
            }
            catch (Exception ex)
            {
                MessageBox.Show("打不开浏览器：" + ex.Message, "局域网同步");
            }
        }

        private void CopyUrl()
        {
            if (baseUrl.Length == 0) return;
            try
            {
                Clipboard.SetText(baseUrl);
                statusLabel.Text = "地址已复制";
                statusLabel.ForeColor = Color.FromArgb(34, 197, 94);
            }
            catch (Exception)
            {
                // 剪贴板偶尔会被别的程序占用，忽略
            }
        }

        private void AppendLog(string line)
        {
            lock (logLock)
            {
                logBuffer.Append(line).Append(Environment.NewLine);
                if (logBuffer.Length > 20000) logBuffer.Remove(0, logBuffer.Length - 20000);
                string snapshot = logBuffer.ToString();
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        logBox.Text = snapshot;
                        logBox.SelectionStart = logBox.Text.Length;
                        logBox.ScrollToCaret();
                    });
                }
                catch (Exception)
                {
                    // 窗口已经关了
                }
            }
        }

        private void StopServer()
        {
            if (child == null) return;
            try
            {
                if (!child.HasExited) child.Kill();
            }
            catch (Exception)
            {
                // 已经退出了
            }
            child = null;
        }
    }
}
