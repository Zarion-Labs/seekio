const http = require('http');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PID_FILE = path.join(__dirname, 'seekio.pid');
const AUTO_CLOSE = process.argv.includes('--auto-close');
const hostArg = process.argv.indexOf('--host');
const HOST = hostArg !== -1 ? process.argv[hostArg + 1] : '127.0.0.1';
const portArg = process.argv.indexOf('--port');
const PORT = portArg !== -1 ? parseInt(process.argv[portArg + 1]) : 3456;
const DISPLAY_HOST = HOST === '0.0.0.0' ? 'localhost' : HOST;

// --stop: kill a background instance and exit
if (process.argv.includes('--stop')) {
  if (!fs.existsSync(PID_FILE)) {
    console.log('seekio is not running (no PID file found)');
    process.exit(1);
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log(`seekio stopped (PID ${pid})`);
  } catch {
    fs.existsSync(PID_FILE) && fs.unlinkSync(PID_FILE);
    console.log(`seekio process ${pid} was not running — PID file removed`);
  }
  process.exit(0);
}

// --status: check if a background instance is alive
if (process.argv.includes('--status')) {
  if (!fs.existsSync(PID_FILE)) { console.log('seekio: not running'); process.exit(1); }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
  try { process.kill(pid, 0); console.log(`seekio: running (PID ${pid}) → http://${DISPLAY_HOST}:${PORT}`); process.exit(0); }
  catch { console.log('seekio: not running (stale PID file)'); fs.unlinkSync(PID_FILE); process.exit(1); }
}

