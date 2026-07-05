/**
 * JARVIS Island — single-file version.
 *
 * Everything lives in this one file. The UI (HTML/CSS/JS) is embedded
 * as a string below and loaded as a data: URL, so there's no separate
 * index.html. Communication from the page back to this main process
 * uses a URL-interception trick instead of preload.js + contextBridge
 * (which kept failing to load reliably) - the page sets
 * window.location.href to a custom "jarvisisland://" URL, this file
 * intercepts that navigation attempt before it actually happens, and
 * runs the matching action. No preload script needed at all.
 */
const { app, BrowserWindow, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

// NOTE: app.disableHardwareAcceleration() was removed here as a test.
// It was added at the same time as backgroundColor below, without
// confirming which one actually fixed the original white-block bug.
// Forcing software rendering is a known cause of stale-repaint issues
// in Electron (DOM changes happen but the screen doesn't visually
// update), which would explain buttons seeming to do nothing and
// glitches on a second open - if the white block comes back without
// this line, we'll know it was actually necessary and look for a
// different fix for the repaint issue instead.

const JARVIS_DIR = path.join(__dirname, "..");
const JARVIS_SCRIPT = path.join(JARVIS_DIR, "JARVIS.py");
const JARVIS_URL = "http://127.0.0.1:5000";
const DATA_DIR = path.join(JARVIS_DIR, "jarvis_data");
const DATA_FILE = path.join(DATA_DIR, "island_data.json");
const BRIDGE_PORT = 17345; // internal-only local server the page talks to via fetch()
// Same shared JSONBin that Inbox and admin.html read/write - Island's
// fields (islandApiKey, islandAnnouncement, islandProPrice, etc.) live
// alongside Inbox's under different key names, set from the "Island"
// tab in admin.html. Island has no sign-in, so instead of an email it
// generates a random device ID once and persists it - codes generated
// in admin for that device ID get redeemed against it.
const ISLAND_JBIN_URL = "https://api.jsonbin.io/v3/b/6a30dea2da38895dfec7bede";
const ISLAND_JBIN_KEY = "$2a$10$6qmVIqD9vfUdur5dAZqc4eHFHI.6V5jIIVM6wiS1QyiFXgorvBs1G";

function getOrCreateDeviceId() {
  const data = loadLocalData();
  if (data.islandDeviceId) return data.islandDeviceId;
  const id = crypto.randomBytes(8).toString("hex");
  data.islandDeviceId = id;
  saveLocalData(data);
  return id;
}
// Generated fresh every time the app starts. The renderer only learns
// this value because it's baked directly into the HTML string that
// main.js builds (buildHTML(), below) - no other process on the
// machine has it. Without this, ANY webpage open in a browser, or any
// other program running locally, could POST to 127.0.0.1:17345 and
// trigger open-file / smart-rename / os-command / etc. with no proof
// the request actually came from the Island's own window. This was
// the source of the "unauthorized file access on startup" bug: the
// bridge server had no way to tell a legit request from anyone else's.
const BRIDGE_TOKEN = crypto.randomBytes(24).toString("hex");

// --- Rules system -----------------------------------------------------
// User-defined automation: you set the trigger (a hotkey or a typed
// phrase) and the chain of actions, you can see every rule, edit or
// delete it. No watching, no guessing, no silent learning - the
// opposite shape of "AI watches you and infers what you want."
const RULES_FILE_DIR = path.join(JARVIS_DIR, "jarvis_data");
const RULES_FILE = path.join(RULES_FILE_DIR, "rules.json");

function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) return JSON.parse(fs.readFileSync(RULES_FILE, "utf-8"));
  } catch (e) {}
  return [];
}
function saveRulesToDisk(rules) {
  if (!fs.existsSync(RULES_FILE_DIR)) fs.mkdirSync(RULES_FILE_DIR, { recursive: true });
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

let rulesCache = loadRules();

function registerAllHotkeys() {
  const { globalShortcut } = require("electron");
  globalShortcut.unregisterAll();
  rulesCache.forEach((rule) => {
    if (rule.trigger.type === "hotkey" && rule.trigger.value) {
      try {
        const ok = globalShortcut.register(rule.trigger.value, () => {
          if (win) win.webContents.executeJavaScript(`executeRuleById(${JSON.stringify(rule.id)})`);
        });
        if (!ok) {
          // Electron's accelerator syntax only supports specific modifier
          // keys (Control, Alt, Shift, Super/Cmd, CommandOrControl) -
          // CapsLock isn't one of them, so a rule like "CapsLock+B" will
          // silently fail to register without this explicit check.
          console.log(`Hotkey "${rule.trigger.value}" for rule "${rule.name}" failed to register - check it uses a valid modifier (Control, Alt, Shift, Super), not something like CapsLock which Electron doesn't support as a combinable key.`);
        }
      } catch (e) {
        console.log("Failed to register hotkey for rule", rule.id, e.message);
      }
    }
  });
}

function runStartupRules() {
  rulesCache.forEach((rule) => {
    if (rule.trigger.type === "startup" && win) {
      win.webContents.executeJavaScript(`executeRuleById(${JSON.stringify(rule.id)})`);
    }
  });
}

// Real Windows media-session API (the same one your lock screen uses
// for "now playing") - works with whatever app currently owns the
// system media session: Spotify desktop, a YouTube Music browser tab,
// anything. Written as a real .ps1 file instead of an inline -command
// string, since inline PowerShell with this many nested quotes has
// been a repeated source of bugs in this file.
const NOW_PLAYING_SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
Function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
try {
    $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $session = $manager.GetCurrentSession()
    if ($session) {
        $info = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $timeline = $session.GetTimelineProperties()
        $playback = $session.GetPlaybackInfo()
        $result = [PSCustomObject]@{
            title = $info.Title
            artist = $info.Artist
            appName = $session.SourceAppUserModelId
            status = $playback.PlaybackStatus.ToString()
            positionSec = $timeline.Position.TotalSeconds
            durationSec = $timeline.EndTime.TotalSeconds
        }
        $result | ConvertTo-Json -Compress
    } else {
        '{}'
    }
} catch {
    '{}'
}
`;
let nowPlayingScriptPath = null;
function ensureNowPlayingScript() {
  if (nowPlayingScriptPath) return nowPlayingScriptPath;
  nowPlayingScriptPath = path.join(require("os").tmpdir(), "island_now_playing.ps1");
  fs.writeFileSync(nowPlayingScriptPath, NOW_PLAYING_SCRIPT);
  return nowPlayingScriptPath;
}

const COLLAPSED = { width: 480, height: 280 };
const ACTIVE_WIDTH = 340; // wider pill width when showing a live activity like a song name, so text doesn't get clipped/look "blocky"
const EXPANDED = { width: 500, height: 640 };

let win;

// Lets a "Start Island" link on a webpage (chattyisland://start) either
// wake up the Island that's already running, or - if this is the very
// first launch - register the app as the handler for that protocol so
// future clicks work without needing npm/node to be touched again.
// Without requestSingleInstanceLock, clicking the link while Island is
// already open would just spawn a confusing second overlay.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("chattyisland", process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient("chattyisland");
  }
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (win) { win.show(); win.focus(); }
  });
}

function loadLocalData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      if (!d.accounts) d.accounts = {};
      if (d.currentAccount === undefined) d.currentAccount = null;
      return d;
    }
  } catch (e) {}
  return { todos: [], notes: [], funMode: false, confirmedRules: [], accounts: {}, currentAccount: null };
}

function saveLocalData(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

// Everything content-shaped (todos, notes, chat history) lives inside
// data.accounts[email] - one Google account never sees another's.
// Device-level stuff (deviceId, tier/subscription, used codes) stays
// outside this, at the top level, since a subscription is tied to the
// machine, not to which Google account happens to be signed in on it.
function getActiveAccount(data) {
  if (!data.currentAccount) return null;
  if (!data.accounts[data.currentAccount]) {
    data.accounts[data.currentAccount] = { todos: [], notes: [], chatHistory: [], funMode: false, confirmedRules: [] };
  }
  return data.accounts[data.currentAccount];
}

// Island's own Google Sign-In - same "Sign in with Google" button
// approach Inbox already uses (Google Identity Services), not the
// older code-exchange flow. No client secret is needed anywhere in
// this flow, and a Client ID isn't sensitive to begin with - it's
// meant to be public (it sits in plain HTML on every page that uses
// this button), so it's just a constant here instead of a separate
// file to ship, place, and possibly lose track of.
const GOOGLE_CLIENT_ID = "655406863655-7c2vtrulbkemfd34nscr2ddg1mk5dbc4.apps.googleusercontent.com";
const OAUTH_REDIRECT = "http://127.0.0.1:" + BRIDGE_PORT + "/oauth-callback";
// Google's button-rendering check for "Authorized JavaScript origins" is
// pickier than the redirect URI check - localhost works reliably there,
// 127.0.0.1 sometimes doesn't. Server still only binds to 127.0.0.1;
// localhost resolves straight to it, so this is just which address we
// point the browser at, not a different server.
const SIGNIN_PAGE_URL = "http://localhost:" + BRIDGE_PORT + "/signin-page";

let winState = { x: 0, y: 0, width: COLLAPSED.width, height: COLLAPSED.height };

function applyResize(newWidth, newHeight) {
  // Real Dynamic Island always grows DOWNWARD from a fixed top edge -
  // it never re-centers vertically. Preserving vertical center (like
  // horizontal) was what made it visually jump toward the middle of
  // the screen on expand instead of just growing down in place.
  const centerXpt = winState.x + winState.width / 2;
  let newX = Math.round(centerXpt - newWidth / 2);
  let newY = winState.y; // top edge stays put, only grows downward

  const area = screen.getPrimaryDisplay().workAreaSize;
  newX = Math.max(0, Math.min(newX, area.width - newWidth));
  newY = Math.max(0, Math.min(newY, area.height - newHeight));

  winState.x = newX;
  winState.y = newY;
  winState.width = newWidth;
  winState.height = newHeight;
  win.setBounds({ x: winState.x, y: winState.y, width: winState.width, height: winState.height });
}

function centerX(width) {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  return Math.round((screenW - width) / 2);
}

function openJarvis(voiceMode) {
  const url = voiceMode ? JARVIS_URL + "?voice=1" : JARVIS_URL;
  const req = http.get(JARVIS_URL, () => {
    require("electron").shell.openExternal(url);
  });
  req.on("error", () => {
    spawn(process.platform === "win32" ? "python" : "python3", [JARVIS_SCRIPT], {
      cwd: JARVIS_DIR, detached: true, stdio: "ignore",
    }).unref();
    setTimeout(() => require("electron").shell.openExternal(url), 2500);
  });
  req.end();
}

// --- the embedded UI ---------------------------------------------------

function buildHTML() {
  const data = loadLocalData();
  // Even signed out, the compact pill (task count, etc.) runs on its
  // own timer independent of the sign-in gate - it needs todos/notes/
  // funMode to exist as real (empty) values, not be missing entirely,
  // or it throws and the error handler dumps raw error text into the
  // pill itself (with overflow:visible - looks "stretched"/oversized).
  const EMPTY_CONTENT = { todos: [], notes: [], chatHistory: [], funMode: false, confirmedRules: [] };
  const activeView = data.currentAccount
    ? { signedIn: true, email: data.currentAccount, ...EMPTY_CONTENT, ...getActiveAccount(data) }
    : { signedIn: false, ...EMPTY_CONTENT };
  const initialData = JSON.stringify(activeView);
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.4/socket.io.min.js"></script>
<style>
  html, body { margin:0; height:100%; width:100%; background:transparent; overflow:hidden; font-family:-apple-system,"Segoe UI",sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; box-sizing:border-box; }
  #island { width:226px; height:58px; background:rgba(2,2,3,0.95); border:1px solid rgba(255,255,255,0.08); border-radius:10px; display:flex; align-items:center; overflow:hidden; position:relative; cursor:pointer; flex-shrink:0; opacity:0.92; transition:opacity .5s cubic-bezier(.4,0,.2,1), width .45s cubic-bezier(.34,1.56,.64,1), height .45s cubic-bezier(.34,1.56,.64,1), border-radius 1s ease-in-out, box-shadow .4s ease; }
  /* Glow ring states - each maps to something genuinely happening, not decoration: purple=AI thinking, orange=high CPU/RAM warning, red=error, green=task/file completed */
  #island.glow-thinking { box-shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1.5px rgba(168,85,247,.7), 0 0 18px rgba(168,85,247,.5), 0 16px 40px rgba(0,0,0,.7); }
  #island.glow-warning { box-shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1.5px rgba(255,159,10,.7), 0 0 18px rgba(255,159,10,.5), 0 16px 40px rgba(0,0,0,.7); }
  #island.glow-error { box-shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1.5px rgba(255,69,58,.7), 0 0 18px rgba(255,69,58,.5), 0 16px 40px rgba(0,0,0,.7); }
  #island.glow-success { box-shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1.5px rgba(52,199,89,.7), 0 0 18px rgba(52,199,89,.5), 0 16px 40px rgba(0,0,0,.7); }
  #island.glow-thinking, #island.glow-warning, #island.glow-error, #island.glow-success { animation: watery 5s ease-in-out infinite; }
  #island.expanded { animation:none; }
  @keyframes watery {
    0%,100% { border-radius: 10px 10px 10px 10px; }
    20% { border-radius: 16px 9px 14px 11px; }
    40% { border-radius: 9px 15px 10px 16px; }
    60% { border-radius: 14px 10px 17px 9px; }
    80% { border-radius: 11px 16px 9px 14px; }
  }
  /* Ambient "alive" glow - cycles through real, visibly saturated
     hues around the edge while the core stays black/premium. The
     previous hue-rotate filter approach did almost nothing visible
     since it was rotating hue on a near-zero-saturation black
     background - hue rotation needs actual color to rotate. */
  @keyframes ambient-glow {
    0%   { box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1px rgba(91,157,255,.35), 0 0 16px rgba(91,157,255,.3), 0 16px 40px rgba(0,0,0,.7); }
    25%  { box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1px rgba(168,85,247,.35), 0 0 16px rgba(168,85,247,.3), 0 16px 40px rgba(0,0,0,.7); }
    50%  { box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1px rgba(94,234,212,.35), 0 0 16px rgba(94,234,212,.3), 0 16px 40px rgba(0,0,0,.7); }
    75%  { box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1px rgba(244,114,182,.35), 0 0 16px rgba(244,114,182,.3), 0 16px 40px rgba(0,0,0,.7); }
    100% { box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 0 0 1px rgba(91,157,255,.35), 0 0 16px rgba(91,157,255,.3), 0 16px 40px rgba(0,0,0,.7); }
  }
  #island { animation: watery 5s ease-in-out infinite, ambient-glow 12s ease-in-out infinite; }
  #progress-bar { position:absolute; bottom:0; left:0; height:3px; width:0%; background:#34c759; transition:width 1s linear; display:none; }
  #island.awake { opacity:1; }
  #island.expanded { border-radius:16px; width:420px; height:580px; animation:none; }
  #drag-handle { position:absolute; top:0; left:0; width:100%; height:14px; cursor:move; z-index:1; }
  #island.expanded #drag-handle { display:none; }
  #compact-row { display:flex; align-items:center; gap:10px; padding:0 16px; width:100%; }
  .blob { width:13px; height:13px; flex-shrink:0; background:linear-gradient(135deg, #5b9dff, #a855f7); box-shadow:0 0 10px rgba(120,140,255,.7); animation:breathe 2.8s ease-in-out infinite, blob-morph 5s ease-in-out infinite, blob-hue 9s linear infinite; }
  @keyframes blob-morph { 0%,100% { border-radius:50%; } 33% { border-radius:46% 54% 52% 48%/48% 52% 46% 54%; } 66% { border-radius:54% 46% 48% 52%/52% 48% 54% 46%; } }
  @keyframes blob-hue { 0% { filter:hue-rotate(0deg); } 100% { filter:hue-rotate(360deg); } }
  @keyframes rage-shake { 0%,100% { transform:translateX(0); } 20% { transform:translateX(-4px); } 40% { transform:translateX(4px); } 60% { transform:translateX(-3px); } 80% { transform:translateX(3px); } }
  #island.shaking { animation: rage-shake 0.4s ease-in-out; }
  @keyframes alarm-shake { 0%,100% { transform:translateX(0) scale(1); } 10% { transform:translateX(-6px) scale(1.03); } 20% { transform:translateX(6px) scale(1.03); } 30% { transform:translateX(-6px) scale(1.03); } 40% { transform:translateX(6px) scale(1.03); } 50% { transform:translateX(-4px) scale(1.02); } 60% { transform:translateX(4px) scale(1.02); } 70% { transform:translateX(-2px) scale(1.01); } 80% { transform:translateX(2px) scale(1.01); } }
  #island.alarming { animation: alarm-shake 0.6s ease-in-out 2; }
  @keyframes bonk-squish { 0% { transform:scale(1); } 30% { transform:scale(0.82, 1.22); } 55% { transform:scale(1.1, 0.9); } 75% { transform:scale(0.96, 1.04); } 100% { transform:scale(1); } }
  .squish { animation: bonk-squish 0.4s cubic-bezier(.36,.07,.19,.97); }
  .typing-indicator { display: flex; gap: 4px; padding: 10px 12px; }
  .typing-indicator .dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.5); animation: typing-bounce 1.2s ease-in-out infinite; }
  .typing-indicator .dot:nth-child(2) { animation-delay: 0.15s; }
  .typing-indicator .dot:nth-child(3) { animation-delay: 0.3s; }
  @keyframes typing-bounce { 0%,60%,100% { transform: translateY(0); opacity:0.5; } 30% { transform: translateY(-4px); opacity:1; } }
  @keyframes text-glow {
    0%   { text-shadow:0 0 12px rgba(91,157,255,.85), 0 0 4px rgba(91,157,255,.6); }
    25%  { text-shadow:0 0 12px rgba(168,85,247,.85), 0 0 4px rgba(168,85,247,.6); }
    50%  { text-shadow:0 0 12px rgba(94,234,212,.85), 0 0 4px rgba(94,234,212,.6); }
    75%  { text-shadow:0 0 12px rgba(244,114,182,.85), 0 0 4px rgba(244,114,182,.6); }
    100% { text-shadow:0 0 12px rgba(91,157,255,.85), 0 0 4px rgba(91,157,255,.6); }
  }
  #compact-text { animation: text-glow 8s ease-in-out infinite; font-weight: 500; }
  .blob.active { animation:breathe-fast 0.9s ease-in-out infinite, blob-morph 5s ease-in-out infinite, blob-hue 9s linear infinite; background:#7fb8ff; box-shadow:0 0 12px rgba(127,184,255,.9); }
  @keyframes breathe { 0%,100% { transform:scale(1); opacity:0.85; } 50% { transform:scale(1.3); opacity:1; } }
  @keyframes breathe-fast { 0%,100% { transform:scale(1); opacity:0.8; } 50% { transform:scale(1.5); opacity:1; } }
  #compact-text { font-size:14px; color:rgba(255,255,255,.85); white-space:nowrap; overflow:hidden; }
  #expanded-content { display:none; width:100%; height:100%; box-sizing:border-box; opacity:0; transition:opacity .25s .15s; padding:16px; flex-direction:column; }
  #top-bar { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; flex-shrink:0; cursor:move; }
  #top-bar .label { font-size:13px; color:rgba(255,255,255,.55); font-weight:500; }
  #top-bar .controls { display:flex; gap:8px; }
  .icon-btn { width:28px; height:28px; border-radius:8px; background:rgba(255,255,255,.08); display:flex; align-items:center; justify-content:center; cursor:pointer; }
  .icon-btn.listening { background:rgba(255,80,80,.3); animation:pulse 1.4s ease-in-out infinite; }
  #tabs { display:flex; gap:4px; margin-bottom:14px; background:rgba(255,255,255,.06); border-radius:10px; padding:3px; flex-shrink:0; }
  .tab { flex:1; text-align:center; font-size:10px; color:rgba(255,255,255,.55); padding:6px 1px; border-radius:8px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tab.active { background:rgba(255,255,255,.14); color:#fff; }
  .panel { flex:1; overflow-y:auto; display:none; flex-direction:column; min-height:0; }
  .panel.active { display:flex; }
  #chat-log { flex:1; overflow-y:auto; margin-bottom:10px; min-height:0; }
  .msg { font-size:12px; padding:8px 11px; border-radius:10px; margin-bottom:7px; max-width:88%; word-break:break-word; line-height:1.4; }
  .msg.user { background:rgba(102,230,255,.15); color:#fff; margin-left:auto; }
  .msg.ai { background:rgba(255,255,255,.07); color:rgba(255,255,255,.9); }
  .msg.placeholder { color:rgba(255,255,255,.3); text-align:center; padding:30px 0; font-size:12px; }
  .add-row { display:flex; gap:6px; flex-shrink:0; }
  .add-row input { flex:1; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12); border-radius:9px; color:#fff; font-size:12px; padding:9px 10px; outline:none; }
  .add-row button { background:rgba(255,255,255,.12); border:none; border-radius:9px; color:#fff; font-size:12px; padding:9px 13px; cursor:pointer; flex-shrink:0; }
  .list-item { display:flex; align-items:center; gap:9px; font-size:12px; color:rgba(255,255,255,.85); padding:7px 0; border-bottom:1px solid rgba(255,255,255,.06); }
  .list-item i { font-size:14px; cursor:pointer; color:rgba(255,255,255,.35); flex-shrink:0; }
  .list-item .txt { flex:1; word-break:break-word; }
  .chip-row { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:14px; }
  .chip { font-size:12px; color:#fff; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:7px 12px; cursor:pointer; }
  .chip:hover { background:rgba(255,255,255,.16); }
  .empty-hint { color:rgba(255,255,255,.32); font-size:12px; text-align:center; padding:24px 0; }
  @keyframes pulse { 0%,100%{transform:scale(1);opacity:1;} 50%{transform:scale(1.12);opacity:.75;} }
</style></head>
<body>
  <div id="island">
    <div id="sheen"></div>
    <div id="progress-bar"></div>
    <div id="drag-handle"></div>
    <div id="compact-row"><div class="blob"></div><span id="compact-text">All good</span></div>
    <div id="expanded-content">
      <div id="top-bar">
        <span class="label">JARVIS</span>
        <div class="controls">
          <span id="account-chip" style="display:none; font-size:10px; color:rgba(255,255,255,.45); margin-right:6px; cursor:pointer;" onclick="signOutOfGoogle()" title="Click to sign out"></span>
          <div class="icon-btn" id="mic-btn" onclick="toggleMic(event)" style="font-size:14px;color:rgba(255,255,255,.85);">&#127908;</div>
          <div class="icon-btn" onclick="closeIsland(event)" style="font-size:15px;color:rgba(255,255,255,.7);font-weight:bold;">&times;</div>
        </div>
      </div>

      <div id="signin-gate" style="display:none; flex:1; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:20px;">
        <div style="font-size:32px; margin-bottom:10px;">🏝️</div>
        <div style="font-size:14px; font-weight:700; margin-bottom:6px;">Sign in to use Island</div>
        <div style="font-size:11px; color:rgba(255,255,255,.5); margin-bottom:18px; max-width:220px; line-height:1.6;">Your chats, tasks and notes stay tied to your Google account only — nothing is shared with any other account.</div>
        <button onclick="signInWithGoogle()" style="background:linear-gradient(90deg,#ff6b2b,#ff8c42); border:none; color:#fff; font-weight:700; font-size:12px; padding:10px 20px; border-radius:9px; cursor:pointer;">Sign in with Google</button>
        <div id="signin-status" style="font-size:11px; color:rgba(255,255,255,.4); margin-top:10px; min-height:14px;"></div>
      </div>

      <div id="main-app" style="display:none; flex:1; min-height:0; flex-direction:column;">
      <div id="island-banner" style="display:none; font-size:11px; padding:6px 10px; border-radius:8px; margin-bottom:8px; line-height:1.4;"></div>
      <div id="island-personal-msg" style="display:none; font-size:11px; padding:8px 10px; border-radius:8px; margin-bottom:8px; line-height:1.4; background:rgba(139,92,246,0.15); color:#c4a3ff; align-items:center; gap:8px;">
        <span style="font-size:14px;">💌</span>
        <span id="island-personal-msg-text" style="flex:1;"></span>
        <span onclick="dismissPersonalMessage()" style="cursor:pointer; font-weight:700; padding:0 4px;">&times;</span>
      </div>
      <div id="tabs">
        <div class="tab active" data-tab="chat" onclick="switchTab('chat')">Chat</div>
        <div class="tab" data-tab="tasks" onclick="switchTab('tasks')">Tasks</div>
        <div class="tab" data-tab="tools" onclick="switchTab('tools')">Tools</div>
        <div class="tab" data-tab="rules" onclick="switchTab('rules')">Rules</div>
        <div class="tab" data-tab="clip" onclick="switchTab('clip')">Clip</div>
        <div class="tab" data-tab="plan" onclick="switchTab('plan')">Plan</div>
        <div class="tab" data-tab="more" onclick="switchTab('more')">More</div>
      </div>
      <div class="panel active" id="panel-chat">
        <div id="chat-log"><div class="msg placeholder">Type or talk to JARVIS</div></div>
        <div class="add-row"><input id="ai-input" placeholder="Message JARVIS..." oninput="console.log('TYPED, current value:', this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();console.log('ENTER KEY FIRED');askAI();}" onblur="checkCollapseAfterBlur()"><button onclick="console.log('SEND BUTTON CLICKED');askAI();">Send</button></div>
      </div>
      <div class="panel" id="panel-tasks">
        <div class="add-row" style="margin-bottom:10px;"><input id="todo-input" placeholder="Add a task" onkeydown="if(event.key==='Enter')addTodo()" onblur="checkCollapseAfterBlur()"><button onclick="addTodo()">Add</button></div>
        <div id="todo-list" style="flex:1;overflow-y:auto;"></div>
      </div>
      <div class="panel" id="panel-tools">
        <p class="section-title" style="margin-top:0;">Now Playing</p>
        <div id="now-playing-box" style="margin-bottom:16px; font-size:12px; color:rgba(255,255,255,0.5);">Nothing playing</div>
        <div class="chip-row" style="margin-bottom:14px;">
          <div class="chip" onclick="runOsCommand('media-prev')">⏮</div>
          <div class="chip" onclick="runOsCommand('media-play-pause')">⏯</div>
          <div class="chip" onclick="runOsCommand('media-next')">⏭</div>
        </div>

        <p class="section-title">Quick commands</p>
        <div class="chip-row">
          <div class="chip" onclick="runOsCommand('lock-pc')">Lock PC</div>
          <div class="chip" onclick="runOsCommand('sleep-pc')">Sleep</div>
          <div class="chip" onclick="runOsCommand('mute')">Mute</div>
          <div class="chip" onclick="runOsCommand('empty-recycle-bin')">Empty bin</div>
          <div class="chip" onclick="runOsCommand('open-downloads')">Downloads</div>
          <div class="chip" onclick="screenshotAsk()">What's on screen?</div>
          <div class="chip" onclick="previewOrganizeDownloads()">Organize Downloads</div>
          <div class="chip" onclick="sendCommand('check my calendar')">Calendar</div>
        </div>

        <p class="section-title">Find a file by description</p>
        <div class="add-row" style="margin-bottom:8px;">
          <input id="semantic-search-input" placeholder="e.g. blue png from the roblox edit" onkeydown="if(event.key==='Enter')runSemanticSearch()">
          <button onclick="runSemanticSearch()">Find</button>
        </div>
        <div id="semantic-search-results" style="margin-bottom:14px;"></div>

        <p class="section-title">Research</p>
        <div class="add-row" style="margin-bottom:14px;">
          <input id="research-input" placeholder="Search the web..." onkeydown="if(event.key==='Enter')runResearch()">
          <button onclick="runResearch()">Go</button>
        </div>

        <p class="section-title">Timer</p>
        <div class="add-row" style="margin-bottom:8px;">
          <input id="timer-input" placeholder="Minutes" type="number" style="max-width:70px;">
          <button onclick="startTimer()">Start</button>
        </div>
        <div id="timer-display" style="font-size:13px;color:rgba(255,255,255,0.7);margin-bottom:14px;"></div>

        <p class="section-title">Recent actions</p>
        <div id="actions-feed" style="margin-bottom:16px;max-height:130px;overflow-y:auto;"></div>

        <p class="section-title">Dropped files</p>
        <div id="drop-zone" style="border:1.5px dashed rgba(255,255,255,0.18); border-radius:8px; padding:14px; text-align:center; font-size:12px; color:rgba(255,255,255,0.4); margin-bottom:10px;">Drag a file here</div>
        <div id="files-list"></div>
      </div>

      <div class="panel" id="panel-rules">
        <p class="section-title" style="margin-top:0;">New rule</p>
        <div class="add-row" style="margin-bottom:8px;">
          <select id="rule-trigger-type" style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:9px;color:#fff;font-size:12px;padding:7px;">
            <option value="hotkey">Hotkey</option>
            <option value="phrase">Typed phrase</option>
            <option value="startup">On JARVIS startup</option>
          </select>
          <input id="rule-trigger-value" placeholder="e.g. Control+Shift+S, or leave blank for startup">
        </div>
        <div id="rule-steps"></div>
        <div class="chip-row" style="margin-bottom:10px;">
          <div class="chip" onclick="addRuleStep()">+ Add step</div>
        </div>
        <div class="add-row" style="margin-bottom:16px;">
          <input id="rule-name" placeholder="Rule name (e.g. Focus mode)">
          <button onclick="saveNewRule()">Save rule</button>
        </div>

        <p class="section-title">Your rules</p>
        <div id="rules-list"></div>
      </div>

      <div class="panel" id="panel-clip">
        <p class="section-title" style="margin-top:0;">Clipboard history</p>
        <div id="clipboard-history" style="margin-bottom:10px;"></div>
      </div>

      <div class="panel" id="panel-plan">
        <p class="section-title" style="margin-top:0;">Your plan</p>
        <div id="plan-badge" style="display:inline-block; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:700; margin-bottom:10px;">Free</div>
        <div id="plan-usage" style="font-size:11px; color:rgba(255,255,255,0.5); margin-bottom:14px;"></div>
        <div id="plan-pricing" style="font-size:12px; color:rgba(255,255,255,0.7); line-height:1.8; margin-bottom:14px;"></div>
        <p class="section-title">Redeem a code</p>
        <div class="add-row" style="margin-bottom:8px;">
          <input id="plan-code-input" placeholder="e.g. ISL-PRO-XXXXXXXX" onkeydown="if(event.key==='Enter')redeemPlanCode()">
          <button onclick="redeemPlanCode()">Activate</button>
        </div>
        <div id="plan-code-msg" style="font-size:11px; margin-bottom:14px;"></div>
        <p class="section-title">Ask (uses Island's own AI key)</p>
        <div class="add-row" style="margin-bottom:8px;">
          <input id="plan-ask-input" placeholder="Quick question..." onkeydown="if(event.key==='Enter')askIslandPlan()">
          <button onclick="askIslandPlan()">Ask</button>
        </div>
        <div id="plan-ask-answer" style="font-size:12px; color:rgba(255,255,255,0.8); white-space:pre-line;"></div>
      </div>

      <div class="panel" id="panel-more">
        <p class="section-title" style="margin-top:0;">System</p>
        <div id="stats-row" style="font-size:12px; color:rgba(255,255,255,0.8); margin-bottom:10px; display:flex; gap:14px;">Loading...</div>
        <div class="chip-row" style="margin-bottom:8px;"><div class="chip" onclick="runLagHunter()">Lag Hunter</div></div>
        <p class="section-title">Workspace modes</p>
        <div class="chip-row">
          <div class="chip" onclick="sendAction('launch-workspace',{mode:'study'})">Study Mode</div>
          <div class="chip" onclick="sendAction('launch-workspace',{mode:'creator'})">Creator Mode</div>
        </div>
        <div id="lag-hunter-box" style="font-size:11px; color:rgba(255,255,255,0.6); margin-bottom:14px; white-space:pre-line;"></div>
        <div id="foreground-app" style="font-size:11px; color:rgba(255,255,255,0.4); margin-bottom:14px;"></div>

        <p class="section-title">Media</p>
        <div class="chip-row">
          <div class="chip" onclick="runOsCommand('media-play-pause')">Play/Pause</div>
          <div class="chip" onclick="runOsCommand('media-next')">Next</div>
          <div class="chip" onclick="runOsCommand('media-prev')">Previous</div>
          <div class="chip" onclick="runOsCommand('volume-up')">Vol +</div>
          <div class="chip" onclick="runOsCommand('volume-down')">Vol -</div>
        </div>

        <div class="add-row" style="margin-bottom:14px;"><input id="note-input" placeholder="Quick note" onkeydown="if(event.key==='Enter')addNote()" onblur="checkCollapseAfterBlur()"><button onclick="addNote()">Save</button></div>
        <div id="note-list" style="margin-bottom:14px;max-height:120px;overflow-y:auto;"></div>
        <div class="chip-row">
          <div class="chip" onclick="openJarvisAction()">Open JARVIS</div>
          <div class="chip" onclick="sendAction('reopen-last-tab')">Last tab</div>
          <div class="chip" onclick="sendAction('check-spotify')">Open Spotify</div>
          <div class="chip" onclick="sendCommand('check my inbox')">Inbox</div>
          <div class="chip" onclick="runOsCommand('restart-explorer')">Restart Explorer</div>
          <div class="chip" id="fun-mode-chip" onclick="toggleFunMode()">Fun Mode: Off</div>
          <div class="chip" id="startup-chip" onclick="toggleStartup()">Launch on PC startup: Off</div>
        </div>
        <div class="chip-row" id="skills-chips"></div>
      </div>
      </div>
    </div>
  </div>
<script>
window.onerror = function(message, source, lineno, colno, error) {
  console.error('window.onerror caught:', message, 'at line', lineno);
  try {
    fetch('http://127.0.0.1:17345/log-error', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message, lineno, colno, stack: error ? error.stack : null })
    });
  } catch (e) {}
  const el = document.getElementById('compact-text');
  el.textContent = 'ERROR: ' + message + ' (line ' + lineno + ')';
  el.style.whiteSpace = 'normal';
  el.style.overflow = 'visible';
  el.style.wordBreak = 'break-word';
  const isl = document.getElementById('island');
  isl.style.width = '380px';
  isl.style.height = 'auto';
  isl.style.minHeight = '60px';
  isl.style.padding = '12px';
  isl.style.alignItems = 'flex-start';
  isl.style.opacity = '1';
  return true;
};
try {
const JARVIS_URL = "${JARVIS_URL}";
let expanded = false, leaveTimer = null, micOn = false, recognition = null;
let localData = ${initialData};
const island = document.getElementById('island');

// Manual drag implementation - replaces CSS -webkit-app-region:drag
// entirely. That mechanism can have Chromium-side bugs on Windows
// where its draggable-region calculation ends up treating the whole
// window as one giant drag handle, swallowing clicks everywhere even
// on elements explicitly marked no-drag. This sidesteps that category
// of bug completely by tracking mouse movement ourselves and asking
// the main process to move the window, with no native drag region
// involved at all.
function makeDraggable(el, disableWhen) {
  let dragging = false, lastX = 0, lastY = 0;
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.icon-btn')) return; // let button clicks through, don't start a drag
    if (disableWhen && disableWhen()) return;
    dragging = true; lastX = e.screenX; lastY = e.screenY;
    e.preventDefault();
    e.stopPropagation(); // don't let this also trigger an outer drag handler (e.g. drag-handle is inside island - without this, both would fire for the same mouse movement and compound/desync)
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastX, dy = e.screenY - lastY;
    lastX = e.screenX; lastY = e.screenY;
    sendAction('move-window', { dx, dy });
  });
  window.addEventListener('mouseup', () => { dragging = false; });
}
makeDraggable(document.getElementById('drag-handle'));
makeDraggable(document.getElementById('top-bar'));
makeDraggable(island, () => expanded); // whole pill draggable, but disabled while expanded so it doesn't fight with buttons inside
const compactText = document.getElementById('compact-text');

// Talks back to the Electron main process via a tiny local HTTP
// server (started in main.js) instead of preload/contextBridge or a
// navigation trick - fetch() is just a normal network request, so it
// doesn't hit Chromium's restriction on navigating away from a data:
// URL, which is what was silently breaking the previous version.
function sendAction(action, payload) {
  console.log('sendAction called:', action, payload ? JSON.stringify(payload).slice(0,80) : '');
  fetch('http://127.0.0.1:${BRIDGE_PORT}/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Island-Token': '${BRIDGE_TOKEN}' },
    body: payload !== undefined ? JSON.stringify(payload) : '{}',
  }).catch(() => {});
}

async function fetchAction(action, payload) {
  try {
    const res = await fetch('http://127.0.0.1:${BRIDGE_PORT}/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Island-Token': '${BRIDGE_TOKEN}' },
      body: payload !== undefined ? JSON.stringify(payload) : '{}',
    });
    return await res.json();
  } catch (e) {
    return null;
  }
}

island.addEventListener('mouseenter', () => {
  clearTimeout(leaveTimer);
  sendAction('set-click-through', { ignore: false });
  island.classList.add('awake');
  setExpanded(true);
});
island.addEventListener('mouseleave', () => {
  leaveTimer = setTimeout(() => {
    const active = document.activeElement;
    const stillTyping = active && active.tagName === 'INPUT' && island.contains(active);
    if (stillTyping) return; // don't collapse out from under someone mid-typing
    setExpanded(false);
    island.classList.remove('awake');
    sendAction('set-click-through', { ignore: true });
  }, 220);
});

function renderLists() {
  const todoList = document.getElementById('todo-list');
  todoList.innerHTML = '';
  localData.todos.forEach((t,i) => {
    const row = document.createElement('div'); row.className = 'list-item';
    row.innerHTML = '<span onclick="toggleTodo('+i+')" style="cursor:pointer;font-size:15px;color:rgba(255,255,255,.5);">'+(t.done?'\u2611':'\u2610')+'</span><span class="txt" style="'+(t.done?'text-decoration:line-through;opacity:.5':'')+'">'+t.text+'</span><span onclick="removeTodo('+i+')" style="cursor:pointer;font-size:15px;color:rgba(255,255,255,.4);font-weight:bold;">&times;</span>';
    todoList.appendChild(row);
  });
  if (!localData.todos.length) todoList.innerHTML = '<div class="empty-hint">Nothing on the list</div>';

  const noteList = document.getElementById('note-list');
  noteList.innerHTML = '';
  localData.notes.forEach((n,i) => {
    const row = document.createElement('div'); row.className = 'list-item';
    row.innerHTML = '<span class="txt">'+n+'</span><span onclick="removeNote('+i+')" style="cursor:pointer;font-size:15px;color:rgba(255,255,255,.4);font-weight:bold;">&times;</span>';
    noteList.appendChild(row);
  });
  if (!localData.notes.length) noteList.innerHTML = '<div class="empty-hint">No notes yet</div>';

  const count = localData.todos.filter(t => !t.done).length;
  if (!liveActivity) updateCompactLabel(count);
}

// Anything actively happening (timer counting down, a command running,
// AI thinking) sets this, so it's visible from OUTSIDE the pill - the
// whole point of a Dynamic-Island-style indicator, not just a static
// task counter that only updates when nothing else is going on.
let liveActivity = null;

function updateCompactLabel(taskCountOverride) {
  const blobEl = document.querySelector('.blob');
  if (expanded) return;
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (liveActivity) {
    compactText.textContent = liveActivity + '  ·  ' + timeStr;
    if (blobEl) blobEl.classList.add('active');
    return;
  }
  if (blobEl) blobEl.classList.remove('active');
  const count = taskCountOverride !== undefined ? taskCountOverride : (localData.todos || []).filter(t => !t.done).length;
  const status = count > 0 ? count + ' task' + (count > 1 ? 's' : '') : 'All good';
  compactText.textContent = status + '  ·  ' + timeStr;
}

let hasActivityWidth = false;
function setCompactWidth(active) {
  if (active === hasActivityWidth) return;
  hasActivityWidth = active;
  if (expanded) return;
  island.style.width = active ? ACTIVE_WIDTH + 'px' : '';
}

function setLiveActivity(text, durationMs, glow) {
  liveActivity = text;
  updateCompactLabel();
  setCompactWidth(true);
  island.classList.add('awake');
  setGlow(glow);
  if (durationMs) {
    setTimeout(() => {
      if (liveActivity === text) {
        liveActivity = null;
        updateCompactLabel();
        setCompactWidth(false);
        if (!expanded) island.classList.remove('awake');
        setGlow(null);
      }
    }, durationMs);
  }
}
function setGlow(type) {
  island.classList.remove('glow-thinking', 'glow-warning', 'glow-error', 'glow-success');
  if (type) island.classList.add('glow-' + type);
  if (type === 'error' && localData.funMode) {
    island.classList.add('shaking');
    setTimeout(() => island.classList.remove('shaking'), 400);
  }
}
function persist() {
  if (!localData.signedIn) return; // nothing to attach unsaved data to
  const { signedIn, email, ...contentOnly } = localData;
  sendAction('save-data', contentOnly);
}

function toggleFunMode() {
  localData.funMode = !localData.funMode;
  persist();
  document.getElementById('fun-mode-chip').textContent = 'Fun Mode: ' + (localData.funMode ? 'On' : 'Off');
}

async function refreshStartupChip() {
  const status = await fetchAction('get-startup-status');
  const chip = document.getElementById('startup-chip');
  if (chip) chip.textContent = 'Launch on PC startup: ' + (status && status.enabled ? 'On' : 'Off');
}

async function toggleStartup() {
  const chip = document.getElementById('startup-chip');
  const current = await fetchAction('get-startup-status');
  const next = !(current && current.enabled);
  const result = await fetchAction('set-startup', { enabled: next });
  chip.textContent = 'Launch on PC startup: ' + (result && result.enabled ? 'On' : 'Off');
}
window.toggleStartup = toggleStartup;

const FUN_THINKING_MESSAGES = [
  'pretending to be smart...',
  'bribing the CPU...',
  'asking the GPU nicely...',
  'consulting ancient code...',
  'thinking really hard...',
];
function thinkingMessage() {
  if (!localData.funMode) return 'JARVIS is thinking...';
  return FUN_THINKING_MESSAGES[Math.floor(Math.random() * FUN_THINKING_MESSAGES.length)];
}

// Bonk-squish feedback on any button/chip click when Fun Mode is on -
// small physical-feeling acknowledgment, not tied to "valid/invalid"
// since that's hard to detect generically, just a satisfying click cue
document.addEventListener('click', (e) => {
  if (!localData.funMode) return;
  const target = e.target.closest('.chip, button, .icon-btn, .tab');
  if (target) {
    target.classList.add('squish');
    setTimeout(() => target.classList.remove('squish'), 400);
  }
});
function addTodo() { const i=document.getElementById('todo-input'); const t=i.value.trim(); if(!t)return; localData.todos.push({text:t,done:false}); i.value=''; persist(); renderLists(); }
function toggleTodo(i) { localData.todos[i].done = !localData.todos[i].done; persist(); renderLists(); }
function removeTodo(i) {
  const removed = localData.todos[i];
  localData.todos.splice(i,1); persist(); renderLists();
  logAction('Deleted task: "' + removed.text + '"', () => {
    localData.todos.push(removed); persist(); renderLists();
  });
}
function addNote() { const i=document.getElementById('note-input'); const t=i.value.trim(); if(!t)return; localData.notes.unshift(t); i.value=''; persist(); renderLists(); }
function removeNote(i) {
  const removed = localData.notes[i];
  localData.notes.splice(i,1); persist(); renderLists();
  logAction('Deleted note: "' + (removed.length > 40 ? removed.slice(0,40)+'...' : removed) + '"', () => {
    localData.notes.unshift(removed); persist(); renderLists();
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id==='panel-'+name));
  if (name === 'more') { loadSkills(); refreshStats(); refreshForegroundApp(); refreshStartupChip(); }
  if (name === 'clip') { renderClipboardHistory(); }
  if (name === 'rules') { renderRulesList(); }
  if (name === 'plan') { loadPlanStatus(); }
}

const TIER_COLORS = { free: 'rgba(255,255,255,0.12)', pro: 'rgba(59,130,246,0.25)', premium: 'rgba(139,92,246,0.25)' };
const TIER_TEXT_COLORS = { free: 'rgba(255,255,255,0.6)', pro: '#7fb8ff', premium: '#c4a3ff' };

async function loadPlanStatus() {
  const status = await fetchAction('get-island-status');
  if (!status) return;

  // Banner
  const banner = document.getElementById('island-banner');
  if (status.announcement && status.announcement.text) {
    const colors = { info: ['rgba(59,130,246,0.15)', '#7fb8ff'], success: ['rgba(34,197,94,0.15)', '#86efac'], warning: ['rgba(255,159,10,0.15)', '#ffcc80'] };
    const c = colors[status.announcement.type] || colors.info;
    banner.style.background = c[0];
    banner.style.color = c[1];
    banner.textContent = status.announcement.text;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }

  if (status.banned) {
    document.getElementById('plan-badge').textContent = 'Banned';
    document.getElementById('plan-badge').style.background = 'rgba(239,68,68,0.25)';
    document.getElementById('plan-badge').style.color = '#fca5a5';
    document.getElementById('plan-usage').textContent = 'This device has been suspended.';
    return;
  }

  const tier = status.tier || 'free';
  const badge = document.getElementById('plan-badge');
  badge.textContent = tier === 'premium' ? 'Premium' : tier === 'pro' ? 'Pro' : 'Free';
  badge.style.background = TIER_COLORS[tier];
  badge.style.color = TIER_TEXT_COLORS[tier];

  const limit = status.effectiveLimit || (tier === 'premium' ? status.premiumLimit : tier === 'pro' ? status.proLimit : status.freeLimit);
  const unlimited = limit >= 99999;
  document.getElementById('plan-usage').textContent = unlimited
    ? status.usedToday + ' asks used today'
    : status.usedToday + ' / ' + limit + ' asks today';
  if (status.tierExpiry) {
    document.getElementById('plan-usage').textContent += ' · active until ' + new Date(status.tierExpiry).toLocaleDateString();
  }

  showPersonalMessage(status.personalMessage);

  document.getElementById('plan-pricing').innerHTML =
    'Pro: Rs' + status.proPrice + '/month · Premium: Rs' + status.premiumPrice + '/month<br>Get a code the same way you would for ChattyCHOP Inbox.';
}

let currentPersonalMessage = null;
function showPersonalMessage(text) {
  const box = document.getElementById('island-personal-msg');
  currentPersonalMessage = text || null;
  if (!text) { box.style.display = 'none'; return; }
  document.getElementById('island-personal-msg-text').textContent = text;
  box.style.display = 'flex';
}
function dismissPersonalMessage() {
  if (!currentPersonalMessage) return;
  fetchAction('dismiss-island-message', { message: currentPersonalMessage });
  document.getElementById('island-personal-msg').style.display = 'none';
  currentPersonalMessage = null;
}

async function redeemPlanCode() {
  const input = document.getElementById('plan-code-input');
  const code = input.value.trim();
  const msgEl = document.getElementById('plan-code-msg');
  if (!code) return;
  msgEl.style.color = 'rgba(255,255,255,0.5)';
  msgEl.textContent = 'Checking...';
  const result = await fetchAction('redeem-island-code', { code });
  if (!result) { msgEl.textContent = 'Something went wrong.'; msgEl.style.color = '#fca5a5'; return; }
  msgEl.textContent = result.msg;
  msgEl.style.color = result.ok ? '#86efac' : '#fca5a5';
  if (result.ok) { input.value = ''; loadPlanStatus(); }
}

async function askIslandPlan() {
  const input = document.getElementById('plan-ask-input');
  const prompt = input.value.trim();
  const answerEl = document.getElementById('plan-ask-answer');
  if (!prompt) return;
  answerEl.textContent = 'Thinking...';
  const result = await fetchAction('island-ask', { prompt });
  answerEl.textContent = (result && (result.answer || result.error)) || 'No response';
  input.value = '';
  loadPlanStatus(); // refresh usage count
}

async function runLagHunter() {
  const box = document.getElementById('lag-hunter-box');
  box.textContent = 'Checking...';
  const list = await fetchAction('lag-hunter');
  if (!list) { box.textContent = 'Could not check processes.'; return; }
  box.textContent = list.map(p => p.Name + ' — ' + p.MB + ' MB').join('\\n');
}

async function refreshStats() {
  const row = document.getElementById('stats-row');
  const stats = await fetchAction('get-stats');
  if (!stats) { row.textContent = 'Stats unavailable'; return; }
  const parts = ['CPU ' + stats.cpu + '%', 'RAM ' + stats.ram + '%'];
  if (stats.battery !== null && stats.battery !== undefined) parts.push('Battery ' + stats.battery + '%');
  row.textContent = parts.join('   ');
}

async function refreshForegroundApp() {
  const el = document.getElementById('foreground-app');
  const result = await fetchAction('get-foreground-app');
  el.textContent = result && result.app ? 'Active app: ' + result.app : '';
}

function runOsCommand(name) {
  sendAction('os-command', { name });
  appendMsg('ai', 'Running: ' + name.replace(/-/g, ' '));
  setLiveActivity(name.replace(/-/g, ' '), 3000);
  logAction('Ran: ' + name.replace(/-/g, ' '), null);
}

async function runSemanticSearch() {
  const input = document.getElementById('semantic-search-input');
  const query = input.value.trim();
  if (!query) return;
  const resultsBox = document.getElementById('semantic-search-results');
  resultsBox.textContent = 'Scanning Desktop, Downloads, Documents, Pictures...';
  liveActivity = 'Searching files...';
  updateCompactLabel();

  const scan = await fetchAction('scan-files-for-search');
  if (!scan || !scan.files || !scan.files.length) {
    resultsBox.textContent = 'No files found to search.';
    liveActivity = null; updateCompactLabel();
    return;
  }

  resultsBox.textContent = 'Asking JARVIS to think about ' + scan.files.length + ' files...';
  const fileListText = scan.files.map(f => f.name + ' (modified ' + f.modified + ', ' + f.sizeKB + 'KB) — ' + f.path).join('\\n');
  const prompt = 'I am looking for a file matching this description: "' + query + '". ' +
    'Here is a list of files on my computer (name, modified date, size, full path). ' +
    'Based on filename and metadata only (you cannot see file contents), list the 3 most likely matches as a numbered list with their full path. ' +
    'If nothing looks like a plausible match, say so plainly instead of guessing.\\n\\n' + fileListText;

  try {
    const data = await fetchAction('island-ask', { prompt });
    resultsBox.textContent = (data && (data.answer || data.error)) || 'No response';
  } catch (e) {
    resultsBox.textContent = 'Something went wrong asking Island\\'s AI — check the API key is set in admin.';
  }
  liveActivity = null; updateCompactLabel();
}

function runResearch() {
  const input = document.getElementById('research-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  switchTab('chat');
  // "find" is one of JARVIS's real search-trigger keywords - this
  // guarantees the query actually goes through its existing Tavily
  // web search instead of relying on the AI guessing it should search.
  sendCommand('find ' + q);
}

async function screenshotAsk() {
  switchTab('chat');
  appendMsg('user', "What's on my screen?");
  liveActivity = 'Capturing screen...';
  updateCompactLabel();
  const shot = await fetchAction('capture-screenshot');
  if (!shot || shot.error) {
    appendMsg('ai', 'Screenshot failed: ' + (shot ? shot.error : 'unknown error')); setLiveActivity('Screenshot failed', 5000, 'error');
    liveActivity = null; updateCompactLabel();
    return;
  }
  liveActivity = thinkingMessage();
  showTypingIndicator();
  setGlow('thinking');
  updateCompactLabel();
  const thinkStart = Date.now();
  try {
    const res = await fetch(JARVIS_URL + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: "What's on my screen right now? Describe it.", image: { data: shot.data, mimeType: shot.mimeType } })
    });
    const data = await res.json();
    await withMinThinkingTime(thinkStart, 700); removeTypingIndicator();
    appendMsg('ai', data.response || data.error || 'No response');
  } catch (e) {
    await withMinThinkingTime(thinkStart, 700); removeTypingIndicator();
    appendMsg('ai', 'JARVIS not running.');
  }
  liveActivity = null;
  setGlow(null);
  updateCompactLabel();
}

async function previewOrganizeDownloads() {
  switchTab('chat');
  const preview = await fetchAction('preview-organize-downloads');
  if (!preview || preview.error) { appendMsg('ai', 'Could not read Downloads folder.'); return; }
  const c = preview.categories;
  const summary = 'Found in Downloads: ' + c.images + ' images, ' + c.documents + ' documents, ' + c.videos + ' videos, ' + c.archives + ' archives, ' + c.other + ' other (' + preview.total + ' total).';
  appendMsg('ai', summary);
  const log = document.getElementById('chat-log');
  const confirmRow = document.createElement('div');
  confirmRow.className = 'msg ai';
  confirmRow.innerHTML = 'Move these into subfolders? Nothing gets deleted, only moved. <span style="text-decoration:underline;cursor:pointer;" onclick="confirmOrganizeDownloads()">Yes, organize them</span>';
  log.appendChild(confirmRow);
  log.scrollTop = log.scrollHeight;
}

async function confirmOrganizeDownloads() {
  liveActivity = 'Organizing Downloads...';
  updateCompactLabel();
  const result = await fetchAction('organize-downloads');
  liveActivity = null;
  updateCompactLabel();
  if (!result || result.error) { appendMsg('ai', 'Organize failed: ' + (result ? result.error : 'unknown')); setLiveActivity('Organize failed', 5000, 'error'); return; }
  appendMsg('ai', 'Moved ' + result.moved + ' files into category folders' + (result.skipped ? (', skipped ' + result.skipped + ' (already existed)') : '') + '.');
  setLiveActivity('Moved ' + result.moved + ' files', 5000, 'success');
}

// Recent actions feed - only logs things the Island/JARVIS itself
// does (since we already know about those), never watches the OS
// for actions we didn't initiate. Undo is only offered where it's
// genuinely safe and reversible (notes/todos) - OS commands and file
// operations show in the feed for visibility but aren't undoable,
// said plainly rather than faking a button that wouldn't really work.
let actionsFeed = [];
function logAction(description, undoFn) {
  actionsFeed.unshift({ time: Date.now(), description, undoFn });
  if (actionsFeed.length > 20) actionsFeed.pop();
  renderActionsFeed();
}
function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  return Math.floor(min / 60) + 'h ago';
}
function renderActionsFeed() {
  const container = document.getElementById('actions-feed');
  if (!container) return;
  container.innerHTML = '';
  if (!actionsFeed.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = 'Nothing yet';
    container.appendChild(empty);
    return;
  }
  actionsFeed.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = entry.description + '  ·  ' + timeAgo(entry.time);
    row.appendChild(txt);
    if (entry.undoFn) {
      const undoBtn = document.createElement('span');
      undoBtn.textContent = '↩ undo';
      undoBtn.style.cursor = 'pointer';
      undoBtn.style.color = 'rgba(255,255,255,0.5)';
      undoBtn.addEventListener('click', () => {
        entry.undoFn();
        actionsFeed.splice(i, 1);
        renderActionsFeed();
      });
      row.appendChild(undoBtn);
    }
    container.appendChild(row);
  });
}
setInterval(renderActionsFeed, 15000); // keep "X mins ago" text fresh

let timerInterval = null;
function startTimer() {
  const input = document.getElementById('timer-input');
  const minutes = parseFloat(input.value);
  if (!minutes || minutes <= 0) return;
  const totalSeconds = Math.round(minutes * 60);
  let secondsLeft = totalSeconds;
  if (timerInterval) clearInterval(timerInterval);
  const display = document.getElementById('timer-display');
  const bar = document.getElementById('progress-bar');
  bar.style.transition = 'none'; // snap to 0% instantly instead of visibly animating from leftover width
  bar.style.width = '0%';
  bar.style.background = '#34c759';
  bar.style.display = 'block';
  requestAnimationFrame(() => { bar.style.transition = 'width 1s linear'; });
  const tick = () => {
    const m = Math.floor(secondsLeft / 60), s = secondsLeft % 60;
    const text = m + ':' + (s < 10 ? '0' : '') + s;
    display.textContent = text + ' remaining';
    liveActivity = text;
    updateCompactLabel();
    const percentDone = ((totalSeconds - secondsLeft) / totalSeconds) * 100;
    bar.style.width = percentDone + '%';
    if (secondsLeft <= 0) {
      clearInterval(timerInterval);
      display.textContent = "Time's up!";
      island.classList.add('alarming');
      setTimeout(() => island.classList.remove('alarming'), 1300);
      setLiveActivity("Timer done", 8000, "success");
      setTimeout(() => { bar.style.display = 'none'; bar.style.width = '0%'; }, 8000);
      return;
    }
    secondsLeft--;
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

let expandGeneration = 0;
function setExpanded(v) {
  if (expanded === v) return;
  expanded = v;
  island.style.transform = '';
  const myGeneration = ++expandGeneration;
  const cr = document.getElementById('compact-row'), ec = document.getElementById('expanded-content');
  if (v) {
    sendAction('resize-expanded'); // grow the window FIRST so it's never smaller than the content
    island.classList.add('expanded'); cr.style.display='none'; ec.style.display='flex';
    requestAnimationFrame(() => ec.style.opacity='1');
  } else {
    island.classList.remove('expanded'); ec.style.opacity='0'; // shrink content visually first
    setTimeout(() => {
      if (myGeneration !== expandGeneration) return; // a newer expand/collapse happened since this was scheduled - don't apply this stale one
      ec.style.display='none'; cr.style.display='flex';
      sendAction('resize-collapsed'); // only shrink the window AFTER the visual shrink finishes
      renderLists();
    }, 400);
  }
}

function checkCollapseAfterBlur() {
  setTimeout(() => {
    if (!island.matches(':hover')) {
      setExpanded(false);
      island.classList.remove('awake');
    }
  }, 100);
}

(function animateSheen() {
  const sheen = document.getElementById('sheen');
  let x = -40, dir = 1;
  setInterval(() => {
    x += dir * 0.4;
    if (x > 130) dir = -1;
    if (x < -40) dir = 1;
    sheen.style.left = x + '%';
  }, 30);
})();

function appendMsg(role, text, skipPersist) {
  const log = document.getElementById('chat-log');
  const ph = log.querySelector('.placeholder'); if (ph) ph.remove();
  const m = document.createElement('div'); m.className = 'msg ' + role; m.textContent = text;
  log.appendChild(m); log.scrollTop = log.scrollHeight;
  if (!skipPersist && localData.signedIn) {
    if (!localData.chatHistory) localData.chatHistory = [];
    localData.chatHistory.push({ role, text, ts: Date.now() });
    if (localData.chatHistory.length > 200) localData.chatHistory = localData.chatHistory.slice(-200);
    persist();
  }
}

function showTypingIndicator() {
  const log = document.getElementById('chat-log');
  const ph = log.querySelector('.placeholder'); if (ph) ph.remove();
  const m = document.createElement('div');
  m.className = 'msg ai typing-indicator';
  m.id = 'typing-indicator';
  m.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  log.appendChild(m);
  log.scrollTop = log.scrollHeight;
}
function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

async function loadSkills() {
  const c = document.getElementById('skills-chips');
  try {
    const res = await fetch(JARVIS_URL + '/api/skills');
    const skills = await res.json();
    c.innerHTML = '';
    skills.slice(0,6).forEach(s => {
      const chip = document.createElement('div'); chip.className='chip'; chip.textContent=s.name;
      chip.onclick = () => runSkill(s.name); c.appendChild(chip);
    });
    if (!skills.length) c.innerHTML = '<span style="font-size:11px;color:rgba(255,255,255,.4)">No skills saved yet</span>';
  } catch(e) { c.innerHTML = '<span style="font-size:11px;color:rgba(255,255,255,.4)">JARVIS not running</span>'; }
}
async function runSkill(name) {
  try { await fetch(JARVIS_URL+'/api/skills/'+encodeURIComponent(name)+'/run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); appendMsg('ai','Ran skill: '+name); } catch(e){}
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function withMinThinkingTime(startTime, minMs) {
  const elapsed = Date.now() - startTime;
  if (elapsed < minMs) await sleep(minMs - elapsed);
}

async function sendCommand(text) {
  appendMsg('user', text); switchTab('chat');
  liveActivity = thinkingMessage();
  showTypingIndicator();
  setGlow('thinking');
  updateCompactLabel();
  const thinkStart = Date.now();
  try {
    const data = await fetchAction('island-ask', { prompt: text });
    await withMinThinkingTime(thinkStart, 700); removeTypingIndicator();
    appendMsg('ai', (data && (data.answer || data.error)) || 'No response');
  } catch(e) { await withMinThinkingTime(thinkStart, 700); removeTypingIndicator(); appendMsg('ai','Something went wrong asking Island\\'s AI.'); }
  liveActivity = null;
  setGlow(null);
  updateCompactLabel();
}
async function askAI(spoken, speak) {
  console.log('askAI called, text input value:', document.getElementById('ai-input') ? document.getElementById('ai-input').value : 'INPUT NOT FOUND');
  const input = document.getElementById('ai-input');
  const text = spoken || input.value.trim();
  if (!text) return;
  if (checkPhraseRule(text)) {
    if (!spoken) input.value = '';
    return;
  }
  appendMsg('user', text);
  if (!spoken) input.value = '';
  liveActivity = thinkingMessage();
  showTypingIndicator();
  setGlow('thinking');
  updateCompactLabel();
  const thinkStart = Date.now();
  try {
    // Island's own AI key (set in admin, pulled live from JSONBin) -
    // no dependency on JARVIS.py's Flask server anymore.
    const data = await fetchAction('island-ask', { prompt: text });
    const reply = (data && (data.answer || data.error)) || 'No response';
    await withMinThinkingTime(thinkStart, 700); removeTypingIndicator();
    appendMsg('ai', reply);
    if (speak && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(reply));
  } catch(e) { await withMinThinkingTime(thinkStart, 700); removeTypingIndicator(); appendMsg('ai','Something went wrong asking Island\\'s AI — check the API key is set in admin.'); }
  liveActivity = null;
  setGlow(null);
  updateCompactLabel();
}

// async function declarations don't get the legacy "Annex B" rule that
// lets plain functions inside a block still attach to window - that
// rule explicitly excludes async functions by spec. Without this, all
// four below stayed trapped inside the outer try{} block and were
// invisible to onclick="" attributes, which look functions up globally.
// This is the actual root cause of "askAI is not defined".
window.loadSkills = loadSkills;
window.executeRuleById = executeRuleById;
window.saveNewRule = saveNewRule;
window.renderRulesList = renderRulesList;
window.runSkill = runSkill;
window.sendCommand = sendCommand;
window.askAI = askAI;

function toggleMic(e) {
  e.stopPropagation();
  // Electron's bundled Chromium typically lacks the Google speech
  // backend real Chrome ships with, so SpeechRecognition here was
  // unreliable/non-functional. Instead, this opens your actual JARVIS
  // page (running in real Chrome, where voice already works) and
  // auto-starts its existing Convo Mode.
  appendMsg('ai', 'Opening voice mode in JARVIS...');
  sendAction('open-jarvis-voice');
}

function openJarvisAction() { sendAction('open-jarvis'); }
function closeIsland(e) { e.stopPropagation(); sendAction('close-island'); }

try {
  const socket = io(JARVIS_URL, { reconnection: true, timeout: 2000 });
  socket.on('jarvis_notification', (d) => {
    const clean = d.text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    compactText.textContent = clean; island.classList.add('awake');
    setTimeout(() => { if (!expanded) { renderLists(); island.classList.remove('awake'); } }, 6000);
  });
} catch(e) {}

// Clipboard intelligence - polls for changes, offers quick actions on
// new text (summarize via JARVIS, or save straight to notes)
let lastClipboard = '';
let clipboardHistory = [];
let droppedFiles = [];

async function pollClipboard() {
  const result = await fetchAction('get-clipboard');
  if (!result) console.log('Clipboard poll: fetchAction returned null - bridge call failed');
  else console.log('Clipboard poll: got text of length', result.text ? result.text.length : 0);
  if (result && result.text && result.text !== lastClipboard && result.text.trim().length > 15) {
    lastClipboard = result.text;
    clipboardHistory.unshift(result.text);
    if (clipboardHistory.length > 15) clipboardHistory.pop();
    offerClipboardActions(result.text);
  }
  setTimeout(pollClipboard, 2000);
}

function offerClipboardActions(text) {
  setLiveActivity('Clipboard ready', 5000);
  if (!expanded) return; // don't interrupt while collapsed
  switchTab('chat'); // was requiring chat to already be active - meant it never showed if you were on another tab
  const preview = text.length > 60 ? text.slice(0, 60) + '...' : text;
  const log = document.getElementById('chat-log');
  const ph = log.querySelector('.placeholder'); if (ph) ph.remove();
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.innerHTML = 'Copied: "' + preview + '"<br><span style="text-decoration:underline;cursor:pointer;" onclick="summarizeClipboard()">Summarize</span> &nbsp; <span style="text-decoration:underline;cursor:pointer;" onclick="saveClipboardAsNote()">Save as note</span>';
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

// --- Rules engine -------------------------------------------------------
// User-defined automation only. No watching, no learned habits - you
// set the trigger and the chain, you can see and edit every rule.
let pendingRuleSteps = [];
let cachedRules = [];
let confirmedRuleIds = localData.confirmedRules || []; // persisted, so confirmation genuinely only happens once ever, not once per app restart

function addRuleStep() {
  const container = document.getElementById('rule-steps');
  const row = document.createElement('div');
  row.className = 'add-row';
  row.style.marginBottom = '6px';
  const typeSelect = document.createElement('select');
  typeSelect.style.background = 'rgba(255,255,255,0.07)';
  typeSelect.style.border = '1px solid rgba(255,255,255,0.12)';
  typeSelect.style.borderRadius = '9px';
  typeSelect.style.color = '#fff';
  typeSelect.style.fontSize = '12px';
  typeSelect.style.padding = '7px';
  ['open-url', 'os-command', 'run-skill', 'chat', 'note'].forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v === 'open-url' ? 'Open URL' : v === 'os-command' ? 'OS command' : v === 'run-skill' ? 'Run skill' : v === 'chat' ? 'Send to JARVIS' : 'Save note';
    typeSelect.appendChild(opt);
  });
  const valueInput = document.createElement('input');
  valueInput.placeholder = 'e.g. claude.com, or lock-pc, or skill name, or message';
  row.appendChild(typeSelect);
  row.appendChild(valueInput);
  container.appendChild(row);
  pendingRuleSteps.push({ typeEl: typeSelect, valueEl: valueInput });
}

async function saveNewRule() {
  const triggerType = document.getElementById('rule-trigger-type').value;
  const triggerValue = document.getElementById('rule-trigger-value').value.trim();
  const name = document.getElementById('rule-name').value.trim();
  if ((!triggerValue && triggerType !== 'startup') || !name || pendingRuleSteps.length === 0) {
    appendMsg('ai', 'Need a trigger (unless using "On JARVIS startup"), a name, and at least one step to save a rule.');
    return;
  }
  const actions = pendingRuleSteps.map((s) => ({ type: s.typeEl.value, value: s.valueEl.value.trim() }));
  const rule = { name, trigger: { type: triggerType, value: triggerValue }, actions };
  const result = await fetchAction('save-rule', rule);
  if (result && result.ok) {
    appendMsg('ai', 'Saved rule "' + name + '".');
    document.getElementById('rule-trigger-value').value = '';
    document.getElementById('rule-name').value = '';
    document.getElementById('rule-steps').innerHTML = '';
    pendingRuleSteps = [];
    renderRulesList();
  }
}

async function renderRulesList() {
  cachedRules = await fetchAction('get-rules') || [];
  const list = document.getElementById('rules-list');
  list.innerHTML = '';
  if (!cachedRules.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = 'No rules yet';
    list.appendChild(empty);
    return;
  }
  cachedRules.forEach((rule) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.style.alignItems = 'flex-start';
    const txt = document.createElement('span');
    txt.className = 'txt';
    const triggerDesc = rule.trigger.type === 'startup' ? '[on startup]' : rule.trigger.type === 'hotkey' ? '[' + rule.trigger.value + ']' : '"' + rule.trigger.value + '"';
    const stepsDesc = rule.actions.map((a) => a.type + ': ' + a.value).join(' → ');
    txt.textContent = rule.name + '  ' + triggerDesc + '  →  ' + stepsDesc;
    const delBtn = document.createElement('span');
    delBtn.textContent = '×';
    delBtn.style.cursor = 'pointer';
    delBtn.style.color = 'rgba(255,255,255,0.4)';
    delBtn.addEventListener('click', async () => {
      await fetchAction('delete-rule', { id: rule.id });
      renderRulesList();
    });
    row.appendChild(txt);
    row.appendChild(delBtn);
    list.appendChild(row);
  });
}

async function executeRuleById(id) {
  const rule = cachedRules.find((r) => r.id === id) || (await fetchAction('get-rules') || []).find((r) => r.id === id);
  if (!rule) return;
  if (!confirmedRuleIds.includes(id)) {
    switchTab('chat');
    const stepsDesc = rule.actions.map((a) => a.type + ': ' + a.value).join(' → ');
    const log = document.getElementById('chat-log');
    const wrap = document.createElement('div');
    wrap.className = 'msg ai';
    wrap.innerHTML = 'First time running "' + rule.name + '": ' + stepsDesc + '. <span style="text-decoration:underline;cursor:pointer;" id="confirm-rule-' + id + '">Run it</span>';
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    document.getElementById('confirm-rule-' + id).addEventListener('click', () => {
      confirmedRuleIds.push(id);
      localData.confirmedRules = confirmedRuleIds;
      persist();
      runRuleActions(rule);
    });
    return;
  }
  runRuleActions(rule);
}

async function runRuleActions(rule) {
  appendMsg('ai', 'Running "' + rule.name + '"...');
  logAction('Ran rule: ' + rule.name, null);
  for (const step of rule.actions) {
    if (step.type === 'os-command' || step.type === 'run-skill' || step.type === 'open-url') {
      await fetchAction('run-rule-action', step);
    } else if (step.type === 'chat') {
      await sendCommand(step.value);
    } else if (step.type === 'note') {
      localData.notes.unshift(step.value);
      persist();
      renderLists();
    }
  }
  appendMsg('ai', '"' + rule.name + '" done.');
}

// Phrase-trigger interception - checked before sending to JARVIS chat
function checkPhraseRule(text) {
  const match = cachedRules.find((r) => r.trigger.type === 'phrase' && r.trigger.value.toLowerCase() === text.toLowerCase());
  if (match) {
    executeRuleById(match.id);
    return true;
  }
  return false;
}

function saveClipboardAsNote() {
  if (lastClipboard) {
    localData.notes.unshift(lastClipboard);
    persist();
    renderLists();
    appendMsg('ai', 'Saved to notes.');
  }
}

function renderClipboardHistory() {
  const container = document.getElementById('clipboard-history');
  container.innerHTML = '';
  if (!clipboardHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = 'Nothing copied yet';
    container.appendChild(empty);
    return;
  }
  clipboardHistory.forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = text.length > 70 ? text.slice(0, 70) + '...' : text;
    row.appendChild(txt);
    const saveBtn = document.createElement('span');
    saveBtn.textContent = 'Save';
    saveBtn.style.cursor = 'pointer';
    saveBtn.style.fontSize = '11px';
    saveBtn.style.color = 'rgba(255,255,255,0.5)';
    saveBtn.addEventListener('click', () => {
      localData.notes.unshift(clipboardHistory[i]);
      persist();
      renderLists();
      appendMsg('ai', 'Saved to notes.');
    });
    row.appendChild(saveBtn);
    container.appendChild(row);
  });
}

function summarizeClipboard() {
  if (lastClipboard) sendCommand('summarize this: ' + lastClipboard.slice(0, 1000));
}

// File drop zone - real dropped file paths (Electron exposes the
// actual filesystem path, unlike a plain browser), with Open/Reveal
// actions backed by real shell calls
// Magnetic cursor effect - the pill subtly leans toward the cursor as
// it gets close, before full hover/expand kicks in. Relies on mouse
// events being forwarded even during click-through (forward:true).
window.addEventListener('mousemove', (e) => {
  if (expanded) return;
  const rect = island.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const dx = e.clientX - cx, dy = e.clientY - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const radius = 180, maxPull = 6;
  const blobEl = document.querySelector('.blob');
  if (dist < radius) {
    const closeness = 1 - dist / radius;
    const pull = closeness * maxPull;
    const angle = Math.atan2(dy, dx);
    island.style.transform = 'translate(' + (Math.cos(angle) * pull) + 'px, ' + (Math.sin(angle) * pull) + 'px)';
    // Slime stretch: the blob elongates toward the cursor direction,
    // like it's reaching, instead of the whole pill just sliding rigidly
    if (blobEl) {
      const stretch = 1 + closeness * 0.9;
      const squash = 1 - closeness * 0.35;
      const angleDeg = angle * (180 / Math.PI);
      blobEl.style.transform = 'rotate(' + angleDeg + 'deg) scale(' + stretch + ',' + squash + ') rotate(' + (-angleDeg) + 'deg)';
    }
  } else {
    island.style.transform = '';
    if (blobEl) blobEl.style.transform = '';
  }
});

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'rgba(255,255,255,0.4)'; });
dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'rgba(255,255,255,0.18)'; });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = 'rgba(255,255,255,0.18)';
  acceptDroppedFiles(e.dataTransfer.files);
});

async function smartRenameAll() {
  const input = document.getElementById('rename-base-input');
  const baseName = input.value.trim();
  if (!baseName) return;
  const paths = droppedFiles.map(f => f.path);
  const result = await fetchAction('smart-rename', { paths, baseName });
  if (result && result.results) {
    const okCount = result.results.filter(r => r.ok).length;
    droppedFiles.forEach((f, i) => {
      if (result.results[i] && result.results[i].ok) {
        f.path = result.results[i].newPath;
        f.name = path_basename(result.results[i].newPath);
      }
    });
    appendMsg('ai', 'Renamed ' + okCount + ' of ' + droppedFiles.length + ' files to "' + baseName + '-1, -2, ...".');
    renderFiles();
  }
}
function path_basename(p) { return p.split(/[\\/]/).pop(); }

function acceptDroppedFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  files.forEach((f) => { droppedFiles.unshift({ name: f.name, path: f.path }); });
  renderFiles();
  setLiveActivity(files.length + ' file' + (files.length > 1 ? 's' : '') + ' added', 4000, 'success');
  setExpanded(true);
  switchTab('tools');
}

// The whole pill itself accepts drops too, not just the small box
// buried in the Tools tab - drag a file onto it from anywhere, even
// collapsed, and it'll expand straight to the Tools tab to show it.
island.addEventListener('dragover', (e) => { e.preventDefault(); island.style.borderColor = 'rgba(255,255,255,0.5)'; });
island.addEventListener('dragleave', () => { island.style.borderColor = ''; });
island.addEventListener('drop', (e) => {
  e.preventDefault();
  island.style.borderColor = '';
  acceptDroppedFiles(e.dataTransfer.files);
});

function renderFiles() {
  const list = document.getElementById('files-list');
  list.innerHTML = '';
  if (droppedFiles.length >= 2) {
    const renameRow = document.createElement('div');
    renameRow.className = 'add-row';
    renameRow.style.marginBottom = '8px';
    const input = document.createElement('input');
    input.id = 'rename-base-input';
    input.placeholder = 'Rename all to... (e.g. thumbnail)';
    const btn = document.createElement('button');
    btn.textContent = 'Rename';
    btn.addEventListener('click', smartRenameAll);
    renameRow.appendChild(input);
    renameRow.appendChild(btn);
    list.appendChild(renameRow);
  }
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  droppedFiles.slice(0, 6).forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'txt';
    nameSpan.textContent = f.name;
    row.appendChild(nameSpan);

    function actionSpan(label, onClick, marginRight) {
      const s = document.createElement('span');
      s.textContent = label;
      s.style.cursor = 'pointer';
      s.style.fontSize = '11px';
      s.style.color = 'rgba(255,255,255,0.5)';
      if (marginRight) s.style.marginRight = '8px';
      s.addEventListener('click', onClick);
      row.appendChild(s);
    }

    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    const isImage = imageExts.includes(ext);
    actionSpan('Open', () => openDroppedFile(i), true);
    actionSpan('Reveal', () => revealDroppedFile(i), isImage);
    if (isImage) {
      const targetFormat = ext === '.png' ? 'jpg' : 'png';
      actionSpan('To ' + targetFormat.toUpperCase(), () => convertDroppedImage(i, targetFormat), false);
    }
    list.appendChild(row);
  });
}

function openDroppedFile(i) { sendAction('open-file', { path: droppedFiles[i].path }); }
function revealDroppedFile(i) { sendAction('reveal-file', { path: droppedFiles[i].path }); }
async function convertDroppedImage(i, format) {
  appendMsg('ai', 'Converting ' + droppedFiles[i].name + ' to ' + format.toUpperCase() + '...');
  setLiveActivity('Converting image...', 0);
  const result = await fetchAction('convert-image', { path: droppedFiles[i].path, format });
  if (result && result.ok) { appendMsg('ai', 'Done: ' + result.destPath); setLiveActivity('Converted ✓', 4000, 'success'); }
  else { appendMsg('ai', 'Conversion failed: ' + (result ? result.error : 'unknown error')); setLiveActivity('Conversion failed', 5000, 'error'); }
}

// Background system monitor - deliberately rule-based, not an AI call.
// "Is 92% CPU worth flagging?" is a number-vs-threshold check, not a
// judgment call - calling the AI for this would just be slower and
// cost tokens for no real benefit. Stays silent unless something
// actually crosses a line worth your attention.
const STATS_THRESHOLDS = { cpu: 88, ram: 90, batteryLow: 15 };
let lastStatsNudge = 0;
let lastCalendarNudge = 0;
async function monitorStats() {
  const stats = await fetchAction('get-stats');
  if (stats && !liveActivity) {
    const now = Date.now();
    const cooldownOk = now - lastStatsNudge > 120000; // don't repeat the same nudge more than once every 2 minutes
    if (cooldownOk) {
      if (stats.cpu >= STATS_THRESHOLDS.cpu) {
        setLiveActivity('CPU at ' + stats.cpu + '%', 6000, 'warning');
        lastStatsNudge = now;
      } else if (stats.ram >= STATS_THRESHOLDS.ram) {
        setLiveActivity('RAM at ' + stats.ram + '%', 6000, 'warning');
        lastStatsNudge = now;
      } else if (stats.battery !== null && stats.battery <= STATS_THRESHOLDS.batteryLow) {
        setLiveActivity('Battery ' + stats.battery + '%', 6000, 'warning');
        lastStatsNudge = now;
      }
    }
  }
  setTimeout(monitorStats, 30000);
}
monitorStats();

async function monitorCalendar() {
  try {
    const res = await fetch(JARVIS_URL + '/api/calendar/next');
    const next = await res.json();
    const now = Date.now();
    if (next && next.title && next.minutesUntil !== undefined && next.minutesUntil <= 15 && next.minutesUntil >= 0) {
      if (now - lastCalendarNudge > 600000 && !liveActivity) { // once every 10 min max
        setLiveActivity(next.title + ' in ' + next.minutesUntil + 'm', 8000);
        lastCalendarNudge = now;
      }
    }
  } catch (e) {}
  setTimeout(monitorCalendar, 60000);
}
monitorCalendar();

let musicActive = false;
let lastMusicText = null;
async function monitorMusic() {
  const np = await fetchAction('get-now-playing');
  console.log('monitorMusic poll result:', JSON.stringify(np));
  const bar = document.getElementById('progress-bar');
  const npBox = document.getElementById('now-playing-box');
  if (np && np.status === 'Playing' && np.title) {
    const songText = '\u266A ' + np.title + (np.artist ? ' — ' + np.artist : '');
    musicActive = true;
    lastMusicText = songText;
    if (npBox) npBox.textContent = np.title + (np.artist ? ' — ' + np.artist : '') + (np.appName ? ' (' + np.appName + ')' : '');
    // Only take over the display if nothing more urgent (timer, an
    // error, JARVIS thinking) is currently showing, or if it's just
    // our own previous tick - this lets transient alerts interrupt
    // briefly without music fighting them for the same text spot.
    if (!liveActivity || liveActivity === lastMusicText) {
      liveActivity = songText;
      setCompactWidth(true);
      if (!expanded) {
        compactText.textContent = songText + '  ·  ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        document.querySelector('.blob').classList.add('active');
      }
    }
    if (np.durationSec > 0) {
      bar.style.display = 'block';
      bar.style.background = '#1ed760'; // Spotify-ish green, distinct from the timer's plain green
      bar.style.width = ((np.positionSec / np.durationSec) * 100) + '%';
    }
  } else if (musicActive) {
    musicActive = false;
    if (npBox) npBox.textContent = 'Nothing playing';
    if (liveActivity === lastMusicText) {
      liveActivity = null;
      setCompactWidth(false);
      updateCompactLabel();
    }
    lastMusicText = null;
    bar.style.display = 'none';
    bar.style.width = '0%';
  }
  setTimeout(monitorMusic, 3000);
}
monitorMusic();
setInterval(() => { if (!expanded) updateCompactLabel(); }, 30000);
sendAction('set-click-through', { ignore: true }); // start idle - don't block clicks to whatever's underneath until actually hovered

function updateAccountChip() {
  const chip = document.getElementById('account-chip');
  if (localData.signedIn && localData.email) {
    chip.style.display = 'inline';
    chip.textContent = localData.email;
  } else {
    chip.style.display = 'none';
  }
}

function showSignInGate() {
  document.getElementById('signin-gate').style.display = 'flex';
  document.getElementById('main-app').style.display = 'none';
  updateAccountChip();
}

function showMainApp() {
  document.getElementById('signin-gate').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';
  updateAccountChip();
}

function renderChatHistory() {
  const log = document.getElementById('chat-log');
  log.innerHTML = '';
  const hist = localData.chatHistory || [];
  if (!hist.length) { log.innerHTML = '<div class="msg placeholder">Type or talk to JARVIS</div>'; return; }
  hist.forEach(m => appendMsg(m.role, m.text, true)); // true = loading history, don't re-persist it
}

async function signInWithGoogle() {
  const status = document.getElementById('signin-status');
  status.textContent = 'Opening Google sign-in in your browser...';
  const result = await fetchAction('google-signin');
  if (!result || !result.ok) {
    status.textContent = (result && result.msg) || 'Could not start sign-in.';
    return;
  }
  status.textContent = 'Waiting for you to finish in the browser...';
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    const acc = await fetchAction('get-account-status');
    if (acc && acc.signedIn) {
      clearInterval(poll);
      status.textContent = '';
      const data = await fetchAction('get-data');
      localData = data || { signedIn: true, email: acc.email, todos: [], notes: [], chatHistory: [], funMode: false, confirmedRules: [] };
      showMainApp();
      renderChatHistory();
      renderLists();
      document.getElementById('fun-mode-chip').textContent = 'Fun Mode: ' + (localData.funMode ? 'On' : 'Off');
      loadPlanStatus();
    } else if (attempts > 40) {
      clearInterval(poll);
      status.textContent = "Still there? Nothing came through — try the button again.";
    }
  }, 1500);
}

async function signOutOfGoogle() {
  await fetchAction('google-signout');
  localData = { signedIn: false, todos: [], notes: [], chatHistory: [], funMode: false, confirmedRules: [] };
  showSignInGate();
}

window.signInWithGoogle = signInWithGoogle;
window.signOutOfGoogle = signOutOfGoogle;

pollClipboard();
renderRulesList();

if (localData.signedIn) {
  showMainApp();
  renderChatHistory();
  renderLists();
  document.getElementById('fun-mode-chip').textContent = 'Fun Mode: ' + (localData.funMode ? 'On' : 'Off');
  loadPlanStatus();
} else {
  showSignInGate();
}
} catch (outerError) {
  console.error('OUTER SCRIPT ERROR:', outerError.message, outerError.stack);
  const el = document.getElementById('compact-text');
  el.textContent = 'ERROR: ' + outerError.message;
  el.style.whiteSpace = 'normal';
  el.style.overflow = 'visible';
  el.style.wordBreak = 'break-word';
  const isl = document.getElementById('island');
  isl.style.width = '380px';
  isl.style.height = 'auto';
  isl.style.minHeight = '60px';
  isl.style.padding = '12px';
  isl.style.alignItems = 'flex-start';
  isl.style.opacity = '1';
}
</script>
</body></html>`;
}

