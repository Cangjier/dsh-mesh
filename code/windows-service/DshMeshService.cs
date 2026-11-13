using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

namespace DshMesh
{
    /// <summary>
    /// Windows service wrapper for the dsh-mesh stack.
    ///
    /// The service runs as LocalSystem. In session 0 the DSH sandbox cannot
    /// start (no logon SID), screenshots are black and GUI browsers never open,
    /// so the stack is normally handed to the logged-on administrator through a
    /// scheduled task with an interactive token. When no interactive
    /// administrator is available the service falls back to running the stack
    /// itself in session 0, which keeps the gateway and the conversation
    /// delegation alive at the cost of the desktop-only features.
    ///
    /// The service owns both children in session 0 (gate + interop) and owns
    /// nothing in interactive mode: the task owns the same two processes, so
    /// stopping the service stops the task as well.
    /// </summary>
    public sealed class GatewayService : ServiceBase
    {
        private const string StackTask = "DSH-Mesh-Stack";

        private readonly string root;
        private readonly string logPath;
        private readonly string statusPath;
        private readonly object logLock = new object();
        private readonly object childLock = new object();
        private Process gate;
        private Process interop;
        private Process sshAgent;
        private Timer restartTimer;
        private Timer watchTimer;
        private bool stopping;
        private string mode = "session0";
        private string modeDetail = "starting";
        // A failed promotion must not be retried on every watch tick: doing so
        // tears the session-0 stack down over and over while the task can never
        // start. While this is in the future the service stays in session 0.
        private DateTime interactiveBlockedUntil = DateTime.MinValue;

        public GatewayService()
        {
            ServiceName = "DSH-Mesh";
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
            root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            logPath = Path.Combine(root, "data", "service.log");
            statusPath = Path.Combine(root, "data", "session-status.json");
            Directory.CreateDirectory(Path.Combine(root, "data"));
        }

        protected override void OnStart(string[] args)
        {
            stopping = false;
            Log("service starting");
            string decision = QueryMode();
            ApplyMode(decision);
            watchTimer = new Timer(delegate(object state) { Watch(); }, null, 20000, 20000);
        }

        protected override void OnStop()
        {
            stopping = true;
            Log("service stopping");
            DisposeTimer(ref watchTimer);
            DisposeTimer(ref restartTimer);
            StopStack();
            base.OnStop();
        }

        protected override void OnShutdown()
        {
            OnStop();
            base.OnShutdown();
        }

        private void DisposeTimer(ref Timer timer)
        {
            Timer current;
            lock (childLock)
            {
                current = timer;
                timer = null;
            }
            if (current != null) current.Dispose();
        }

        /// <summary>
        /// Re-read the session decision and switch mode when it changed.
        /// </summary>
        private void Watch()
        {
            if (stopping) return;
            try
            {
                // A promote request from the panel asks for one explicit
                // re-evaluation instead of waiting for the next tick.
                bool promoted = false;
                string command = Path.Combine(root, "data", "session-command.json");
                if (File.Exists(command))
                {
                    string body = "";
                    try { body = File.ReadAllText(command); } catch { }
                    try { File.Delete(command); } catch { }
                    Log("session command: " + body.Trim());
                    // An explicit request clears a previous failure so the
                    // operator can retry immediately.
                    promoted = true;
                    interactiveBlockedUntil = DateTime.MinValue;
                }
                string decision = QueryMode();
                string nextMode = decision.StartsWith("interactive", StringComparison.Ordinal) ? "interactive" : "session0";
                if (nextMode != mode)
                {
                    if (nextMode == "interactive" && !promoted && DateTime.UtcNow < interactiveBlockedUntil)
                    {
                        // Promotion already failed recently; keep the session-0
                        // stack alive instead of restarting the same failure.
                        EnsureSession0Children();
                        return;
                    }
                    Log("session decision changed to " + decision);
                    ApplyMode(decision);
                    return;
                }
                // Same mode, but a crashed child must come back.
                if (mode == "session0") EnsureSession0Children();
                else EnsureTaskRunning();
                // The SSH agent always runs in the service (LocalSystem), even
                // when the gate/interop stack was handed to an interactive task.
                EnsureSshAgent();
            }
            catch (Exception error)
            {
                Log("watch failed: " + error.Message);
            }
        }