// --background: spawn a hidden detached copy and exit immediately
if (process.argv.includes('--background')) {
  // If already running, just open a new browser tab instead of spawning a duplicate
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
    try {
      process.kill(pid, 0); // throws if not alive
      const dashUrl = `http://${DISPLAY_HOST}:${PORT}`;
      console.log(`seekio already running (PID ${pid}) → ${dashUrl}`);
      if (process.platform === 'win32') {
        const winBrowsers = [
          'C:\\Program Files\\Chromium\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ];
        const exe = winBrowsers.find(p => fs.existsSync(p));
        if (exe) { const b = spawn(exe, [dashUrl], { detached: true, stdio: 'ignore' }); b.unref(); }
        else execSync(`powershell -NoProfile -WindowStyle Hidden -Command "Start-Process '${dashUrl}'"`, { windowsHide: true, stdio: 'ignore' });
      }
      process.exit(0);
    } catch {
      fs.unlinkSync(PID_FILE); // stale PID — fall through to fresh start
    }
  }
  // Always auto-close in background mode: shuts down 5s after last browser tab closes
  const args = process.argv.slice(2).filter(a => a !== '--background');
  if (!args.includes('--auto-close')) args.push('--auto-close');
  const child = spawn(process.execPath, [__filename, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`seekio started in background (PID ${child.pid})`);
  console.log(`  Dashboard → http://${DISPLAY_HOST}:${PORT}`);
  console.log(`  Stop with → node seekio.js --stop`);
  process.exit(0);
}

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Display-name overrides for sessions launched via /api/new with a name param.
// Queue: each POST with name pushes a name; the next new PID discovered claims it.
const sessionNameQueue = [];
const sessionNameMap = new Map(); // pid → display name

// --- Agent name helpers ---
const AGENT_NAMES = ['Ace','Atlas','Blaze','Cedar','Chip','Clay','Cole','Dace',
  'Dawn','Dell','Echo','Fern','Finn','Flux','Ford','Gale','Gene','Glen','Grey',
  'Halo','Hawk','Haze','Iris','Jade','Jett','Kane','Kira','Knox','Lane','Lark',
  'Lena','Levi','Lux','Mace','Mira','Nash','Neon','Nova','Orin','Owen','Page',
  'Park','Pax','Pike','Remy','Rex','Rift','Rio','Rox','Rune','Rush','Sage',
  'Shaw','Skye','Sora','Tace','Teal','Tide','Vex','Wade','Ward','Wren','Zara','Zed'];

function hashStr(s) {
  s = String(s ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function agentName(agentId, customTitle) {
  if (customTitle) return customTitle;
  return AGENT_NAMES[hashStr(agentId) % AGENT_NAMES.length];
}

function getKeyArg(toolName, input) {
  if (!input) return '';
  const n = (toolName || '').toLowerCase();
  if (n === 'read' || n === 'edit' || n === 'write' || n === 'multiedit') return String(input.file_path || '');
  if (n === 'bash') return String(input.command || '').slice(0, 80);
  if (n === 'grep') return String(input.pattern || '');
  if (n === 'glob') return String(input.pattern || '');
  if (n === 'agent' || n === 'task') return String(input.prompt || input.task || '').slice(0, 60);
  const firstVal = Object.values(input).find(v => typeof v === 'string');
  return firstVal ? String(firstVal).slice(0, 80) : '';
}

// --- Platform detection ---
const args = process.argv.slice(2);
const IS_WIN = args.includes('--win') || (!args.includes('--mac') && process.platform === 'win32');

// --- Path helpers ---
function encodePath(cwd) {
  if (IS_WIN) return cwd.replace(/[\\/: ]/g, '-');
  return cwd.replace(/\//g, '-');
}

function displayName(projDir) {
  if (IS_WIN) {
    return projDir.replace(/^[A-Za-z]--Users-[^-]+-Documents-/, '');
  }
  return projDir
    .replace(/-Users-[^-]+-Documents-/, '')
    .replace(/-Users-[^-]+-Downloads-?/, '~/Downloads/')
    .replace(/-Users-[^-]+-/, '~/')
    .replace(/^-Users-[^-]+$/, '~');
}

// --- macOS Adapter ---
const macAdapter = {
  getSessions() {
    try {
      const pids = execSync("pgrep -x claude 2>/dev/null || true", { encoding: 'utf8' }).trim();
      if (!pids) return [];

      return pids.split('\n').filter(Boolean).map(pid => {
        try {
          const info = execSync(`ps -o pid=,tty=,%cpu=,%mem=,etime=,state= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim();
          if (!info) return null;
          const [pidStr, tty, cpu, mem, elapsed, state] = info.split(/\s+/);

          let cwd = '';
          try { cwd = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, { encoding: 'utf8' }).trim(); } catch {}
          if (!cwd) try { cwd = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, { encoding: 'utf8' }).trim().replace(/^n/, ''); } catch {}

          const { messages, toolCalls, currentTool } = getSessionMessages(cwd, 20);

          let status = 'idle';
          const cpuNum = parseFloat(cpu);
          if (messages.length) {
            const last = messages[messages.length - 1];
            if (last.role === 'user') status = 'working';
            else if (last.hasToolUse) status = 'thinking';
          }
          if (status === 'idle' && cpuNum > 10) status = 'working';

          const subAgentProjKey = cwd ? encodePath(cwd) : null;
          const subAgentProjDir = subAgentProjKey ? path.join(PROJECTS_DIR, subAgentProjKey) : null;
          const subAgents = subAgentProjDir ? readSubAgents(subAgentProjDir) : [];

          if (!sessionNameMap.has(pidStr) && sessionNameQueue.length) sessionNameMap.set(pidStr, sessionNameQueue.shift());
          const sessionLabel = sessionNameMap.get(pidStr);
          return {
            pid: pidStr, tty, cpu: `${cpu}%`, mem: `${mem}%`, elapsed, cwd,
            projectName: sessionLabel ? `${sessionLabel} · ${cwd ? path.basename(cwd) : 'unknown'}` : cwd ? path.basename(cwd) : 'unknown',
            status, messages, toolCalls, currentTool, subAgents,
          };
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  },

  launch(dirPath, claudeCmd) {
    const shellCmd = `cd ${JSON.stringify(dirPath)} && ${claudeCmd}`;
    const scriptFile = `/tmp/seekio-script-${Date.now()}.scpt`;
    fs.writeFileSync(scriptFile, `tell application "Terminal"\ndo script ${JSON.stringify(shellCmd)}\nend tell`);
    execSync(`osascript ${scriptFile}`, { encoding: 'utf8' });
    try { fs.unlinkSync(scriptFile); } catch {}
  },

  send(tty, pid, message) {
    if (!/^\d+$/.test(tty.replace(/^ttys?0*/, ''))) throw new Error('invalid tty');
    const ttyNum = tty.replace(/^ttys?0*/, '');
    const tmpFile = `/tmp/seekio-msg-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, message);
    const script = [
      'tell application "Terminal"',
      '  repeat with w from 1 to count of windows',
      '    set win to window w',
      '    repeat with t from 1 to count of tabs of win',
      '      set theTab to tab t of win',
      `      if tty of theTab contains "${ttyNum}" then`,
      '        set selected tab of win to theTab',
      '        delay 0.2',
      '        tell application "System Events"',
      '          tell process "Terminal"',
      `            set msgText to (read POSIX file "${tmpFile}")`,
      '            keystroke msgText',
      '            keystroke return',
      '          end tell',
      '        end tell',
      '        return "sent"',
      '      end if',
      '    end repeat',
      '  end repeat',
      'end tell',
    ].join('\n');
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8', timeout: 5000 });
    try { fs.unlinkSync(tmpFile); } catch {}
  },

  focus(tty, pid) {
    if (!/^\d+$/.test(tty.replace(/^ttys?0*/, ''))) throw new Error('invalid tty');
    const ttyNum = tty.replace(/^ttys?0*/, '');
    const script = `tell application "Terminal"\nactivate\nrepeat with w from 1 to count of windows\nset win to window w\nrepeat with t from 1 to count of tabs of win\nset theTab to tab t of win\nif tty of theTab contains "${ttyNum}" then\nset selected tab of win to theTab\nset index of win to 1\nreturn "found"\nend if\nend repeat\nend repeat\nend tell`;
    const out = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8' });
    return { found: String(out || '').includes('found') };
  },
};

// --- Windows Adapter ---
const windowsAdapter = {
  getSessions() {
    try {
      const ps1 = path.join(os.tmpdir(), `seekio-ps-${Date.now()}.ps1`);
      // Try WMI first; fall back to PEB reading via C# for processes where WMI returns empty CWD
      const psCode = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class SeekioCwd {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int s, out int r);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr a, Peb, b, cc, d, e; }
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int s, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool b, uint p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Get(int pid) {
    var h = OpenProcess(0x0410u, false, (uint)pid);
    if (h == IntPtr.Zero) return "";
    try {
      var pbi = default(PBI); int r;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out r) != 0) return "";
      var peb = new byte[0x400]; int n;
      if (!ReadProcessMemory(h, pbi.Peb, peb, peb.Length, out n)) return "";
      int po = IntPtr.Size == 8 ? 0x20 : 0x10;
      var ppa = new IntPtr(IntPtr.Size == 8 ? BitConverter.ToInt64(peb, po) : (long)BitConverter.ToInt32(peb, po));
      var pp = new byte[0x500];
      if (!ReadProcessMemory(h, ppa, pp, pp.Length, out n)) return "";
      int co = IntPtr.Size == 8 ? 0x38 : 0x24;
      short cl = BitConverter.ToInt16(pp, co);
      if (cl <= 0) return "";
      long ca = IntPtr.Size == 8 ? BitConverter.ToInt64(pp, co+8) : (long)BitConverter.ToInt32(pp, co+4);
      var cd = new byte[cl];
      if (!ReadProcessMemory(h, new IntPtr(ca), cd, cd.Length, out n)) return "";
      var s = Encoding.Unicode.GetString(cd);
      int z = s.IndexOf('\\0'); if (z >= 0) s = s.Substring(0, z);
      return s.TrimEnd('\\\\');
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  $wmi = Get-WmiObject Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue
  $cwd = if ($wmi -and $wmi.WorkingDirectory) { $wmi.WorkingDirectory.TrimEnd('\\') } else { '' }
  if (-not $cwd) { try { $cwd = [SeekioCwd]::Get([int]$p.Id) } catch {} }
  # Walk the process tree (up to parent and to children) to detect if there's ANY visible window.
  # This is how we know whether the session is "headless" — dispatched with -WindowStyle Hidden
  # or its terminal was killed while claude.exe kept running.
  $hwnd = [int64]$p.MainWindowHandle
  if ($hwnd -eq 0 -and $wmi -and $wmi.ParentProcessId) {
    $par = Get-Process -Id ([int]$wmi.ParentProcessId) -ErrorAction SilentlyContinue
    if ($par) { $hwnd = [int64]$par.MainWindowHandle }
  }
  [PSCustomObject]@{
    id    = [string]$p.Id
    cwd   = if ($cwd) { $cwd } else { '' }
    memMB = [int]($p.WorkingSet64 / 1MB)
    start = if ($p.StartTime) { $p.StartTime.ToString('o') } else { '' }
    hasWindow = ($hwnd -ne 0)
  }
} | ConvertTo-Json -Compress`;
      fs.writeFileSync(ps1, psCode.trim());
      const raw = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
      try { fs.unlinkSync(ps1); } catch {}
      if (!raw) return [];

      let procs = JSON.parse(raw);
      if (!Array.isArray(procs)) procs = [procs];

      return procs.map(p => {
        let cwd = p.cwd || '';

        // Last-resort fallback: find the most recently active project in ~/.claude/projects/
        // that was modified at or after this process started
        let projDirOverride = null;
        if (!cwd && fs.existsSync(PROJECTS_DIR)) {
          const startMs = p.start ? new Date(p.start).getTime() : 0;
          let bestDir = null, bestMtime = 0;
          try {
            for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
              const projPath = path.join(PROJECTS_DIR, projDir);
              if (!fs.statSync(projPath).isDirectory()) continue;
              for (const file of fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))) {
                const mtime = fs.statSync(path.join(projPath, file)).mtimeMs;
                if (mtime > bestMtime && mtime >= startMs - 60000) {
                  bestMtime = mtime;
                  bestDir = projDir;
                }
              }
            }
          } catch {}
          if (bestDir) projDirOverride = bestDir;
        }

        const { messages, toolCalls, currentTool } = projDirOverride
          ? getSessionMessagesByProjDir(projDirOverride, 20)
          : getSessionMessages(cwd, 20);

        let status = 'idle';
        if (messages.length) {
          const last = messages[messages.length - 1];
          if (last.role === 'user') status = 'working';
          else if (last.hasToolUse) status = 'thinking';
        }

        const startTime = p.start ? new Date(p.start) : null;
        const elapsed = startTime ? formatElapsed(startTime) : '';

        const displayCwd = cwd || projDirOverride || '';
        const projectName = cwd
          ? path.basename(cwd)
          : projDirOverride
            ? displayName(projDirOverride)
            : 'unknown';

        // Determine projDir for sub-agent reading
        const subAgentProjDir = projDirOverride
          ? path.join(PROJECTS_DIR, projDirOverride)
          : cwd ? path.join(PROJECTS_DIR, encodePath(cwd)) : null;
        const subAgents = subAgentProjDir ? readSubAgents(subAgentProjDir) : [];

        if (!sessionNameMap.has(p.id) && sessionNameQueue.length) sessionNameMap.set(p.id, sessionNameQueue.shift());
        const sessionLabel = sessionNameMap.get(p.id);
        return {
          pid: p.id,
          tty: '',
          cpu: '?',
          mem: p.memMB ? `${p.memMB}MB` : '?',
          elapsed,
          cwd: displayCwd,
          projectName: sessionLabel ? `${sessionLabel} · ${projectName}` : projectName,
          status,
          messages,
          toolCalls,
          currentTool,
          subAgents,
          hidden: !p.hasWindow,
        };
      });
    } catch { return []; }
  },

  launch(dirPath, claudeCmd, hidden = false) {
    const tmpBat = path.join(os.tmpdir(), `seekio-${Date.now()}.bat`);
    fs.writeFileSync(tmpBat, `@echo off\ncd /d "${dirPath}"\n${claudeCmd}\n`);
    if (hidden) {
      // Headless: no terminal window. Claude runs in background, seekio detects it via WMI.
      const ps = `Start-Process -FilePath cmd.exe -ArgumentList '/c "${tmpBat}"' -WorkingDirectory '${dirPath}' -WindowStyle Hidden`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'ignore' });
    } else {
      try {
        execSync(`where wt`, { stdio: 'ignore' });
        // `.bat` already starts with `cd /d "${dirPath}"`, so wt does not
        // need -d. Dropping -d avoids wt's arg parser mangling paths with
        // multiple space-separated segments (e.g. "Zarion Labs\seekio").
        execSync(`wt cmd /k "${tmpBat}"`, { stdio: 'ignore' });
      } catch {
        execSync(`start "seekIO" cmd /k "${tmpBat}"`, { shell: true, stdio: 'ignore' });
      }
    }
    setTimeout(() => { try { fs.unlinkSync(tmpBat); } catch {} }, 10000);
  },

  send(tty, pid, message) {
    if (!/^\d+$/.test(String(pid))) throw new Error('invalid pid');
    const msgFile = path.join(os.tmpdir(), `seekio-msg-${Date.now()}.txt`);
    fs.writeFileSync(msgFile, message, 'utf8');

    const ps1 = path.join(os.tmpdir(), `seekio-send-${Date.now()}.ps1`);
    const msgFileEsc = msgFile.replace(/\\/g, '\\\\');
    fs.writeFileSync(ps1, `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class SeekioConsole {
  public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT_RECORD {
    [FieldOffset(0)] public short EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEY_EVENT_RECORD {
    public bool bKeyDown;
    public short wRepeatCount;
    public short wVirtualKeyCode;
    public short wVirtualScanCode;
    public char UnicodeChar;
    public int dwControlKeyState;
  }
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
  public static void Inject(uint pid, string text) {
    FreeConsole();
    if (!AttachConsole(pid)) return;
    var h = GetStdHandle(-10);
    var chars = text + "\\r";
    var records = new INPUT_RECORD[chars.Length * 2];
    for (int i = 0; i < chars.Length; i++) {
      records[i*2] = new INPUT_RECORD { EventType = 1, KeyEvent = new KEY_EVENT_RECORD { bKeyDown = true, wRepeatCount = 1, UnicodeChar = chars[i] } };
      records[i*2+1] = new INPUT_RECORD { EventType = 1, KeyEvent = new KEY_EVENT_RECORD { bKeyDown = false, wRepeatCount = 1, UnicodeChar = chars[i] } };
    }
    uint written;
    WriteConsoleInput(h, records, (uint)records.Length, out written);
    FreeConsole();
  }
}
"@
$msg = [System.IO.File]::ReadAllText("${msgFileEsc}").TrimEnd()
[SeekioConsole]::Inject(${pid}, $msg)
`.trim());

    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { encoding: 'utf8', timeout: 8000 });
    } finally {
      try { fs.unlinkSync(ps1); } catch {}
      try { fs.unlinkSync(msgFile); } catch {}
    }
  },

  focus(tty, pid) {
    if (!/^\d+$/.test(String(pid))) throw new Error('invalid pid');
    const ps1 = path.join(os.tmpdir(), `seekio-focus-${Date.now()}.ps1`);
    fs.writeFileSync(ps1, `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SeekioFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
function Find-Window {
  param([int]$wpid, [int]$depth = 0)
  if ($depth -gt 6) { return [int64]0 }
  try {
    $p = Get-Process -Id $wpid -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne $null -and [int64]$p.MainWindowHandle -ne 0) {
      return [int64]$p.MainWindowHandle
    }
    $wmi = Get-WmiObject Win32_Process -Filter "ProcessId=$wpid" -ErrorAction SilentlyContinue
    if ($wmi -and $wmi.ParentProcessId -and [int]$wmi.ParentProcessId -gt 0 -and [int]$wmi.ParentProcessId -ne $wpid) {
      $h = Find-Window -wpid ([int]$wmi.ParentProcessId) -depth ($depth + 1)
      if ($h -ne 0) { return $h }
    }
    $children = Get-WmiObject Win32_Process -Filter "ParentProcessId=$wpid" -ErrorAction SilentlyContinue
    if ($children) {
      foreach ($c in @($children)) {
        $h = Find-Window -wpid ([int]$c.ProcessId) -depth ($depth + 1)
        if ($h -ne 0) { return $h }
      }
    }
  } catch {}
  return [int64]0
}
$hwnd = Find-Window -wpid ${pid}
if ($hwnd -ne $null -and $hwnd -gt 0) {
  try {
    [SeekioFocus]::ShowWindow([IntPtr]$hwnd, 5)
    [SeekioFocus]::SetForegroundWindow([IntPtr]$hwnd)
    Write-Output "FOUND"
  } catch { Write-Output "ERR" }
} else {
  Write-Output "NONE"
}
`.trim());
    try {
      const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { encoding: 'utf8', timeout: 5000 }).trim();
      return { found: out.includes('FOUND') };
    } finally {
      try { fs.unlinkSync(ps1); } catch {}
    }
  },
};

const platform = IS_WIN ? windowsAdapter : macAdapter;

// Reads the last readSize bytes of a file and returns the string content.
function readFileTail(filePath, readSize) {
  const stat = fs.statSync(filePath);
  const size = Math.min(stat.size, readSize);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Finds the most recently modified non-subagent .jsonl in projDir,
// parses it, and returns { messages, toolCalls, currentTool }.
function parseSessionDir(projDir, count) {
  try {
    if (!fs.existsSync(projDir)) return { messages: [], toolCalls: [], currentTool: null };
    const files = fs.readdirSync(projDir)
      .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(projDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return { messages: [], toolCalls: [], currentTool: null };

    const filePath = path.join(projDir, files[0].name);
    const raw = readFileTail(filePath, 65536);
    const lines = raw.split('\n').filter(Boolean);

    const msgs = [];
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const role = d.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const content = d.message.content;
        let text = '', hasToolUse = false, hasToolResult = false;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text?.trim() && !text) text = c.text.trim();
            if (c.type === 'tool_use') hasToolUse = true;
            if (c.type === 'tool_result') hasToolResult = true;
          }
        }
        if (text) msgs.push({ role, text: text.slice(0, 2000), hasToolUse, hasToolResult });
        else if (hasToolUse || hasToolResult) {
          msgs.push({ role, text: hasToolUse ? '(using tools...)' : '(tool result)', hasToolUse, hasToolResult });
        }
      } catch {}
    }

    const toolCalls = parseToolCalls(lines);
    const running = toolCalls.filter(tc => tc.status === 'running');
    const currentTool = running.length ? running[running.length - 1].name : null;

    // Preserve last 'count' real-text messages so tool-heavy sessions don't wipe history.
    // Include any trailing tool-only messages so status detection stays accurate.
    const realMsgs = msgs.filter(m => m.text !== '(using tools...)' && m.text !== '(tool result)');
    const recentReal = realMsgs.slice(-count);
    let displayMsgs;
    if (recentReal.length === 0) {
      displayMsgs = msgs.slice(-count);
    } else {
      const oldestIdx = msgs.indexOf(recentReal[0]);
      displayMsgs = oldestIdx >= 0 ? msgs.slice(oldestIdx) : msgs.slice(-count);
    }

    return { messages: displayMsgs, toolCalls, currentTool };
  } catch (err) {
    console.error('[parseSessionDir]', projDir, err.message);
    return { messages: [], toolCalls: [], currentTool: null };
  }
}

// Cache: parentJSONL path -> { mtime, calls: [{name, promptStart}] }
const parentAgentCallCache = new Map();

// Scan a parent session JSONL for named Agent tool_use blocks, with mtime-based caching.
function getParentAgentCalls(projDir, sessionId) {
  const parentPath = path.join(projDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(parentPath)) return [];
  try {
    const mtime = fs.statSync(parentPath).mtimeMs;
    const cached = parentAgentCallCache.get(parentPath);
    if (cached && cached.mtime === mtime) return cached.calls;
    const calls = [];
    for (const line of fs.readFileSync(parentPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.message?.role === 'assistant' && Array.isArray(d.message.content)) {
          for (const block of d.message.content) {
            if (block.type === 'tool_use' && block.name === 'Agent' && block.input?.name) {
              calls.push({ name: block.input.name, promptStart: (block.input.prompt || '').slice(0, 300) });
            }
          }
        }
      } catch {}
    }
    parentAgentCallCache.set(parentPath, { mtime, calls });
    return calls;
  } catch { return []; }
}

// Read the very first user message in a JSONL file (reads from position 0, not the tail).
function readFirstUserMessage(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.message?.role === 'user') {
          const c = d.message.content;
          if (typeof c === 'string' && c.trim()) return c.trim();
          if (Array.isArray(c)) { for (const b of c) { if (b.type === 'text' && b.text?.trim()) return b.text.trim(); } }
        }
      } catch {}
    }
  } catch {}
  return '';
}

// Reads sub-agent JSONL files from projDir and returns structured agent objects.
// Supports two layouts:
//   Legacy: projDir/some-subagent-uuid.jsonl  (filename contains "subagent")
//   Current: projDir/{sessionId}/subagents/agent-{agentId}.jsonl
function readSubAgents(projDir) {
  try {
    if (!fs.existsSync(projDir)) return [];

    // Collect all sub-agent files from both layouts
    const fileEntries = [];

    // Legacy layout: files directly in projDir with "subagent" in the name
    for (const f of fs.readdirSync(projDir)) {
      if (f.endsWith('.jsonl') && f.includes('subagent')) {
        fileEntries.push({ filePath: path.join(projDir, f), mtime: fs.statSync(path.join(projDir, f)).mtimeMs });
      }
    }

    // Current layout: projDir/{sessionId}/subagents/agent-*.jsonl
    for (const entry of fs.readdirSync(projDir)) {
      const entryPath = path.join(projDir, entry);
      try {
        if (!fs.statSync(entryPath).isDirectory()) continue;
        const subagentsDir = path.join(entryPath, 'subagents');
        if (!fs.existsSync(subagentsDir)) continue;
        for (const f of fs.readdirSync(subagentsDir)) {
          if (!f.endsWith('.jsonl') || f.endsWith('.meta.json')) continue;
          const fp = path.join(subagentsDir, f);
          fileEntries.push({ filePath: fp, mtime: fs.statSync(fp).mtimeMs });
        }
      } catch { continue; }
    }

    const files = fileEntries.sort((a, b) => b.mtime - a.mtime);

    return files.map(({ filePath, mtime }) => {
      try {
        const raw = readFileTail(filePath, 65536);
        const lines = raw.split('\n').filter(Boolean);

        let foundAgentId = '';
        let customTitle = '';
        const messages = [];

        for (const line of lines) {
          let d;
          try { d = JSON.parse(line); } catch { continue; }
          // Capture agentId from any entry that has it
          if (d.agentId && !foundAgentId) foundAgentId = d.agentId;
          // Capture custom title from summary/title entries
          if (d.title && !customTitle) customTitle = d.title;
          if (d.customTitle && !customTitle) customTitle = d.customTitle;

          const role = d.message?.role;
          if (role !== 'user' && role !== 'assistant') continue;
          const content = d.message.content;
          let text = '';
          if (typeof content === 'string') text = content;
          else if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'text' && c.text?.trim()) { text = c.text.trim(); break; }
            }
          }
          if (text) messages.push({ role, text: text.slice(0, 500) });
        }

        if (!messages.length) return null;

        const toolCalls = parseToolCalls(lines);
        const running = toolCalls.filter(tc => tc.status === 'running');
        let status = 'idle';
        if (running.length) status = 'working';
        else if (messages.length && messages[messages.length - 1].role === 'user') status = 'working';

        // If the file hasn't been written in >2 min the agent is no longer running —
        // interrupted sessions leave dangling 'working' indicators in the JSONL.
        if (status !== 'idle' && Date.now() - mtime > 120_000) status = 'idle';

        const agentId = foundAgentId || path.basename(filePath, '.jsonl').replace(/^agent-/, '');

        // If no title in the subagent JSONL, look for the name in the parent session.
        // Current layout: projDir/{sessionId}/subagents/agent-{id}.jsonl
        // → parent session id is the grandparent directory name.
        if (!customTitle) {
          const sessionDirName = path.basename(path.dirname(path.dirname(filePath)));
          if (/^[0-9a-f-]{36}$/i.test(sessionDirName)) {
            const parentCalls = getParentAgentCalls(projDir, sessionDirName);
            if (parentCalls.length) {
              const firstMsg = readFirstUserMessage(filePath);
              const key = firstMsg.slice(0, 120);
              for (const call of parentCalls) {
                const pKey = call.promptStart.slice(0, 120);
                if (key && pKey && (key.startsWith(pKey.slice(0, 80)) || pKey.startsWith(key.slice(0, 80)))) {
                  customTitle = call.name;
                  break;
                }
              }
            }
          }
        }

        return {
          agentId,
          name: agentName(agentId, customTitle),
          nameOrigin: customTitle ? 'renamed' : 'generated',
          messages,
          toolCalls,
          status,
          lastModifiedMs: mtime,
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getSessionMessages(cwd, count = 20) {
  if (!cwd) return { messages: [], toolCalls: [], currentTool: null };
  const projKey = encodePath(cwd);
  const projDir = path.join(PROJECTS_DIR, projKey);
  return parseSessionDir(projDir, count);
}

// Like getSessionMessages but accepts an already-encoded project directory name
// (used when CWD is unavailable but we found the project dir via file scanning)
function getSessionMessagesByProjDir(projDirName, count = 20) {
  const projDir = path.join(PROJECTS_DIR, projDirName);
  return parseSessionDir(projDir, count);
}

// --- Helpers ---

// Reads the actual project CWD from the first JSONL entry that has a cwd field.
// This is more reliable than reconstructing from the encoded dir name (lossy on Windows).
function readCwdFromJsonl(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n').filter(Boolean)) {
      try {
        const d = JSON.parse(line);
        if (d.cwd && typeof d.cwd === 'string') return d.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

// --- Recent sessions ---

function getRecentSessions(limit = 20) {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const sessions = [];
    for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      if (!fs.statSync(projPath).isDirectory()) continue;
      for (const file of fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))) {
        const filePath = path.join(projPath, file);
        const stat = fs.statSync(filePath);
        let projectName = displayName(projDir);
        let firstMessage = '';
        try {
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(65536);
          const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
          fs.closeSync(fd);
          for (const line of buf.toString('utf8', 0, bytesRead).split('\n').filter(Boolean)) {
            try {
              const d = JSON.parse(line);
              if (d.type === 'user' && d.message?.role === 'user') {
                const content = d.message.content;
                if (typeof content === 'string') firstMessage = content.slice(0, 120);
                else if (Array.isArray(content)) { for (const c of content) { if (c.type === 'text') { firstMessage = c.text.slice(0, 120); break; } } }
                break;
              }
            } catch {}
          }
        } catch {}
        const cwd = readCwdFromJsonl(filePath) || projDir.replace(/-/g, '/');
        sessions.push({
          sessionId: path.basename(file, '.jsonl'), projectName, cwd,
          lastModified: stat.mtimeMs, lastModifiedStr: formatTimeAgo(stat.mtime), firstMessage: firstMessage || '(no message)',
        });
      }
    }
    return sessions.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
  } catch { return []; }
}

// --- Project roster ---

function getProjectRoster() {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const projects = [];
    for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      if (!fs.statSync(projPath).isDirectory()) continue;
      const files = fs.readdirSync(projPath)
        .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(projPath, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (!files.length) continue;

      // Read the actual CWD from the JSONL file (avoids lossy dir-name decoding on Windows)
      const cwd = readCwdFromJsonl(path.join(projPath, files[0].name)) || projDir.replace(/-/g, '/');
      let projectName = displayName(projDir);

      // Get latest session ID and first message
      const latestSession = path.basename(files[0].name, '.jsonl');
      let firstMessage = '';
      try {
        const fd = fs.openSync(path.join(projPath, files[0].name), 'r');
        const buf = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);
        for (const line of buf.toString('utf8', 0, bytesRead).split('\n').filter(Boolean)) {
          try {
            const d = JSON.parse(line);
            if (d.type === 'user' && d.message?.role === 'user') {
              const content = d.message.content;
              if (typeof content === 'string') firstMessage = content.slice(0, 120);
              else if (Array.isArray(content)) { for (const c of content) { if (c.type === 'text') { firstMessage = c.text.slice(0, 120); break; } } }
              break;
            }
          } catch {}
        }
      } catch {}

      projects.push({
        dirKey: projDir,
        cwd,
        projectName,
        latestSession,
        sessionCount: files.length,
        lastModified: files[0].mtime,
        lastModifiedStr: formatTimeAgo(new Date(files[0].mtime)),
        firstMessage: firstMessage || '(no message)',
      });
    }
    return projects.sort((a, b) => b.lastModified - a.lastModified);
  } catch { return []; }
}

function formatTimeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatElapsed(startTime) {
  const s = Math.floor((Date.now() - startTime.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// --- Tool call parser ---
// Parses JSONL lines and returns structured tool call objects.
// Pairs tool_use entries with their tool_result by id.
function parseToolCalls(lines) {
  const toolCalls = [];
  const pending = {}; // tool_use id -> index in toolCalls
  let msgIndex = -1;

  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const role = d.message?.role;
    if (!role) continue;
    const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
    const raw = d.message.content;
    const content = Array.isArray(raw) ? raw
      : typeof raw === 'string' ? [{ type: 'text', text: raw }]
      : [];

    if (role === 'user') {
      const hasText = content.some(c => c.type === 'text' && c.text?.trim());
      const hasResult = content.some(c => c.type === 'tool_result');
      if (hasText && !hasResult) msgIndex++;
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        const idx = pending[c.tool_use_id];
        if (idx === undefined) continue;
        const tc = toolCalls[idx];
        let result = '';
        if (typeof c.content === 'string') result = c.content;
        else if (Array.isArray(c.content)) {
          for (const rc of c.content) { if (rc.type === 'text') { result = rc.text; break; } }
        }
        tc.result = result.slice(0, 500);
        tc.isError = !!(c.is_error);
        tc.status = c.is_error ? 'error' : 'done';
        tc.endedAt = ts || Date.now();
        tc.durationMs = tc.startedAt ? tc.endedAt - tc.startedAt : null;
        delete pending[c.tool_use_id];
      }
    } else if (role === 'assistant') {
      for (const c of content) {
        if (c.type !== 'tool_use') continue;
        const tc = {
          msgIndex, id: c.id, name: c.name,
          input: c.input || {}, keyArg: getKeyArg(c.name, c.input || {}),
          result: null, isError: false, status: 'running',
          durationMs: null, startedAt: ts || 0, endedAt: null,
        };
        pending[c.id] = toolCalls.length;
        toolCalls.push(tc);
      }
    }
  }
  return toolCalls;
}

// --- SSE ---
const sseClients = new Set();
let autoCloseTimer = null;
setInterval(() => {
  const data = JSON.stringify({ live: platform.getSessions(), recent: getRecentSessions(), roster: getProjectRoster() });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}, 2000);

// --- Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ live: platform.getSessions(), recent: getRecentSessions(), roster: getProjectRoster() }));

  } else if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('\n');
    sseClients.add(res);
    const data = JSON.stringify({ live: platform.getSessions(), recent: getRecentSessions(), roster: getProjectRoster() });
    res.write(`data: ${data}\n\n`);
    req.on('close', () => {
      sseClients.delete(res);
      if (AUTO_CLOSE && sseClients.size === 0) {
        autoCloseTimer = setTimeout(() => {
          console.log('seekio: all clients disconnected — shutting down');
          fs.existsSync(PID_FILE) && fs.unlinkSync(PID_FILE);
          process.exit(0);
        }, 5_000);
      }
    });
    if (AUTO_CLOSE && autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null; }

  } else if (url.pathname === '/api/ls') {
    const raw = url.searchParams.get('dir') || '';
    // Resolve relative / empty paths against homedir so the client never has to
    // care about absolute vs relative.
    let resolved;
    if (!raw) {
      resolved = os.homedir();
    } else if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
      resolved = raw;
    } else {
      resolved = path.join(os.homedir(), raw);
    }
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dir: resolved, resolved, entries }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, dir: resolved, resolved, entries: [], error: e.code || String(e) }));
    }
    return;

  } else if (url.pathname === '/api/mkdir' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { path: dirPath } = JSON.parse(body);
        fs.mkdirSync(dirPath, { recursive: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/new' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { dir, cwd, prompt, skipPerms, name, hidden } = JSON.parse(body);
        const dirPath = (() => { const d = dir || cwd || ''; return d.startsWith('/') || /^[A-Za-z]:/.test(d) ? d : path.join(os.homedir(), d); })();
        let claudeCmd = 'claude';
        if (skipPerms) claudeCmd += ' --dangerously-skip-permissions';
        if (prompt) claudeCmd += ' ' + JSON.stringify(prompt);
        if (name) sessionNameQueue.push(name);
        platform.launch(dirPath, claudeCmd, !!hidden);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { tty, pid, message } = JSON.parse(body);
        platform.send(tty, pid, message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/launch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sessionId, cwd, skipPerms } = JSON.parse(body);
        let claudeCmd = `claude --resume ${sessionId}`;
        if (skipPerms) claudeCmd += ' --dangerously-skip-permissions';
        const dirPath = cwd.startsWith('/') || /^[A-Za-z]:/.test(cwd) ? cwd : `/${cwd}`;
        platform.launch(dirPath, claudeCmd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/focus') {
    const tty = url.searchParams.get('tty') || '';
    const pid = url.searchParams.get('pid') || '';
    let result = { found: false };
    try { result = platform.focus(tty, pid) || { found: false }; } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...result }));

  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
});

function openBrowser(url) {
  const WIN_BROWSERS = [
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  try {
    if (IS_WIN) {
      const exe = WIN_BROWSERS.find(p => fs.existsSync(p));
      if (exe) {
        // spawn detached so the browser process is independent of seekio
        const b = spawn(exe, [url], { detached: true, stdio: 'ignore' });
        b.unref();
      } else {
        // fall back to system default browser via ShellExecute
        execSync(`powershell -NoProfile -WindowStyle Hidden -Command "Start-Process '${url}'"`, { windowsHide: true, stdio: 'ignore' });
      }
    } else if (process.platform === 'darwin') {
      execSync(`open -a "Google Chrome" "${url}" 2>/dev/null || open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}" 2>/dev/null || google-chrome "${url}" 2>/dev/null || chromium-browser "${url}"`, { stdio: 'ignore' });
    }
  } catch { /* browser open is best-effort */ }
}

server.listen(PORT, HOST, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  const url = `http://${DISPLAY_HOST}:${PORT}`;
  console.log(`\n  seekIO running at ${url}`);
  if (HOST === '0.0.0.0') {
    const nets = os.networkInterfaces();
    const lanIps = Object.values(nets).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
    lanIps.forEach(ip => console.log(`  On your network:  http://${ip}:${PORT}`));
  }
  if (AUTO_CLOSE) console.log('  Auto-close: shuts down 5s after last browser tab closes');
  console.log(`  Stop with: node seekio.js --stop\n`);
  openBrowser(url);
});

process.on('exit', () => { try { fs.existsSync(PID_FILE) && fs.unlinkSync(PID_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