// --- main process ---------------------------------------------------------

function startBridgeServer() {
  const server = http.createServer((req, res) => {
    // Two deliberate exceptions to the token gate, both to do with
    // Google sign-in: the page showing Google's real button (GET), and
    // Google's own POST back to us once someone signs in on it. Neither
    // can present our internal X-Island-Token header, since neither
    // originates from Island's own window. The callback's only real
    // action is verifying a token's signature with Google - a forged
    // token just fails that check, there's nothing else reachable here.
    const urlObj = new URL(req.url, "http://127.0.0.1:" + BRIDGE_PORT);
    if (req.method === "GET" && urlObj.pathname === "/signin-page") {
      serveSignInPage(res);
      return;
    }
    if (req.method === "POST" && urlObj.pathname === "/oauth-callback") {
      handleOAuthCallback(req, res);
      return;
    }

    // Auth check first, before reading any body - anyone without the
    // current session's token gets a bare 403 and nothing else runs.
    // Using crypto.timingSafeEqual so this check itself can't leak the
    // token one byte at a time via response-time differences.
    const presented = req.headers["x-island-token"] || "";
    const presentedBuf = Buffer.from(presented);
    const tokenBuf = Buffer.from(BRIDGE_TOKEN);
    const authorized =
      presentedBuf.length === tokenBuf.length && crypto.timingSafeEqual(presentedBuf, tokenBuf);
    if (!authorized) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const action = req.url.replace(/^\//, "");
      let payload = null;
      try { payload = body ? JSON.parse(body) : null; } catch (e) {}
      const result = await handleAction(action, payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result || {}));
    });
  });
  server.listen(BRIDGE_PORT, "127.0.0.1");
}

