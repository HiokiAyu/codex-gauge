<p align="center"><img src="../docs/assets/codex-gauge.png" width="128" alt="CodexGauge"></p>

<h1 align="center">CodexGauge</h1>
<p align="center">Codex サブスクリプションの使用量を確認する Windows ダッシュボード</p>
<p align="center"><a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · 日本語</p>
<p align="center">
  <a href="https://github.com/HiokiAyu/codex-gauge/releases/tag/ota-preview"><strong>Windows プレビュー版をダウンロード</strong></a> ·
  <a href="../CHANGELOG.md">変更履歴</a> ·
  <a href="../CONTRIBUTING.md">ビルドと開発への参加</a>
</p>

## 主な機能

- **週間使用枠とリセット時刻。** 使用枠、周期の経過、今日の実測値と推定値を確認できます。残りの割合はシステムトレイやフローティング表示でも確認できます。
- **会話とプロジェクトごとの集計。** モデル、推論強度、処理速度ごとに入力、キャッシュ、出力の Token を表示し、プロジェクト別に CSV へ出力できます。
- **バックグラウンド収集。** ウィンドウを閉じたあともトレイで使用枠を取得し、公式の日次集計とその修正履歴を保存します。

CodexGauge はログイン済みのローカル Codex クライアントと会話ログを使う独立したツールです。公式の使用枠と会話ごとの推定値を分けて表示します。推定値はログの範囲と校正データに依存します。ログと使用量データベースは端末内に保存されます。更新確認は GitHub に接続し、オプションのリセット情報は表示された提供元に接続します。

## インストール

1. リリースの **Assets** から Windows x64 インストーラーをダウンロードし、ローカルの Codex にログインしてください。Microsoft Edge WebView2 が未導入の場合はインストーラーから導入できます。
2. **概要**で週間使用枠を確認できます。右上の**設定**で言語、テーマ、会話データの保存先を切り替えられます。
3. **×** でシステムトレイに格納できます。終了するにはトレイのメニューを使い、更新するには **設定 → 更新を確認** を開きます。

Windows 11 x64 で動作確認したプレビュー版です。OTA の更新情報には署名があります。Windows のインストーラーに未署名の発行元に関する警告が表示される場合があります。

[問題を報告する](https://github.com/HiokiAyu/codex-gauge/issues) · 公開の報告に会話ログ、アカウント識別子、認証情報を含めないでください。

[MIT ライセンス](../LICENSE)
