<p align="center"><img src="docs/assets/codex-gauge.png" width="128" alt="CodexGauge"></p>

<h1 align="center">CodexGauge</h1>
<p align="center">A Windows dashboard for Codex subscription usage</p>
<p align="center">English · <a href="docs/README.zh-CN.md">简体中文</a> · <a href="docs/README.zh-TW.md">繁體中文</a> · <a href="docs/README.ja.md">日本語</a></p>
<p align="center">
  <a href="https://github.com/HiokiAyu/codex-gauge/releases/tag/ota-preview"><strong>Download Windows preview</strong></a> ·
  <a href="CHANGELOG.md">Version history</a> ·
  <a href="CONTRIBUTING.md">Build and contribute</a>
</p>

## What it tracks

- **Weekly quota and reset.** Check remaining quota, cycle progress, and today's observed change and estimated usage. The tray and floating gauge show your remaining percentage.
- **Conversations and projects.** Break down input, cached input, and output tokens by conversation, model, reasoning effort, and service tier. Group work by project and export it as CSV.
- **Background collection.** Close the window to keep collecting in the Windows tray. CodexGauge saves official daily totals and records later revisions.

CodexGauge is an independent tool for Codex subscription accounts. It uses the local signed-in Codex client and session logs. Account readings and per-conversation estimates are shown separately. Estimates depend on available logs and calibration evidence. Logs and the usage database stay on the device. Update checks contact GitHub, and optional reset news contacts the listed sources.

## Install and use

1. Download the Windows x64 installer under **Assets** on the preview release page. A local Codex installation with an active sign-in is required. The installer can install Microsoft Edge WebView2 if needed.
2. Open **Overview** to check weekly quota. Use **Settings** to change the language, theme, or local session directory.
3. Click **×** to keep collection running in the tray. Use the tray menu to exit or **Settings → Check for updates** for signed preview updates.

The preview was tested on Windows 11 x64. OTA manifests are signed. Windows may show an unsigned-publisher prompt for the installer.

[Report issues](https://github.com/HiokiAyu/codex-gauge/issues) · Omit session logs, account identifiers, and credentials in public reports.

[MIT License](LICENSE)