function oauthResultPage(title, body) {
  return (
    '<html><head><meta charset="utf-8"><title>' + title + '</title></head>' +
    '<body style="font-family:-apple-system,sans-serif;background:#080808;color:#eee;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">' +
    '<div style="text-align:center;max-width:360px;padding:24px;">' +
    '<div style="font-size:32px;margin-bottom:10px;">🏝️</div>' +
    '<h2 style="margin-bottom:8px;">' + title + '</h2>' +
    '<p style="color:rgba(255,255,255,.6);font-size:14px;">' + body + '</p>' +
    '</div></body></html>'
  );
}

// Real Google-hosted "Sign in with Google" button (Google Identity
// Services) - same widget Inbox uses. Google itself decides what the
// button looks like and handles account selection/consent; all this
// page does is load Google's script and point it at our callback.
function serveSignInPage(res) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign in to Island</title></head>
<body style="font-family:-apple-system,sans-serif;background:#080808;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:18px;">
<div style="font-size:32px;">🏝️</div>
<div style="font-size:15px;">Sign in to Island</div>
<div id="g_id_onload"
  data-client_id="${GOOGLE_CLIENT_ID}"
  data-ux_mode="redirect"
  data-login_uri="${OAUTH_REDIRECT}">
</div>
<div class="g_id_signin" data-type="standard" data-size="large" data-theme="filled_black" data-text="continue_with" data-shape="rectangular"></div>
<div id="debug-box" style="display:none;max-width:420px;background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:14px 18px;margin-top:10px;">
  <div style="font-size:12px;color:#ff8c42;font-weight:700;margin-bottom:8px;">Here's what went wrong (copy this to Chattychop):</div>
  <pre id="debug-text" style="font-size:11px;color:#ccc;white-space:pre-wrap;word-break:break-word;margin:0;"></pre>
