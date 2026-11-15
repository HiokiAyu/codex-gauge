# Build and contribute

CodexGauge uses a .NET 10 WinForms host, WebView2, and a Node.js backend. The application is in `work/CodexDashboard` and the Windows installer is in `work/CodexSetup`.

## Run tests

Use Node.js 24.22.1 from the [official Windows x64 distribution](https://nodejs.org/dist/v24.22.1/). The public regression suite uses synthetic data and runs with temporary local settings.

```powershell
node .\work\run-regression.cjs
```

## Build a Windows x64 installer

Use PowerShell 7 and the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0). In a directory of your choice, stage `node.exe` and the Node distribution's `LICENSE` renamed to `LICENSE-node.txt`. Add Microsoft's [Evergreen WebView2 bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/) as `MicrosoftEdgeWebview2Setup.exe`. The build checks the Node executable hash and the WebView2 bootstrapper signature.

Run the regression suite, then run the installer build from the repository root.

```powershell
.\work\build-release.ps1 -RuntimeDirectory 'C:\path\to\runtime' -OutputName CodexGauge-Setup.exe
```

The installer is written to `outputs/`. To build without an installer, use `dotnet build .\work\CodexDashboard\CodexDashboard.csproj`.

## Update channel

The official preview uses the public key shipped in `work/CodexDashboard/update-source.json` and the `ota-preview` GitHub Release. Disable that provider or configure your own repository and key when distributing a fork. The release helper in `work/release-kit.cjs` creates a signed manifest and validates the build evidence. Keep signing keys and any passphrases outside the repository. Bundled Node.js, .NET, and WebView2 notices are included in the installer.

## Reports and contributions

For a bug report, include the app version, the Windows version, and reproduction steps. Use synthetic fixtures for parser and reconciliation tests. Update all four files in `work/CodexDashboard/locales/` when adding interface strings. Open a pull request with the relevant tests and a changelog entry.
