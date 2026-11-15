param(
 [string]$OutputName='Codex大看板-v1.0开发测试安装.exe',
 [string]$DotnetPath,
 [string]$RuntimeDirectory,
 [switch]$OfflineWebView,
 [string]$CertificateThumbprint,
 [string]$SignToolPath,
 [string]$TimestampUrl
)
$ErrorActionPreference='Stop'
$workRoot=$PSScriptRoot
. (Join-Path $workRoot 'sign-owned-executable.ps1')
$signing=@{CertificateThumbprint=$CertificateThumbprint;SignToolPath=$SignToolPath;TimestampUrl=$TimestampUrl}
$sdk=if($DotnetPath){(Resolve-Path -LiteralPath $DotnetPath).Path}else{(Get-Command dotnet -ErrorAction Stop).Source}
$publish=Join-Path $workRoot 'v1-publish'
$project=Join-Path $workRoot 'CodexDashboard/CodexDashboard.csproj'
$runtime=if($RuntimeDirectory){(Resolve-Path -LiteralPath $RuntimeDirectory).Path}else{Join-Path $workRoot 'release-tools/runtime'}
$node=Join-Path $runtime 'node.exe'
if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne 'D702DAA815EABBFF763C7D3808E235CF031CF2CA70211B56847BC72F51E240E5'){
 throw 'Official Node v24.22.1 checksum mismatch.'
}
$sourceFingerprint=(& $node (Join-Path $workRoot 'source-fingerprint.cjs')).Trim()
$regression=Get-Content -LiteralPath (Join-Path $workRoot 'v1-regression-results.json') -Raw | ConvertFrom-Json
if(!$regression.sourceUnchanged -or $regression.passed -ne $regression.total -or $regression.total -lt 1 -or $regression.sourceHash -ne $sourceFingerprint){
 throw 'Run the full regression suite for the current source before packaging.'
}
$bootstrap=Join-Path $runtime 'MicrosoftEdgeWebview2Setup.exe'
$signature=Get-AuthenticodeSignature -LiteralPath $bootstrap
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Microsoft Corporation*'){
 throw 'WebView2 bootstrap signature mismatch.'
}
$standalone=Join-Path $runtime 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
if($OfflineWebView){
 $signature=Get-AuthenticodeSignature -LiteralPath $standalone
 if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Microsoft Corporation*'){
  throw 'Offline WebView2 installer signature mismatch.'
 }
}
if(Test-Path -LiteralPath $publish){
 $resolved=(Get-Item -LiteralPath $publish).FullName
 if((Split-Path -Parent $resolved) -ne $workRoot -or (Split-Path -Leaf $resolved) -ne 'v1-publish'){
  throw 'Publish cleanup target is outside its workspace directory.'
 }
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_NOLOGO='1'
& $sdk publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=None -o $publish -v quiet
if($LASTEXITCODE -ne 0){throw 'Application publish failed.'}
foreach($file in Get-ChildItem -LiteralPath $publish -File){
 if($file.Extension -in @('.xml','.pdb')){Remove-Item -LiteralPath $file.FullName -Force}
}
$bundledRuntime=New-Item -ItemType Directory -Path (Join-Path $publish 'runtime') -Force
Copy-Item -LiteralPath $node -Destination $bundledRuntime.FullName
$dependencies=New-Item -ItemType Directory -Path (Join-Path $publish 'setup-dependencies') -Force
Copy-Item -LiteralPath $bootstrap -Destination $dependencies.FullName
if($OfflineWebView){Copy-Item -LiteralPath $standalone -Destination $dependencies.FullName}
$licenses=New-Item -ItemType Directory -Path (Join-Path $publish 'licenses') -Force
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $workRoot) 'LICENSE') -Destination (Join-Path $licenses.FullName 'LICENSE-CodexGauge.txt')
foreach($name in @('使用说明.txt','版本说明.txt')){
 Copy-Item -LiteralPath (Join-Path $workRoot "CodexDashboard/$name") -Destination $publish
}
Copy-Item -LiteralPath (Join-Path $runtime 'LICENSE-node.txt') -Destination $licenses.FullName
$nuget=Join-Path $env:USERPROFILE '.nuget/packages'
Copy-Item -LiteralPath (Join-Path $nuget 'microsoft.netcore.app.runtime.win-x64/10.0.15/LICENSE.TXT') -Destination (Join-Path $licenses.FullName 'LICENSE-dotnet.txt')
Copy-Item -LiteralPath (Join-Path $nuget 'microsoft.netcore.app.runtime.win-x64/10.0.15/THIRD-PARTY-NOTICES.TXT') -Destination (Join-Path $licenses.FullName 'NOTICES-dotnet.txt')
Copy-Item -LiteralPath (Join-Path $nuget 'microsoft.web.webview2/1.0.4314.35/LICENSE.txt') -Destination (Join-Path $licenses.FullName 'LICENSE-webview2.txt')
Copy-Item -LiteralPath (Join-Path $nuget 'microsoft.web.webview2/1.0.4314.35/NOTICE.txt') -Destination (Join-Path $licenses.FullName 'NOTICE-webview2.txt')
$applicationSigning=Invoke-OwnedExecutableSigning -Path (Join-Path $publish 'Codex大看板.exe') @signing
$info=Get-Content -LiteralPath (Join-Path $publish 'app-info.json') -Raw | ConvertFrom-Json
foreach($file in Get-ChildItem -LiteralPath $publish -File -Recurse){
 if($file.Name -in @('value-reference.json','auth.json','preferences.json') -or $file.Extension -in @('.sqlite','.jsonl')){
  throw "Private data file in publish output: $($file.Name)"
 }
 if($file.Extension -in @('.js','.json','.html','.css','.txt')){
  $content=[IO.File]::ReadAllText($file.FullName).Replace([char]92,[char]'/').ToLowerInvariant()
  foreach($prefix in @($env:USERPROFILE,(Split-Path -Parent $workRoot))){
   $normalized=$prefix.Replace([char]92,[char]'/').ToLowerInvariant()
   if($content.Contains($normalized)){throw "Local path found in publish output: $($file.Name)"}
  }
 }
}
$files=Get-ChildItem -LiteralPath $publish -File -Recurse | Sort-Object FullName | ForEach-Object {
 [ordered]@{
  path=[IO.Path]::GetRelativePath($publish,$_.FullName).Replace([IO.Path]::DirectorySeparatorChar,[char]'/')
  bytes=$_.Length
  sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
 }
}
$manifest=[ordered]@{
 schema=1
 application=$info.name
 version=$info.version
 platform='win-x64'
 channel=$info.channel
 files=@($files)
}
$manifestPath=Join-Path $workRoot 'v1-package-manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
$zip=Join-Path $workRoot 'v1-payload.zip'
if(Test-Path -LiteralPath $zip){Remove-Item -LiteralPath $zip -Force}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($publish,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$setup=Join-Path $workRoot 'v1-setup'
& $sdk publish (Join-Path $workRoot 'CodexSetup/CodexSetup.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=None "-p:PayloadZip=$zip" "-p:PayloadManifest=$manifestPath" -o $setup -v quiet
if($LASTEXITCODE -ne 0){throw 'Installer publish failed.'}
$installerSigning=Invoke-OwnedExecutableSigning -Path (Join-Path $setup 'Codex大看板-安装.exe') @signing
$outputs=Join-Path (Split-Path -Parent $workRoot) 'outputs'
New-Item -ItemType Directory -Path $outputs -Force | Out-Null
if([IO.Path]::GetFileName($OutputName) -ne $OutputName){throw 'OutputName must be a filename.'}
$destination=Join-Path $outputs $OutputName
if((& $node (Join-Path $workRoot 'source-fingerprint.cjs')).Trim() -ne $sourceFingerprint){
 throw 'Source changed during packaging; do not use this installer.'
}
$temporaryDestination=$destination+'.tmp'
Copy-Item -LiteralPath (Join-Path $setup 'Codex大看板-安装.exe') -Destination $temporaryDestination -Force
[IO.File]::Move($temporaryDestination,$destination,$true)
[ordered]@{
 builtAt=[DateTimeOffset]::UtcNow.ToString('o')
 sourceHash=$sourceFingerprint
 version=$info.version
 regressionPassed=$regression.passed
 regressionTotal=$regression.total
 regressionAt=$regression.at
 installerSha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
 payloadManifestSha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
 offlineWebView=[bool]$OfflineWebView
 signing=[ordered]@{application=$applicationSigning;installer=$installerSigning}
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $workRoot 'v1-build-evidence.json') -Encoding utf8NoBOM
Get-Item -LiteralPath $destination | Select-Object FullName,Length