</div>
<script>
  // Google's script logs failures via console.error rather than
  // throwing, and a page like this has no dev-tools-free way to see
  // that - so this catches both console.error calls and thrown errors
  // and prints them right on the page instead, plain text, copyable.
  var debugLines = [];
  var origError = console.error;
  console.error = function() {
    debugLines.push(Array.prototype.slice.call(arguments).join(' '));
    showDebug();
    origError.apply(console, arguments);
  };
  window.onerror = function(msg, url, line) {
    debugLines.push('Script error: ' + msg + ' (line ' + line + ')');
    showDebug();
  };
  function showDebug() {
    document.getElementById('debug-box').style.display = 'block';
    document.getElementById('debug-text').textContent = debugLines.join('\\n');
  }
  setTimeout(function () {
    var rendered = document.querySelector('.g_id_signin iframe');
    if (!rendered) {
      debugLines.push('No Google button appeared after 4 seconds - either the script above failed to load, or Google rejected this page (see any line above this one for why).');
      showDebug();
    }
  }, 4000);
</script>
<script src="https://accounts.google.com/gsi/client" async onerror="debugLines.push('Failed to load Google\\'s sign-in script at all - check your internet connection.'); showDebug();"></script>
</body></html>`;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

async function handleOAuthCallback(req, res) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    const respond = (title, msg) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(oauthResultPage(title, msg));
    };
    const params = new URLSearchParams(body);
    const idToken = params.get("credential");
    if (!idToken) {
      respond("Sign-in cancelled", "No harm done — head back to Island and try again whenever you're ready.");
      return;
    }
    try {
      // Google's tokeninfo endpoint does the signature verification for
      // us - we just have to make sure the token was actually meant for
      // THIS app (aud) and actually came from Google (iss), so a token
      // issued for some other app can't be replayed in here.
      const verifyRes = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
      const claims = await verifyRes.json();
      const validIssuer = claims.iss === "accounts.google.com" || claims.iss === "https://accounts.google.com";
      if (!verifyRes.ok || !validIssuer || claims.aud !== GOOGLE_CLIENT_ID) {
        respond("Sign-in failed", "That sign-in didn't check out. Go back to Island and try again.");
        return;
      }
      const email = (claims.email || "").toLowerCase();
      if (!email) {
        respond("Sign-in failed", "Couldn't read your Google account email. Try again.");
        return;
      }

      const data = loadLocalData();
      if (!data.accounts[email]) {
        data.accounts[email] = { todos: [], notes: [], chatHistory: [], funMode: false, confirmedRules: [] };
      }
      data.accounts[email].name = claims.name || email.split("@")[0];
      data.currentAccount = email;
      saveLocalData(data);

      respond("Signed in ✅", "You're in as " + email + " — this tab can be closed, head back to Island.");
      if (win) { win.show(); win.focus(); }
    } catch (e) {
      respond("Sign-in error", e.message);
    }
  });
}

function createWindow() {
  winState.x = centerX(COLLAPSED.width);
  winState.y = 0;
  win = new BrowserWindow({
    width: COLLAPSED.width,
    height: COLLAPSED.height,
    x: winState.x,
    y: winState.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      webSecurity: false, // only ever loads our own embedded HTML below, never a remote page
    },
  });
  // "screen-saver" level always-on-top is unusually aggressive - Windows
  // treats that z-order level as designed for non-interactive overlays
  // (actual screensavers), which could be why typing/clicking inside
  // this window has been unreliable. Plain alwaysOnTop:true (set in the
  // constructor above) is the normal level real overlay apps use and
  // still takes input correctly.
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(buildHTML()));

  // Pipes every console.log/error/warn from inside the Island's page
  // straight into this same terminal window (the one JARVIS.py's
  // console already shows) instead of needing a separate DevTools
  // window, which was flickering/unstable for an unclear reason.
  win.webContents.on("console-message", (event, level, message) => {
    console.log("[ISLAND]", message);
  });
  // Removed: a forced win.webContents.invalidate() loop was here as a
  // speculative fix for a "stale repaint" theory that was never
  // confirmed. Hammering the renderer with forced repaints every 150ms
  // can itself starve it from processing real input events - which
  // lines up with things getting WORSE right after adding it (even
  // previously-working buttons stopped responding). Removed.
}

function cpuSnapshot() {
  const os = require("os");
  return os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
}

function getSystemStats() {
  return new Promise((resolve) => {
    const os = require("os");
    const before = cpuSnapshot();
    setTimeout(() => {
      const after = cpuSnapshot();
      let idleDelta = 0, totalDelta = 0;
      for (let i = 0; i < before.length; i++) {
        idleDelta += after[i].idle - before[i].idle;
        totalDelta += after[i].total - before[i].total;
      }
      const cpuPercent = totalDelta > 0 ? Math.round(100 - (100 * idleDelta) / totalDelta) : 0;
      const ramPercent = Math.round(100 - (100 * os.freemem()) / os.totalmem());

      const { exec } = require("child_process");
      exec('powershell -command "(Get-WmiObject Win32_Battery).EstimatedChargeRemaining"', (err, stdout) => {
        const battery = !err && stdout.trim() ? parseInt(stdout.trim(), 10) : null;
        resolve({ cpu: cpuPercent, ram: ramPercent, battery });
      });
    }, 200);
  });
}

async function handleAction(action, payload) {
  switch (action) {
    case "lag-hunter": {
      const { exec } = require("child_process");
      const ps = "Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 5 Name, @{Name='MB';Expression={[math]::Round($_.WorkingSet/1MB)}} | ConvertTo-Json -Compress";
      return new Promise((resolve) => {
        exec(`powershell -Command "${ps}"`, { timeout: 6000 }, (err, stdout) => {
          if (err) return resolve(null);
          try {
            const list = JSON.parse(stdout.trim() || "[]");
            resolve(Array.isArray(list) ? list : [list]);
          } catch (e) {
            resolve(null);
          }
        });
      });
    }
    case "get-stats":
      return await getSystemStats();
    case "get-clipboard": {
      const { clipboard } = require("electron");
      return { text: clipboard.readText() };
    }
    case "smart-rename": {
      // Renames within the same folder only, never moves/deletes
      // anything - safe by construction.
      const { paths, baseName } = payload;
      const results = [];
      paths.forEach((p, i) => {
        try {
          const dir = path.dirname(p);
          const ext = path.extname(p);
          const newPath = path.join(dir, baseName + "-" + (i + 1) + ext);
          fs.renameSync(p, newPath);
          results.push({ ok: true, newPath });
        } catch (e) {
          results.push({ ok: false, error: e.message });
        }
      });
      return { results };
    }
    case "open-file":
      require("electron").shell.openPath(payload.path);
      return {};
    case "reveal-file":
      require("electron").shell.showItemInFolder(payload.path);
      return {};
    case "log-error": {
      const logFile = path.join(__dirname, "island_errors.log");
      const line = `[${new Date().toISOString()}] ${JSON.stringify(payload)}\n`;
      fs.appendFileSync(logFile, line);
      console.log("Logged error to island_errors.log");
      break;
    }
    case "set-click-through":
      if (win) win.setIgnoreMouseEvents(!!payload.ignore, { forward: true });
      break;
    case "move-window":
      if (win) {
        winState.x += payload.dx;
        winState.y += payload.dy;
        win.setPosition(winState.x, winState.y);
      }
      break;
    case "resize-expanded":
      applyResize(EXPANDED.width, EXPANDED.height);
      break;
    case "resize-collapsed":
      applyResize(COLLAPSED.width, COLLAPSED.height);
      break;
    case "reopen-last-tab": {
      // Actually presses Ctrl+Shift+T on Chrome, instead of sending it
      // through JARVIS's AI chat (which just searches Google for "how
      // do I reopen a tab" instead of doing it).
      const { exec } = require("child_process");
      const psCmd = `$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate('Chrome'); Start-Sleep -Milliseconds 200; $wshell.SendKeys('^+t')`;
      exec(`powershell -command "${psCmd}"`, (err) => {
        if (err) console.log("reopen-last-tab failed:", err.message);
      });
      break;
    }
    case "launch-workspace": {
      const { exec } = require("child_process");
      const presets = {
        study: ["notepad", "cmd /c start chrome"],
        creator: ["cmd /c start spotify:", "cmd /c start chrome https://studio.youtube.com"],
      };
      const cmds = presets[payload && payload.mode] || [];
      cmds.forEach((c) => exec(c, () => {}));
      break;
    }
    case "check-spotify": {
      const { exec } = require("child_process");
      // User uses Spotify via the Chrome web player, not the desktop
      // app - checking for Spotify.exe (which never exists for them)
      // was always wrongly concluding it's "not running" and launching
      // the desktop app instead, which is the wrong thing entirely.
      exec('tasklist /v /fo csv', (err, stdout) => {
        const hasSpotifyTab = stdout && stdout.toLowerCase().includes("spotify");
        if (hasSpotifyTab) {
          console.log("Spotify web player appears to already be open");
        } else {
          console.log("Opening Spotify web player in Chrome");
          const chromePaths = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ];
          const chrome = chromePaths.find((p) => fs.existsSync(p));
          if (chrome) exec(`"${chrome}" "https://open.spotify.com"`, () => {});
          else exec('start https://open.spotify.com', () => {});
        }
      });
      break;
    }
    case "os-command": {
      const { exec } = require("child_process");
      const cmds = {
        "empty-recycle-bin": "powershell -command \"Clear-RecycleBin -Force -ErrorAction SilentlyContinue\"",
        "mute": "powershell -command \"(New-Object -ComObject WScript.Shell).SendKeys([char]173)\"",
        "lock-pc": "rundll32.exe user32.dll,LockWorkStation",
        "sleep-pc": "powershell -command \"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend',$false,$false)\"",
        "open-downloads": "explorer " + path.join(require("os").homedir(), "Downloads"),
        "screenshot": "powershell -command \"Add-Type -AssemblyName System.Windows.Forms; $b=New-Object System.Drawing.Bitmap([System.Windows.Forms.SystemInformation]::VirtualScreen.Width,[System.Windows.Forms.SystemInformation]::VirtualScreen.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save('" + path.join(require("os").homedir(), "Desktop", "island_screenshot.png").replace(/\\/g, "\\\\") + "')\"",
        // Media/volume keys via virtual key char codes through SendKeys -
        // these are real OS-level media keys, work with whatever app
        // currently has the system's media session (Spotify, YouTube
        // Music in a browser tab, etc.) without needing per-app APIs.
        "media-play-pause": "powershell -command \"(New-Object -ComObject WScript.Shell).SendKeys([char]179)\"",
        "media-next": "powershell -command \"(New-Object -ComObject WScript.Shell).SendKeys([char]176)\"",
        "media-prev": "powershell -command \"(New-Object -ComObject WScript.Shell).SendKeys([char]177)\"",
        "volume-up": "powershell -command \"(New-Object -ComObject WScript.Shell).SendKeys([char]175)\"",
        "volume-down": "powershell -command \"(New-Object -ComObject WScript.Shell).SendKeys([char]174)\"",
        "restart-explorer": "powershell -command \"Stop-Process -Name explorer -Force; Start-Sleep -Milliseconds 500; Start-Process explorer\"",
      };
      const cmd = cmds[payload && payload.name];
      if (cmd) exec(cmd, (err) => { if (err) console.log("os-command failed:", err.message); });
      break;
    }
    case "capture-screenshot": {
      const { exec } = require("child_process");
      const tmpPath = path.join(require("os").tmpdir(), "island_capture_" + Date.now() + ".png");
      const escaped = tmpPath.replace(/\\/g, "\\\\");
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $b=New-Object System.Drawing.Bitmap([System.Windows.Forms.SystemInformation]::VirtualScreen.Width,[System.Windows.Forms.SystemInformation]::VirtualScreen.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save('${escaped}')`;
      return new Promise((resolve) => {
        exec(`powershell -command "${ps}"`, (err) => {
          if (err) return resolve({ error: "Screenshot failed: " + err.message });
          try {
            const data = fs.readFileSync(tmpPath).toString("base64");
            fs.unlinkSync(tmpPath);
            resolve({ data, mimeType: "image/png" });
          } catch (e) {
            resolve({ error: "Couldn't read screenshot: " + e.message });
          }
        });
      });
    }
    case "scan-files-for-search": {
      const home = require("os").homedir();
      const foldersToScan = ["Desktop", "Downloads", "Documents", "Pictures"].map((f) => path.join(home, f));
      const results = [];
      function scanDir(dir, depth) {
        if (depth > 1 || results.length > 250) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
          if (results.length > 250) return;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(full, depth + 1);
          } else {
            try {
              const stat = fs.statSync(full);
              results.push({
                path: full,
                name: entry.name,
                modified: stat.mtime.toISOString().slice(0, 10),
                sizeKB: Math.round(stat.size / 1024),
              });
            } catch (e) {}
          }
        }
      }
      foldersToScan.forEach((f) => scanDir(f, 0));
      return { files: results };
    }
    case "preview-organize-downloads": {
      const downloadsDir = path.join(require("os").homedir(), "Downloads");
      const categories = { images: 0, documents: 0, videos: 0, archives: 0, other: 0 };
      const extMap = {
        images: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"],
        documents: [".pdf", ".doc", ".docx", ".txt", ".xlsx", ".pptx", ".csv"],
        videos: [".mp4", ".mov", ".avi", ".mkv", ".webm"],
        archives: [".zip", ".rar", ".7z", ".tar", ".gz"],
      };
      try {
        const files = fs.readdirSync(downloadsDir).filter((f) => fs.statSync(path.join(downloadsDir, f)).isFile());
        files.forEach((f) => {
          const ext = path.extname(f).toLowerCase();
          const cat = Object.keys(extMap).find((k) => extMap[k].includes(ext));
          categories[cat || "other"]++;
        });
        return { categories, total: files.length };
      } catch (e) {
        return { error: e.message };
      }
    }
    case "organize-downloads": {
      // Move-only, never deletes anything. Skips (doesn't overwrite) if
      // a same-named file already exists at the destination.
      const downloadsDir = path.join(require("os").homedir(), "Downloads");
      const extMap = {
        Images: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"],
        Documents: [".pdf", ".doc", ".docx", ".txt", ".xlsx", ".pptx", ".csv"],
        Videos: [".mp4", ".mov", ".avi", ".mkv", ".webm"],
        Archives: [".zip", ".rar", ".7z", ".tar", ".gz"],
      };
      let moved = 0, skipped = 0;
      try {
        const files = fs.readdirSync(downloadsDir).filter((f) => fs.statSync(path.join(downloadsDir, f)).isFile());
        files.forEach((f) => {
          const ext = path.extname(f).toLowerCase();
          const cat = Object.keys(extMap).find((k) => extMap[k].includes(ext)) || "Other";
          const destDir = path.join(downloadsDir, cat);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir);
          const destPath = path.join(destDir, f);
          if (fs.existsSync(destPath)) { skipped++; return; }
          fs.renameSync(path.join(downloadsDir, f), destPath);
          moved++;
        });
        return { moved, skipped };
      } catch (e) {
        return { error: e.message };
      }
    }
    case "convert-image": {
      const { exec } = require("child_process");
      const srcPath = payload.path;
      const targetExt = payload.format; // "png" or "jpg"
      const destPath = srcPath.replace(/\.[^.]+$/, "") + "_converted." + targetExt;
      // PowerShell single-quoted strings only need '' -> escaped single
      // quote; a raw ' in a filename would otherwise close the string
      // early and let anything after it run as PowerShell code.
      const escSrc = srcPath.replace(/'/g, "''");
      const escDest = destPath.replace(/'/g, "''");
      const formatEnum = targetExt === "png" ? "Png" : "Jpeg";
      const ps = `Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('${escSrc}'); $img.Save('${escDest}',[System.Drawing.Imaging.ImageFormat]::${formatEnum}); $img.Dispose()`;
      return new Promise((resolve) => {
        exec(`powershell -command "${ps}"`, (err) => {
          resolve(err ? { error: err.message } : { ok: true, destPath });
        });
      });
    }
    case "get-now-playing": {
      const { exec } = require("child_process");
      const scriptPath = ensureNowPlayingScript();
      return new Promise((resolve) => {
        exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 5000 }, (err, stdout) => {
          if (err) return resolve(null);
          try {
            const data = JSON.parse(stdout.trim() || "{}");
            resolve(data.title ? data : null);
          } catch (e) {
            resolve(null);
          }
        });
      });
    }
    case "get-rules":
      return rulesCache;
    case "save-rule": {
      const rule = payload;
      if (!rule.id) rule.id = "rule_" + Date.now();
      const idx = rulesCache.findIndex((r) => r.id === rule.id);
      if (idx >= 0) rulesCache[idx] = rule; else rulesCache.push(rule);
      saveRulesToDisk(rulesCache);
      registerAllHotkeys();
      return { ok: true, id: rule.id };
    }
    case "delete-rule": {
      rulesCache = rulesCache.filter((r) => r.id !== payload.id);
      saveRulesToDisk(rulesCache);
      registerAllHotkeys();
      return { ok: true };
    }
    case "run-rule-action": {
      // Executes one action step of a rule chain - reuses the exact
      // same real handlers as the manual buttons elsewhere (os-command,
      // skill run, etc.), nothing new or separately risky.
      const step = payload;
      if (step.type === "open-url") {
        let url = step.value.trim();
        if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        require("electron").shell.openExternal(url);
        return { ok: true };
      }
      if (step.type === "os-command") {
        return await handleAction("os-command", { name: step.value });
      }
      if (step.type === "run-skill") {
        try {
          await fetch(JARVIS_URL + "/api/skills/" + encodeURIComponent(step.value) + "/run", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
          });
        } catch (e) {}
        return { ok: true };
      }
      return { ok: false, error: "Unknown action type" };
    }
    case "get-foreground-app": {
      const { exec } = require("child_process");
      const ps = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
}
"@
$hwnd = [W]::GetForegroundWindow()
$pid = 0
[W]::GetWindowThreadProcessId($hwnd, [ref]$pid)
(Get-Process -Id $pid).ProcessName`;
      return new Promise((resolve) => {
        exec(`powershell -command "${ps.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, (err, stdout) => {
          resolve({ app: err ? null : stdout.trim() });
        });
      });
    }
    case "close-island":
      app.quit();
      break;
    case "open-jarvis":
      openJarvis(false);
      break;
    case "open-jarvis-voice":
      openJarvis(true);
      break;
    case "get-data": {
      const data = loadLocalData();
      if (!data.currentAccount) return { signedIn: false };
      const acc = getActiveAccount(data);
      saveLocalData(data); // persist if this just created the account's slot
      return { signedIn: true, email: data.currentAccount, ...acc };
    }
    case "save-data": {
      const data = loadLocalData();
      if (!data.currentAccount) break; // not signed in - nothing to attach this to
      data.accounts[data.currentAccount] = { ...getActiveAccount(data), ...payload };
      saveLocalData(data);
      break;
    }
    case "google-signin": {
      require("electron").shell.openExternal(SIGNIN_PAGE_URL);
      return { ok: true };
    }
    case "google-signout": {
      const data = loadLocalData();
      data.currentAccount = null; // history stays saved for next time, just not active
      saveLocalData(data);
      return { ok: true };
    }
    case "get-account-status": {
      const data = loadLocalData();
      if (!data.currentAccount) return { signedIn: false };
      const acc = data.accounts[data.currentAccount] || {};
      return { signedIn: true, email: data.currentAccount, name: acc.name || data.currentAccount.split("@")[0] };
    }
    case "get-startup-status": {
      // Electron's own API for this - it writes/removes the real
      // registry Run-key entry Windows checks on login, same mechanism
      // Task Manager's "Startup apps" tab shows. No manual registry or
      // shortcut-file handling needed.
      return { enabled: app.getLoginItemSettings().openAtLogin };
    }
    case "set-startup": {
      const enabled = !!(payload && payload.enabled);
      const settings = { openAtLogin: enabled };
      if (!app.isPackaged) {
        // Dev mode (npm start) - bare electron.exe on its own doesn't
        // know which app to load, it needs this folder's path passed
        // as an arg, same as typing `electron .` here manually would.
        settings.path = process.execPath;
        settings.args = [path.resolve(__dirname)];
      }
      app.setLoginItemSettings(settings);
      return { enabled: app.getLoginItemSettings().openAtLogin };
    }
    case "get-island-status": {
      const deviceId = getOrCreateDeviceId();
      const bin = await fetchIslandBinLatest();
      const data = loadLocalData();
      const userEntry = (bin.islandUsers || {})[deviceId];
      const { banned, tier, effectiveLimit } = getIslandTierInfo(bin, data, userEntry);
      const today = new Date().toDateString();
      const usedToday = data.islandMsgDate === today ? data.islandMsgCount || 0 : 0;
      // Admin's per-device personal message (set in the Users detail
      // panel) - only surfaced once until dismissed. Re-shows if admin
      // changes the text (compared as exact strings, same idea as
      // Inbox's sessionStorage-hash approach, just persisted here in
      // island_data.json instead since Island has no browser storage
      // that survives a window reload).
      const rawMessage = (userEntry && userEntry.message || "").trim();
      const dismissed = data.islandDismissedMessages || [];
      const personalMessage = rawMessage && !dismissed.includes(rawMessage) ? rawMessage : null;
      return {
        deviceId,
        banned,
        tier,
        tierExpiry: data.islandTierExpiry || null,
        announcement: bin.islandAnnouncement || { text: "", type: "info" },
        proPrice: bin.islandProPrice || 100,
        premiumPrice: bin.islandPremiumPrice || 299,
        proLimit: bin.islandProLimit || 99999,
        premiumLimit: bin.islandPremiumLimit || 99999,
        freeLimit: bin.islandFreeLimit || 15,
        effectiveLimit,
        usedToday,
        personalMessage,
      };
    }
    case "dismiss-island-message": {
      const message = (payload && payload.message || "").trim();
      if (!message) return { ok: false };
      const data = loadLocalData();
      data.islandDismissedMessages = [...new Set([...(data.islandDismissedMessages || []), message])];
      saveLocalData(data);
      return { ok: true };
    }
    case "redeem-island-code": {
      const deviceId = getOrCreateDeviceId();
      const code = (payload && payload.code || "").trim().toUpperCase();
      if (!code) return { ok: false, msg: "Enter a code" };
      const data = loadLocalData();
      if ((data.islandUsedCodes || []).includes(code)) {
        return { ok: false, msg: "This code has already been activated on this device" };
      }
      const bin = await fetchIslandBinLatest();
      const codes = bin.islandCodes || [];
      const now = Date.now();
      const match = codes.find((c) => c.code === code && c.deviceId === deviceId && c.expiry > now);
      if (!match) return { ok: false, msg: "Invalid code, expired, or not for this device" };
      data.islandTier = match.tier.toLowerCase();
      data.islandTierExpiry = match.expiry;
      data.islandUsedCodes = [...(data.islandUsedCodes || []), code];
      saveLocalData(data);
      try {
        const updatedCodes = codes.map((c) => (c.code === code ? { ...c, used: true, usedAt: now } : c));
        await pushIslandBinPatch({ islandCodes: updatedCodes });
      } catch (e) {}
      return { ok: true, tier: data.islandTier, msg: "Activated! Enjoy your " + match.tier + " plan!" };
    }
    case "island-ask": {
      const prompt = payload && payload.prompt;
      if (!prompt) return { error: "No prompt given" };
      const deviceId = getOrCreateDeviceId();
      const bin = await fetchIslandBinLatest();
      const data = loadLocalData();
      const userEntry = (bin.islandUsers || {})[deviceId];
      const { banned, effectiveLimit } = getIslandTierInfo(bin, data, userEntry);
      if (banned) return { error: "This device has been suspended." };
      const today = new Date().toDateString();
      const usedToday = data.islandMsgDate === today ? data.islandMsgCount || 0 : 0;
      if (effectiveLimit < 99999 && usedToday >= effectiveLimit) {
        return { error: "Daily limit reached (" + effectiveLimit + "/day on your plan) — upgrade in the Plan tab for more." };
      }
      const answer = await callIslandAI(bin.islandApiKey, prompt);
      data.islandMsgCount = usedToday + 1;
      data.islandMsgDate = today;
      saveLocalData(data);
      return { answer };
    }
  }
}

