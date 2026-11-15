<p align="center"><img src="../docs/assets/codex-gauge.png" width="128" alt="CodexGauge"></p>

<h1 align="center">CodexGauge · Codex 用量面板</h1>
<p align="center">為 Codex 訂閱使用者設計的 Windows 用量面板</p>
<p align="center"><a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 繁體中文 · <a href="README.ja.md">日本語</a></p>
<p align="center">
  <a href="https://github.com/HiokiAyu/codex-gauge/releases/tag/ota-preview"><strong>下載 Windows 預覽版</strong></a> ·
  <a href="../CHANGELOG.md">版本歷史</a> ·
  <a href="../CONTRIBUTING.md">建置與參與開發</a>
</p>

## 主要功能

- **每週額度與重設時間。** 在總覽查看剩餘額度、週期進度、今日實際變化及估測。系統匣和浮動球也可顯示剩餘百分比。
- **對話與專案用量。** 依對話、模型、推理強度和速度查看輸入、快取與輸出 Token，可依專案分類並匯出 CSV。
- **關閉視窗後持續擷取。** 工具留在系統匣時會擷取額度讀數，保存官方每日 Token 彙總及後續修訂。

CodexGauge 是獨立的訂閱用量工具，使用已登入的本機 Codex 客戶端和對話日誌。官方讀數與對話額度估測分開顯示，估測取決於記錄範圍與校準證據。日誌與用量資料庫存放於本機。更新檢查連線至 GitHub，選用的重設消息會讀取列出的來源。

## 安裝與使用

1. 在發佈頁的 **Assets** 下載 Windows x64 安裝程式，並登入本機 Codex。若缺少 Microsoft Edge WebView2，安裝程式可補裝。
2. 在 **總覽** 查看每週額度，使用 **設定** 切換語言、外觀或對話資料目錄。
3. 按 **×** 留在系統匣，完全結束可使用系統匣選單。透過 **設定 → 檢查更新** 取得簽署的預覽更新。

目前是預覽版，已在 Windows 11 x64 驗證。OTA 更新資訊有簽章，Windows 安裝程式可能顯示未簽署發行者的提示。

[回報問題](https://github.com/HiokiAyu/codex-gauge/issues) · 公開回報時請省略對話日誌、帳戶識別資料與憑證。

[MIT 授權條款](../LICENSE)
