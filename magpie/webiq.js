// Magpie search plugin for Microsoft Web IQ (https://webiq.microsoft.ai/)
// Docs:
//   - https://learn.microsoft.com/en-us/web-iq/get-started/authentication
//   - https://learn.microsoft.com/en-us/web-iq/reference/web-search
//   - https://learn.microsoft.com/en-us/web-iq/concepts/content-formats
//   - https://learn.microsoft.com/en-us/web-iq/reference/error-handling

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://api.microsoft.ai/v3";
const PROFILES_URL = "https://webiq.microsoft.ai/profiles/";
const VALID_FORMATS = new Set(["passage", "text", "markdown", "html"]);
const VALID_SAFE_SEARCH = new Set(["strict", "off"]);

const DEFAULT_KEY_TTL_DAYS = 30;
const DEFAULT_WARN_DAYS = 3;
const EXPIRED_POPUP_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes debounce on 401
const EXPIRING_WARN_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours between near-expiry reminders
const ACTIVE_POPUP_LOCK_MS = 3 * 60 * 1000; // 3 minutes lock while dialog is launching/open

const PLUGIN_FILE = fileURLToPath(import.meta.url);
const STATE_FILE = path.join(path.dirname(PLUGIN_FILE), "webiq-state.json");
const PLUGIN_SHORT_NAME = path
  .basename(PLUGIN_FILE)
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-")
  .replace(/^-+|-+$/g, "");
const VENDOR_ID = `${PLUGIN_SHORT_NAME}:web`;

function keyFingerprint(secret) {
  return createHash("sha256").update(String(secret || ""), "utf8").digest("hex").slice(0, 12);
}

function formatLocalYmd(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysYmd(days) {
  const dt = new Date(Date.now() + days * 86_400_000);
  return formatLocalYmd(dt);
}

function parseEndOfDayLocalMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "").trim());
  if (!m) return NaN;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return dt.getTime();
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { keys: {}, activePopupUntil: 0 };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return { keys: {}, activePopupUntil: 0 };
    if (!parsed.keys || typeof parsed.keys !== "object") parsed.keys = {};
    if (typeof parsed.activePopupUntil !== "number") parsed.activePopupUntil = 0;
    return parsed;
  } catch {
    return { keys: {}, activePopupUntil: 0 };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {}
}

function ensureKeyRecord(state, fp, explicitExpires, ttlDays) {
  let rec = state.keys[fp];
  let dirty = false;
  if (!rec || typeof rec !== "object") {
    rec = {
      firstSeenAt: new Date().toISOString(),
      expiresAt: explicitExpires || addDaysYmd(ttlDays),
      lastWarnedAt: 0,
      lastExpiredPopupAt: 0,
    };
    state.keys[fp] = rec;
    dirty = true;
  } else if (explicitExpires && rec.expiresAt !== explicitExpires) {
    rec.expiresAt = explicitExpires;
    dirty = true;
  } else if (!rec.expiresAt) {
    rec.expiresAt = addDaysYmd(ttlDays);
    dirty = true;
  }
  return { rec, dirty };
}