function getIslandTierInfo(bin, data, userEntry) {
  const now = Date.now();
  const banned = userEntry && userEntry.category === "banned";
  let tier = "free";
  if (!banned && data.islandTierExpiry && data.islandTierExpiry > now) {
    tier = data.islandTier || "free";
  }
  const limit =
    tier === "premium" ? bin.islandPremiumLimit || 99999
    : tier === "pro" ? bin.islandProLimit || 99999
    : bin.islandFreeLimit || 15;
  const effectiveLimit = (userEntry && userEntry.customLimit) || limit;
  return { banned: !!banned, tier, effectiveLimit };
}

async function fetchIslandBinLatest() {
  try {
    const r = await fetch(ISLAND_JBIN_URL + "/latest?meta=false");
    return await r.json();
  } catch (e) {
    return {};
  }
}

// Read-modify-write: always re-pull latest first so we don't clobber
// fields Inbox/admin wrote in the meantime (same pattern index.html's
// markCodeUsedInBin already uses against this same bin).
async function pushIslandBinPatch(patch) {
  const curr = await fetchIslandBinLatest();
  const merged = { ...curr, ...patch };
  await fetch(ISLAND_JBIN_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": ISLAND_JBIN_KEY },
    body: JSON.stringify(merged),
  });
  return merged;
}

