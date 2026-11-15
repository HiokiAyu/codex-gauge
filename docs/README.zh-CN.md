<p align="center"><img src="../docs/assets/codex-gauge.png" width="128" alt="CodexGauge"></p>

<h1 align="center">CodexGauge · Codex 大看板</h1>
<p align="center">面向 Codex 订阅用户的 Windows 用量看板</p>
<p align="center"><a href="../README.md">English</a> · 简体中文 · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a></p>
<p align="center">
  <a href="https://github.com/HiokiAyu/codex-gauge/releases/tag/ota-preview"><strong>下载 Windows 预览版</strong></a> ·
  <a href="../CHANGELOG.md">版本历史</a> ·
  <a href="../CONTRIBUTING.md">构建与参与开发</a>
</p>

## 能看什么

- **周额度和重置时间。** 总览同时显示剩余额度、周期进度、今日实际变化及消耗估测。托盘和悬浮球可以查看剩余百分比。
- **会话和项目用量。** 按会话、模型、思考强度和速度查看输入、缓存和输出 Token，支持项目归类及 CSV 导出。
- **关窗后继续采集。** 工具留在托盘时会记录额度读数，并保存官方每日 Token 汇总发生修订时的前后数值。

CodexGauge 是独立的订阅用量工具，使用已登录的本机 Codex 客户端和会话日志。官方读数与会话额度估测分开显示，估测取决于日志覆盖和校准证据。日志与用量数据库留在本机。更新检查连接 GitHub，选开的重置消息会连接其列出的来源。

## 安装和使用

1. 打开发布页的 **Assets**，下载 Windows x64 安装包。需要在本机安装并登录 Codex。若缺少 Microsoft Edge WebView2，安装程序可补装。
2. 在 **总览** 查看周额度。右上角 **设置** 可切换语言、主题及会话目录。
3. 点 **×** 留在托盘，需彻底退出时使用托盘菜单。内置签名更新在 **设置 → 检查更新**。

当前是预览版，已在 Windows 11 x64 上验证。OTA 更新清单有签名，Windows 安装程序可能显示未签名发布者提示。

[反馈问题](https://github.com/HiokiAyu/codex-gauge/issues) · 公开反馈请省略会话日志、账户标识和凭据。

[MIT 许可证](../LICENSE)