function buildWindowsRenewalPopupScript(cfgJson) {
  return `
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiHelper { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction SilentlyContinue
  [void][DpiHelper]::SetProcessDPIAware()
} catch {}
[System.Windows.Forms.Application]::EnableVisualStyles()

$cfg = ConvertFrom-Json @'
${cfgJson}
'@

function Clear-PopupLock {
  try {
    if (Test-Path -LiteralPath $cfg.stateFile) {
      $st = Get-Content -LiteralPath $cfg.stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $st) {
        $st | Add-Member -NotePropertyName activePopupUntil -NotePropertyValue 0 -Force
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($cfg.stateFile, ($st | ConvertTo-Json -Depth 6) + [Environment]::NewLine, $utf8NoBom)
      }
    }
  } catch {}
}

function Find-MagpieExe {
  $running = Get-Process -Name "magpie" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running -and $running.Path -and (Test-Path -LiteralPath $running.Path)) {
    return $running.Path
  }
  $defaultExe = Join-Path $env:LOCALAPPDATA "Programs\\magpie\\magpie.exe"
  if (Test-Path -LiteralPath $defaultExe) {
    return $defaultExe
  }
  $cmd = Get-Command "magpie" -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    return $cmd.Source
  }
  return $null
}

function Get-KeyFingerprint([string]$secret) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
    $hash = $sha.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash).Replace("-", "").ToLowerInvariant().Substring(0, 12))
  } finally {
    $sha.Dispose()
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Magpie · Microsoft Web IQ API Key 更新助手"
$form.ClientSize = New-Object System.Drawing.Size(540, 315)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5)

$lblBanner = New-Object System.Windows.Forms.Label
$lblBanner.Location = New-Object System.Drawing.Point(20, 16)
$lblBanner.Size = New-Object System.Drawing.Size(500, 48)
$lblBanner.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Bold)
if ($cfg.mode -eq "expired") {
  $lblBanner.ForeColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
  $lblBanner.Text = "当前 Microsoft Web IQ API Key 已过期或认证失败\`r\`n详情: " + $cfg.detail
} else {
  $lblBanner.ForeColor = [System.Drawing.Color]::FromArgb(180, 83, 9)
  $lblBanner.Text = "Microsoft Web IQ API Key 即将到期提醒\`r\`n当前记录到期日: " + $cfg.expiresAt + "（" + $cfg.detail + "）"
}
$form.Controls.Add($lblBanner)

$btnPortal = New-Object System.Windows.Forms.Button
$btnPortal.Location = New-Object System.Drawing.Point(20, 72)
$btnPortal.Size = New-Object System.Drawing.Size(270, 34)
$btnPortal.Text = "1. 打开 Web IQ Profiles 页面生成新 Key"
$form.Controls.Add($btnPortal)

$lblKey = New-Object System.Windows.Forms.Label
$lblKey.Location = New-Object System.Drawing.Point(20, 120)
$lblKey.Size = New-Object System.Drawing.Size(300, 22)
$lblKey.Text = "2. 粘贴新 API Key (x-apikey):"
$form.Controls.Add($lblKey)

$chkShow = New-Object System.Windows.Forms.CheckBox
$chkShow.Location = New-Object System.Drawing.Point(430, 118)
$chkShow.Size = New-Object System.Drawing.Size(90, 24)
$chkShow.Text = "显示明文"
$form.Controls.Add($chkShow)

$txtKey = New-Object System.Windows.Forms.TextBox
$txtKey.Location = New-Object System.Drawing.Point(20, 145)
$txtKey.Size = New-Object System.Drawing.Size(410, 28)
$txtKey.UseSystemPasswordChar = $true
$form.Controls.Add($txtKey)

$btnPaste = New-Object System.Windows.Forms.Button
$btnPaste.Location = New-Object System.Drawing.Point(438, 143)
$btnPaste.Size = New-Object System.Drawing.Size(82, 29)
$btnPaste.Text = "粘贴"
$form.Controls.Add($btnPaste)

$lblExp = New-Object System.Windows.Forms.Label
$lblExp.Location = New-Object System.Drawing.Point(20, 186)
$lblExp.Size = New-Object System.Drawing.Size(260, 24)
$lblExp.Text = "新 Key 到期日 (YYYY-MM-DD，默认 +30 天):"
$form.Controls.Add($lblExp)

$txtExp = New-Object System.Windows.Forms.TextBox
$txtExp.Location = New-Object System.Drawing.Point(285, 183)
$txtExp.Size = New-Object System.Drawing.Size(145, 28)
$txtExp.Text = (Get-Date).AddDays([int]$cfg.ttlDays).ToString("yyyy-MM-dd")
$form.Controls.Add($txtExp)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(20, 220)
$lblStatus.Size = New-Object System.Drawing.Size(500, 38)
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(75, 85, 99)
$lblStatus.Text = "提示：保存前将自动验证新 Key 有效性，并通过 Magpie CLI 热更新 (" + $cfg.vendorId + ")。"
$form.Controls.Add($lblStatus)

$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Location = New-Object System.Drawing.Point(260, 266)
$btnSave.Size = New-Object System.Drawing.Size(165, 34)
$btnSave.Text = "验证并更新到 Magpie"
$form.Controls.Add($btnSave)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Location = New-Object System.Drawing.Point(435, 266)
$btnClose.Size = New-Object System.Drawing.Size(85, 34)
$btnClose.Text = "稍后处理"
$form.Controls.Add($btnClose)

$chkShow.Add_CheckedChanged({
  $txtKey.UseSystemPasswordChar = -not $chkShow.Checked
})

$btnPortal.Add_Click({
  Start-Process $cfg.profilesUrl | Out-Null
  $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
  $lblStatus.Text = "已在默认浏览器打开 Web IQ Profiles 页面，请生成并复制新 API Key。"
})

$btnPaste.Add_Click({
  try {
    $clip = [System.Windows.Forms.Clipboard]::GetText()
    if ($clip) {
      $txtKey.Text = $clip.Trim()
      $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
      $lblStatus.Text = "已从剪贴板粘贴（长度 " + $txtKey.Text.Length + " 字符），点击「验证并更新到 Magpie」生效。"
    }
  } catch {}
})

$btnClose.Add_Click({
  $form.Close()
})

$btnSave.Add_Click({
  $newKey = $txtKey.Text.Trim().Trim('"').Trim("'")
  if (-not $newKey) {
    $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
    $lblStatus.Text = "请先粘贴或输入新的 Microsoft Web IQ API Key。"
    return
  }
  $expDate = $txtExp.Text.Trim()
  if ($expDate -notmatch '^\\d{4}-\\d{2}-\\d{2}$') {
    $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
    $lblStatus.Text = "到期日格式需为 YYYY-MM-DD（例如 2027-01-17）。"
    return
  }

  $btnSave.Enabled = $false
  $btnPortal.Enabled = $false
  $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
  $lblStatus.Text = "正在向 Web IQ 验证新 Key 有效性..."
  $form.Refresh()

  try {
    $headers = @{ "content-type" = "application/json"; "accept" = "application/json" }
    if ($newKey -match '^Bearer\\s+' -or ($newKey.StartsWith("eyJ") -and ($newKey.Split(".").Count -eq 3))) {
      $headers["authorization"] = if ($newKey -match '^Bearer\\s+') { $newKey } else { "Bearer $newKey" }
    } else {
      $headers["x-apikey"] = $newKey
    }
    $probeBody = @{
      query = "Microsoft"
      maxResults = 1
      contentFormat = "passage"
      maxLength = 200
      safeSearch = "strict"
    } | ConvertTo-Json -Compress
    $null = Invoke-RestMethod -Method Post -Uri $cfg.endpoint -Headers $headers -Body $probeBody -TimeoutSec 15 -ErrorAction Stop
  } catch {
    $errMsg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      try {
        $ej = $_.ErrorDetails.Message | ConvertFrom-Json
        if ($ej.errorCode) { $errMsg = "[" + $ej.errorCode + "] " + $ej.userMessage }
      } catch {}
    }
    $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
    $lblStatus.Text = "Web IQ 验证未通过，未覆盖现有配置: " + $errMsg
    $btnSave.Enabled = $true
    $btnPortal.Enabled = $true
    return
  }

  $magpieExe = Find-MagpieExe
  if (-not $magpieExe) {
    $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
    $lblStatus.Text = "未找到本机 magpie.exe，请手动运行: magpie search add " + $cfg.vendorId + " <NEW_KEY>"
    $btnSave.Enabled = $true
    $btnPortal.Enabled = $true
    return
  }

  $tmpOut = [System.IO.Path]::GetTempFileName()
  $tmpErr = [System.IO.Path]::GetTempFileName()
  try {
    $proc = Start-Process -FilePath $magpieExe -ArgumentList @("search", "add", $cfg.vendorId, $newKey) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
    if ($proc.ExitCode -ne 0) {
      $errTxt = (Get-Content -LiteralPath $tmpErr -Raw -ErrorAction SilentlyContinue).Trim()
      $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
      $lblStatus.Text = "写入 Magpie 失败: " + $errTxt
      $btnSave.Enabled = $true
      $btnPortal.Enabled = $true
      return
    }
  } finally {
    Remove-Item -LiteralPath $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
  }

  try {
    $fp = Get-KeyFingerprint $newKey
    $st = @{ keys = @{}; activePopupUntil = 0 }
    if (Test-Path -LiteralPath $cfg.stateFile) {
      $loaded = Get-Content -LiteralPath $cfg.stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($loaded) { $st = $loaded }
    }
    if (-not $st.keys) {
      $st | Add-Member -NotePropertyName keys -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $rec = [pscustomobject]@{
      firstSeenAt = [DateTime]::UtcNow.ToString("o")
      expiresAt = $expDate
      lastWarnedAt = 0
      lastExpiredPopupAt = 0
    }
    $st.keys | Add-Member -NotePropertyName $fp -NotePropertyValue $rec -Force
    $st | Add-Member -NotePropertyName activePopupUntil -NotePropertyValue 0 -Force
    $parentDir = [System.IO.Path]::GetDirectoryName($cfg.stateFile)
    if (-not (Test-Path -LiteralPath $parentDir)) {
      New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($cfg.stateFile, ($st | ConvertTo-Json -Depth 6) + [Environment]::NewLine, $utf8NoBom)
  } catch {}

  [void][System.Windows.Forms.MessageBox]::Show(
    "新 API Key 已通过 Web IQ 验证并成功写入 Magpie，现已立即热生效！\`r\`n下次到期提醒基准日: " + $expDate,
    "Magpie · Web IQ 更新成功",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
  $form.Close()
})

$idleTimer = New-Object System.Windows.Forms.Timer
$idleTimer.Interval = if ([int]$cfg.autoCloseMs -gt 0) { [int]$cfg.autoCloseMs } else { 900000 }
$idleTimer.Add_Tick({
  $idleTimer.Stop()
  if ([int]$cfg.autoCloseMs -gt 0) {
    $magpieFound = [bool](Find-MagpieExe)
    [Console]::Out.WriteLine("SELFTEST_OK visible=" + $form.Visible + " magpieFound=" + $magpieFound + " vendor=" + $cfg.vendorId)
  }
  $form.Close()
})
$form.Add_Shown({ $idleTimer.Start() })
$form.Add_FormClosed({ Clear-PopupLock })

[void]$form.ShowDialog()
`;
}