// Same provider auto-detection by key prefix as JARVIS.py's call_ai(),
// just reimplemented in JS since this runs in the Electron main
// process using Island's own key (separate from JARVIS.py's AI_KEY).
async function callIslandAI(key, prompt) {
  key = (key || "").trim();
  if (!key) return "No Island API key set in admin yet.";
  try {
    if (key.startsWith("gsk_")) {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: 250, messages: [{ role: "user", content: prompt }] }),
      });
      const d = await r.json();
      return d.choices?.[0]?.message?.content?.trim() || "No response";
    }
    if (key.startsWith("AIza")) {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + key,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
      );
      const d = await r.json();
      return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "No response";
    }
    if (key.startsWith("sk-or-")) {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "meta-llama/llama-3.3-70b-instruct:free", max_tokens: 250, messages: [{ role: "user", content: prompt }] }),
      });
      const d = await r.json();
      return d.choices?.[0]?.message?.content?.trim() || "No response";
    }
    if (key.startsWith("sk-ant")) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 250, messages: [{ role: "user", content: prompt }] }),
      });
      const d = await r.json();
      return d.content?.[0]?.text?.trim() || "No response";
    }
    const r = await fetch("https://api.cohere.com/v2/chat", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "command-r-plus-08-2024", messages: [{ role: "user", content: prompt }] }),
    });
    const d = await r.json();
    return d.message?.content?.[0]?.text?.trim() || "No response";
  } catch (e) {
    return "AI error: " + e.message;
  }
}

app.whenReady().then(() => {
  startBridgeServer();
  createWindow();
  setTimeout(registerAllHotkeys, 1000);
  setTimeout(runStartupRules, 3000);
});
app.on("will-quit", () => {
  require("electron").globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => app.quit());
