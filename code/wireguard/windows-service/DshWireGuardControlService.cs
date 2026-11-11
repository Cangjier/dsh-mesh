using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

namespace DshWireGuard
{
    /// <summary>
    /// Windows service wrapper for the standalone WireGuard control panel.
    /// It owns control-service.js and restarts it if it exits; DSH is a separate
    /// process and stopping DSH never stops this service.
    /// </summary>
    public sealed class ControlService : ServiceBase
    {
        private readonly string root;
        private readonly string logPath;
        private readonly object logLock = new object();
        private readonly object childLock = new object();
        private Process child;
        private Timer restartTimer;
        private bool stopping;

        public ControlService()
        {
            ServiceName = "DSH-WireGuard-Control";
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
            root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            logPath = Path.Combine(root, "control-service.log");
        }

        protected override void OnStart(string[] args)
        {
            stopping = false;
            Log("service starting");
            StartChild();
        }

        protected override void OnStop()
        {
            stopping = true;
            Log("service stopping");
            lock (childLock)
            {
                if (restartTimer != null) { restartTimer.Dispose(); restartTimer = null; }
            }
            StopChild();
            base.OnStop();
        }

        protected override void OnShutdown()
        {
            OnStop();
            base.OnShutdown();
        }

        private void StartChild()
        {
            lock (childLock)
            {
                if (stopping) return;
                if (child != null && !child.HasExited) return;
                string envFile = Path.Combine(root, "control-service.env");
                string node = "node.exe";
                if (File.Exists(envFile))
                {
                    foreach (string raw in File.ReadAllLines(envFile))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#") || !line.Contains("=")) continue;
                        int split = line.IndexOf('=');
                        string key = line.Substring(0, split).Trim();
                        string value = line.Substring(split + 1).Trim();
                        if (key.Length == 0) continue;
                        Environment.SetEnvironmentVariable(key, value);
                        if (key == "DSH_WIREGUARD_NODE" && value.Length > 0) node = value;
                    }
                }
                string script = Path.Combine(root, "control-service.js");
                if (!File.Exists(script))
                {
                    Log("missing " + script);
                    ScheduleRestart();
                    return;
                }
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = node;
                info.Arguments = "\"" + script + "\"";
                info.WorkingDirectory = root;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                Process process = new Process();
                process.StartInfo = info;
                process.EnableRaisingEvents = true;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("[out] " + e.Data); };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("[err] " + e.Data); };
                process.Exited += delegate(object sender, EventArgs e)
                {
                    int code = -1;
                    try { code = process.ExitCode; } catch { }
                    Log("child exited with code " + code);
                    ScheduleRestart();
                };
                try
                {
                    process.Start();
                    child = process;
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    Log("child started, pid " + process.Id);
                }
                catch (Exception error)
                {
                    Log("cannot start child: " + error.Message);
                    ScheduleRestart();
                }
            }
        }

        private void ScheduleRestart()
        {
            lock (childLock)
            {
                if (stopping || restartTimer != null) return;
                restartTimer = new Timer(delegate(object state)
                {
                    lock (childLock) { restartTimer.Dispose(); restartTimer = null; }
                    StartChild();
                }, null, 5000, Timeout.Infinite);
            }
        }

        private void StopChild()
        {
            Process process;
            lock (childLock) { process = child; child = null; }
            if (process == null) return;
            try
            {
                if (!process.HasExited)
                {
                    ProcessStartInfo kill = new ProcessStartInfo();
                    kill.FileName = Path.Combine(Environment.SystemDirectory, "taskkill.exe");
                    kill.Arguments = "/PID " + process.Id + " /T /F";
                    kill.UseShellExecute = false;
                    kill.CreateNoWindow = true;
                    Process killer = Process.Start(kill);
                    if (killer != null) killer.WaitForExit(10000);
                }
            }
            catch (Exception error)
            {
                Log("taskkill failed: " + error.Message);
                try { process.Kill(); } catch { }
            }
            try { if (!process.HasExited) process.WaitForExit(5000); } catch { }
            Log("child stopped");
        }

        private void Log(string line)
        {
            try
            {
                lock (logLock) { File.AppendAllText(logPath, DateTime.Now.ToString("o") + " " + line + Environment.NewLine); }
            }
            catch { }
        }

        public static void Main()
        {
            ServiceBase.Run(new ControlService());
        }
    }
}