export function launchRenewalPopup({
  mode = "expired",
  detail = "",
  expiresAt = "",
  endpoint = `${DEFAULT_BASE_URL}/search/web`,
  ttlDays = DEFAULT_KEY_TTL_DAYS,
  autoCloseMs = 0,
  wait = false,
} = {}) {
  if (process.platform !== "win32") {
    console.warn(
      `[webiq] API key ${mode} (${detail || expiresAt}). Renew at ${PROFILES_URL} and run: magpie search add ${VENDOR_ID} <NEW_KEY>`
    );
    return null;
  }

  const cfgJson = JSON.stringify({
    mode,
    detail,
    expiresAt,
    endpoint,
    profilesUrl: PROFILES_URL,
    vendorId: VENDOR_ID,
    stateFile: STATE_FILE,
    ttlDays,
    autoCloseMs,
  });

  const psScript = buildWindowsRenewalPopupScript(cfgJson);
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  const args = ["-NoProfile", "-Sta", "-EncodedCommand", encoded];

  if (wait) {
    return spawn("powershell.exe", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const child = spawn("powershell.exe", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

function maybeNotifyKeyLifecycle({
  secret,
  mode,
  detail,
  endpoint,
  popupEnabled,
  explicitExpires,
  ttlDays,
  warnDays,
}) {
  if (!secret || isBearerToken(secret)) return;
  const now = Date.now();
  const fp = keyFingerprint(secret);
  const state = readState();
  const { rec, dirty } = ensureKeyRecord(state, fp, explicitExpires, ttlDays);

  if (!popupEnabled) {
    if (dirty) writeState(state);
    return;
  }

  if (mode === "expired") {
    if (now > state.activePopupUntil && now - (rec.lastExpiredPopupAt || 0) >= EXPIRED_POPUP_COOLDOWN_MS) {
      rec.lastExpiredPopupAt = now;
      state.activePopupUntil = now + ACTIVE_POPUP_LOCK_MS;
      writeState(state);
      launchRenewalPopup({
        mode: "expired",
        detail,
        expiresAt: rec.expiresAt || "",
        endpoint,
        ttlDays,
      });
      return;
    }
    if (dirty) writeState(state);
    return;
  }

  // Proactive near-expiry check after normal search
  const expMs = parseEndOfDayLocalMs(rec.expiresAt);
  if (Number.isFinite(expMs)) {
    const daysLeft = Math.ceil((expMs - now) / 86_400_000);
    if (
      daysLeft <= warnDays &&
      now > state.activePopupUntil &&
      now - (rec.lastWarnedAt || 0) >= EXPIRING_WARN_COOLDOWN_MS
    ) {
      rec.lastWarnedAt = now;
      state.activePopupUntil = now + ACTIVE_POPUP_LOCK_MS;
      writeState(state);
      const remainLabel = daysLeft <= 0 ? "今天到期或已超期" : `剩余 ${daysLeft} 天`;
      launchRenewalPopup({
        mode: "expiring",
        detail: remainLabel,
        expiresAt: rec.expiresAt,
        endpoint,
        ttlDays,
      });
      return;
    }
  }

  if (dirty) writeState(state);
}

function stripHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRetryAfter(headerVal, bodyVal) {
  const raw = String(headerVal || bodyVal || "").trim();
  if (!raw) return "";
  // Web IQ throttled responses return durations like "60s"; HTTP Retry-After uses integer seconds or HTTP-date.
  const secMatch = /^(\d+(?:\.\d+)?)s$/i.exec(raw);
  if (secMatch) {
    return String(Math.max(1, Math.ceil(Number(secMatch[1]))));
  }
  return raw;
}

function isBearerToken(secret) {
  if (!secret) return false;
  if (/^bearer\s+/i.test(secret)) return true;
  // JWT format (Entra ID OAuth 2.0 access token): header.payload.signature
  const parts = secret.split(".");
  return parts.length === 3 && secret.startsWith("eyJ");
}

function buildEndpointAndOptions(rawUrl, usesApiKey) {
  const baseInput = String(rawUrl || "").trim() || DEFAULT_BASE_URL;
  const parsed = new URL(baseInput);

  // Optional local tuning via URL hash, e.g.:
  //   https://api.microsoft.ai/v3#contentFormat=passage&maxLength=3000&safeSearch=strict&language=en&region=US
  // Using hash keeps custom plugin options out of the upstream query string.
  const hashParams = new URLSearchParams(parsed.hash ? parsed.hash.slice(1) : "");
  parsed.hash = "";

  // Web IQ rejects API-key requests that carry an APPID query parameter (even empty) with 401 AuthUnauthorizedEntryId.
  if (usesApiKey && parsed.searchParams.has("APPID")) {
    parsed.searchParams.delete("APPID");
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") {
    pathname = "/v3/search/web";
  } else if (!pathname.endsWith("/search/web")) {
    pathname = `${pathname}/search/web`;
  }
  parsed.pathname = pathname;

  const formatRaw = (hashParams.get("contentFormat") || "passage").toLowerCase();
  const contentFormat = VALID_FORMATS.has(formatRaw) ? formatRaw : "passage";

  const defaultMaxLen = contentFormat === "passage" ? 3000 : 10000;
  const maxLenNum = Number(hashParams.get("maxLength"));
  const maxLength = Number.isFinite(maxLenNum) && maxLenNum >= 1
    ? Math.min(Math.floor(maxLenNum), 500000)
    : defaultMaxLen;

  const safeRaw = (hashParams.get("safeSearch") || "strict").toLowerCase();
  const safeSearch = VALID_SAFE_SEARCH.has(safeRaw) ? safeRaw : "strict";

  const language = (hashParams.get("language") || "").trim();
  const region = (hashParams.get("region") || "").trim();
  const scopeName = (hashParams.get("scopeName") || "").trim();

  const popupEnabled = (hashParams.get("popup") || "on").trim().toLowerCase() !== "off";
  const expiresRaw = (hashParams.get("expires") || "").trim();
  const explicitExpires = /^\d{4}-\d{2}-\d{2}$/.test(expiresRaw) ? expiresRaw : "";

  const ttlRaw = Number(hashParams.get("ttlDays"));
  const ttlDays = Number.isFinite(ttlRaw) && ttlRaw >= 1 && ttlRaw <= 365
    ? Math.floor(ttlRaw)
    : DEFAULT_KEY_TTL_DAYS;

  const warnRaw = Number(hashParams.get("warnDays"));
  const warnDays = Number.isFinite(warnRaw) && warnRaw >= 0 && warnRaw <= 60
    ? Math.floor(warnRaw)
    : DEFAULT_WARN_DAYS;

  return {
    endpoint: parsed.toString(),
    contentFormat,
    maxLength,
    safeSearch,
    language,
    region,
    scopeName,
    popupEnabled,
    explicitExpires,
    ttlDays,
    warnDays,
  };
}

export default async function microsoftWebIqPlugin() {
  return {
    search: {
      web: {
        name: "Microsoft Web IQ",
        keysURL: PROFILES_URL,
        async execute({ query, count, key, url }, ctx) {
          const trimmedQuery = String(query || "").trim().slice(0, 1000);
          if (!trimmedQuery) {
            return [];
          }

          const secret = String(key || "").trim();
          if (!secret) {
            throw Object.assign(
              new Error(`Microsoft Web IQ API key is missing; add it via \`magpie search add ${VENDOR_ID} <x-apikey>\``),
              { status: 401 }
            );
          }

          const bearer = isBearerToken(secret);
          const {
            endpoint,
            contentFormat,
            maxLength,
            safeSearch,
            language,
            region,
            scopeName,
            popupEnabled,
            explicitExpires,
            ttlDays,
            warnDays,
          } = buildEndpointAndOptions(url, !bearer);

          const maxResults = Math.min(Math.max(Number(count) || 6, 1), 50);

          const body = {
            query: trimmedQuery,
            maxResults,
            contentFormat,
            maxLength,
            safeSearch,
          };
          if (language) body.language = language;
          if (region) body.region = region;
          if (scopeName) body.scopeName = scopeName;

          const headers = {
            "content-type": "application/json",
            "accept": "application/json",
          };
          if (bearer) {
            headers["authorization"] = /^bearer\s+/i.test(secret) ? secret : `Bearer ${secret}`;
          } else {
            headers["x-apikey"] = secret;
          }

          const res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: ctx?.abort,
          });

          const rawText = await res.text();
          let data = null;
          if (rawText) {
            try {
              data = JSON.parse(rawText);
            } catch {}
          }

          if (!res.ok) {
            const code = data?.errorCode ? `[${data.errorCode}] ` : "";
            const msg = data?.userMessage || data?.message || rawText || `HTTP ${res.status}`;
            const details = data?.technicalDetails ? ` (${data.technicalDetails})` : "";
            const trace = data?.traceId ? ` [traceId: ${data.traceId}]` : "";
            const retryAfter = normalizeRetryAfter(res.headers.get("retry-after"), data?.retryAfter);

            if (res.status === 401) {
              maybeNotifyKeyLifecycle({
                secret,
                mode: "expired",
                detail: `${code}${msg}`.trim(),
                endpoint,
                popupEnabled,
                explicitExpires,
                ttlDays,
                warnDays,
              });
            }

            throw Object.assign(
              new Error(`Web IQ HTTP ${res.status}: ${code}${msg}${details}${trace}`),
              { status: res.status, retryAfter }
            );
          }

          maybeNotifyKeyLifecycle({
            secret,
            mode: "ok",
            detail: "",
            endpoint,
            popupEnabled,
            explicitExpires,
            ttlDays,
            warnDays,
          });

          const webResults = Array.isArray(data?.webResults) ? data.webResults : [];
          return webResults
            .filter((item) => item && typeof item === "object" && item.url)
            .map((item) => {
              const rawContent = typeof item.content === "string" ? item.content : "";
              const text = contentFormat === "html" ? stripHtml(rawContent) : rawContent;
              return {
                title: item.title || item.url,
                url: item.url,
                text,
                age: item.lastUpdatedAt || item.crawledAt || "",
              };
            });
        },
      },
    },
  };
}

// Standalone CLI helper:
//   bun ~/.config/magpie/webiq.js --popup       # Manually open the Windows renewal dialog
//   bun ~/.config/magpie/webiq.js --self-test   # Verify dialog rendering & magpie.exe discovery and auto-close
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(PLUGIN_FILE)) {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--self-test")) {
    const proc = launchRenewalPopup({
      mode: "expiring",
      detail: "自检模式（自动关闭）",
      expiresAt: addDaysYmd(DEFAULT_WARN_DAYS),
      autoCloseMs: 600,
      wait: true,
    });
    if (proc) {
      proc.stdout.on("data", (c) => process.stdout.write(c));
      proc.stderr.on("data", (c) => process.stderr.write(c));
      proc.on("exit", (code) => process.exit(code ?? 0));
    }
  } else if (flags.has("--popup")) {
    launchRenewalPopup({
      mode: "expiring",
      detail: "手动打开更新助手",
      expiresAt: addDaysYmd(DEFAULT_KEY_TTL_DAYS),
    });
  }
}