        /// <summary>
        /// Ask select-session.ps1 where the stack should run.
        /// </summary>
        private string QueryMode()
        {
            string script = Path.Combine(root, "code", "windows-service", "select-session.ps1");
            if (!File.Exists(script)) return "session0 missing select-session.ps1";
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
                info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"";
                info.WorkingDirectory = root;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                using (Process process = Process.Start(info))
                {
                    string output = process.StandardOutput.ReadToEnd().Trim();
                    process.WaitForExit(20000);
                    if (output == "") return "session0 select-session.ps1 returned nothing";
                    return output.Split('\n')[0].Trim();
                }
            }
            catch (Exception error)
            {
                return "session0 " + error.Message;
            }
        }

        private void ApplyMode(string decision)
        {
            bool interactive = decision.StartsWith("interactive", StringComparison.Ordinal);
            string detail = decision.Length > "interactive".Length ? decision.Substring("interactive".Length).Trim() : "";
            if (interactive)
            {
                // Create the task first: if the release is incomplete there is
                // nothing to hand over, and killing a healthy session-0 stack
                // for a promotion that cannot happen only causes an outage.
                if (!CreateTask(detail))
                {
                    BlockInteractive("interactive task unavailable");
                    WriteStatus();
                    return;
                }
                // Release port 80 (and the interop port) before the task takes them.
                StopSession0Children();
                if (!RunTask())
                {
                    BlockInteractive("could not start the interactive task");
                    WriteStatus();
                    return;
                }
                mode = "interactive";
                modeDetail = detail;
                Log("stack handed to the interactive task for " + detail);
            }
            else
            {
                mode = "session0";
                modeDetail = decision.Length > "session0".Length ? decision.Substring("session0".Length).Trim() : "";
                EndTask();
                EnsureSession0Children();
                Log("stack runs in session 0: " + modeDetail);
            }
            WriteStatus();
        }

        private void WriteStatus()
        {
            try
            {
                string body = "{\"mode\":\"" + Escape(mode) + "\",\"detail\":\"" + Escape(modeDetail) + "\",\"updatedAt\":\"" + DateTime.UtcNow.ToString("o") + "\"}";
                File.WriteAllText(statusPath, body);
            }
            catch { }
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        /// <summary>
        /// Fall back to session 0 and stop retrying the promotion for a while.
        /// The session-0 children are restarted so the member stays online.
        /// </summary>
        private void BlockInteractive(string reason)
        {
            interactiveBlockedUntil = DateTime.UtcNow.AddMinutes(5);
            mode = "session0";
            modeDetail = reason;
            Log("staying in session 0 for 5 minutes: " + reason);
            EnsureSession0Children();
        }

        /// <summary>
        /// Create the interactive task that runs start-stack.ps1. The task is
        /// recreated on every promotion so it always points at the current
        /// release. It is created but not started, so a caller can decide to
        /// stop the session-0 stack only once the task is known to be valid.
        /// </summary>
        private bool CreateTask(string user)
        {
            if (string.IsNullOrWhiteSpace(user)) { Log("no interactive user for the stack task"); return false; }
            string script = Path.Combine(root, "start-stack.ps1");
            if (!File.Exists(script)) { Log("missing " + script); return false; }
            EndTask();
            string taskCommand = "powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"";
            int created = Run(Path.Combine(Environment.SystemDirectory, "schtasks.exe"),
                "/Create /F /TN \"" + StackTask + "\" /TR \"" + taskCommand + "\" /SC ONCE /ST 00:00 /RU \"" + user + "\" /IT /RL HIGHEST");
            if (created != 0) { Log("schtasks create failed with " + created); return false; }
            return true;
        }

        private bool RunTask()
        {
            int started = Run(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/Run /TN \"" + StackTask + "\"");
            if (started != 0) { Log("schtasks run failed with " + started); return false; }
            return true;
        }

        private bool StartTask(string user)
        {
            return CreateTask(user) && RunTask();
        }

        private void EnsureTaskRunning()
        {
            // A finished task is restarted; schtasks /query returns 0 while it
            // is running, 1 once it is done.
            if (TaskRunning()) return;
            string user = modeDetail;
            if (!StartTask(user)) BlockInteractive("interactive task did not come back");
        }

        private bool TaskRunning()
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = Path.Combine(Environment.SystemDirectory, "schtasks.exe");
                info.Arguments = "/Query /TN \"" + StackTask + "\" /FO LIST";
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                using (Process process = Process.Start(info))
                {
                    string text = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(15000);
                    // "Status: Running" (en) / "状态: 正在运行" (zh)
                    return text.Contains("Running") || text.Contains("正在运行");
                }
            }
            catch
            {
                return false;
            }
        }

        private void EndTask()
        {
            Run(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/End /TN \"" + StackTask + "\"");
            Run(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/Delete /F /TN \"" + StackTask + "\"");
        }

        private int Run(string file, string arguments)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = file;
                info.Arguments = arguments;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                using (Process process = Process.Start(info))
                {
                    process.StandardOutput.ReadToEnd();
                    process.StandardError.ReadToEnd();
                    process.WaitForExit(30000);
                    return process.ExitCode;
                }
            }
            catch (Exception error)
            {
                Log(file + " failed: " + error.Message);
                return -1;
            }
        }

        private void EnsureSession0Children()
        {
            EnsureChild(ref gate, () => StartGate());
            EnsureChild(ref interop, () => StartInterop());
            EnsureSshAgent();
        }

        /// <summary>
        /// The SSH agent is optional: it starts only after an agent config was
        /// written by the join/bootstrap step. It runs as LocalSystem so it can
        /// repair sshd and replace files locked by stale sshd-session children.
        /// </summary>
        private void EnsureSshAgent()
        {
            string config = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "dsh-mesh",
                "ssh-agent.json");
            if (!File.Exists(config))
            {
                StopProcess(ref sshAgent);
                return;
            }
            EnsureChild(ref sshAgent, () => StartSshAgent());
        }

        private Process StartSshAgent()
        {
            string node = Path.Combine(root, "runtime", "node", "node.exe");
            string script = Path.Combine(root, "code", "wireguard", "ssh-agent-service.js");
            if (!File.Exists(node) || !File.Exists(script)) return null;
            return Spawn(node, "\"" + script + "\"", "ssh-agent", delegate(object sender, EventArgs e)
            {
                Log("ssh-agent exited");
                ScheduleRestart();
            });
        }

        private void EnsureChild(ref Process slot, Func<Process> start)
        {
            lock (childLock)
            {
                if (stopping) return;
                if (slot != null && !slot.HasExited) return;
                try
                {
                    slot = start();
                    if (slot != null) Log("child started, pid " + slot.Id);
                }
                catch (Exception error)
                {
                    Log("cannot start child: " + error.Message);
                    slot = null;
                }
            }
            if (slot == null) ScheduleRestart();
        }

        private Process StartGate()
        {
            string script = Path.Combine(root, "start.ps1");
            if (!File.Exists(script)) { Log("missing " + script); return null; }
            return Spawn(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
                "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"", "gate", delegate(object sender, EventArgs e)
                {
                    Log("gate exited");
                    ScheduleRestart();
                });
        }

        private Process StartInterop()
        {
            string node = Path.Combine(root, "runtime", "node", "node.exe");
            string script = Path.Combine(root, "code", "interop-service", "server.mjs");
            if (!File.Exists(node) || !File.Exists(script)) return null;
            return Spawn(node, "\"" + script + "\"", "interop", delegate(object sender, EventArgs e)
            {
                Log("interop exited");
                ScheduleRestart();
            });
        }

        private Process Spawn(string file, string arguments, string tag, EventHandler exited)
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = file;
            info.Arguments = arguments;
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            Process process = new Process();
            process.StartInfo = info;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("[" + tag + "] " + e.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("[" + tag + "!] " + e.Data);
            };
            process.Exited += exited;
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return process;
        }

        private void ScheduleRestart()
        {
            lock (childLock)
            {
                if (stopping || restartTimer != null) return;
                restartTimer = new Timer(delegate(object state)
                {
                    DisposeTimer(ref restartTimer);
                    EnsureSession0Children();
                }, null, 5000, Timeout.Infinite);
            }
        }

        private void StopSession0Children()
        {
            StopProcess(ref gate);
            StopProcess(ref interop);
            StopProcess(ref sshAgent);
        }

        private void StopStack()
        {
            EndTask();
            StopSession0Children();
        }

        private void StopProcess(ref Process slot)
        {
            Process process;
            lock (childLock)
            {
                process = slot;
                slot = null;
            }
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
            try
            {
                if (!process.HasExited) process.WaitForExit(5000);
            }
            catch { }
        }

        public static void Main()
        {
            ServiceBase.Run(new GatewayService());
        }

        private void Log(string line)
        {
            string text = DateTime.Now.ToString("o") + " " + line;
            lock (logLock)
            {
                try { File.AppendAllText(logPath, text + Environment.NewLine); } catch { }
            }
        }
    }
}
