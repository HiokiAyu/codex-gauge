function Test-OwnedSigningCertificate {
 param([Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
 if(!$Certificate -or !$Certificate.HasPrivateKey -or $Certificate.NotBefore -gt (Get-Date) -or
  $Certificate.NotAfter -le (Get-Date)){return $false}
 $extension=$Certificate.Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.37'} | Select-Object -First 1
 return @($extension.EnhancedKeyUsages | Where-Object {$_.Value -eq '1.3.6.1.5.5.7.3.3'}).Count -gt 0
}
function Invoke-OwnedExecutableSigning {
 param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$CertificateThumbprint,
  [string]$SignToolPath,
  [string]$TimestampUrl
 )
 $ErrorActionPreference='Stop'
 $file=Get-Item -LiteralPath $Path
 if($file.Name -notin @('Codex大看板.exe','Codex大看板-安装.exe') -or
  ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.PSIsContainer){
  throw 'Only this project''s generated executable can be signed.'
 }
 if([string]::IsNullOrWhiteSpace($CertificateThumbprint)){
  return [ordered]@{status='not-requested';thumbprint=$null}
 }
 $thumbprint=$CertificateThumbprint.Replace(' ','').ToUpperInvariant()
 if($thumbprint -notmatch '^[A-F0-9]{40}$'){throw 'Specify a valid certificate thumbprint.'}
 $timestamp=$null
 if(![Uri]::TryCreate($TimestampUrl,[UriKind]::Absolute,[ref]$timestamp) -or
  $timestamp.Scheme -ne 'https' -or $timestamp.UserInfo){throw 'Specify a public HTTPS timestamp service.'}
 $certificate=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$thumbprint) -ErrorAction SilentlyContinue
 if(!$certificate){throw 'The code-signing certificate is not present in CurrentUser\My.'}
 if(!(Test-OwnedSigningCertificate -Certificate $certificate)){
  throw 'The certificate has no usable private key, is outside its validity period, or lacks code-signing usage.'
 }
 if(!$SignToolPath -or !(Test-Path -LiteralPath $SignToolPath -PathType Leaf)){
  throw 'Specify the Microsoft SDK SignTool executable.'
 }
 $tool=Get-Item -LiteralPath $SignToolPath
 if(($tool.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $tool.Name -ne 'signtool.exe'){
  throw 'Unexpected signing tool.'
 }
 $trustedTool=Get-AuthenticodeSignature -LiteralPath $tool.FullName
 if($trustedTool.Status -ne 'Valid' -or $trustedTool.SignerCertificate.Subject -notlike '*Microsoft*'){
  throw 'The Microsoft signing tool could not be verified.'
 }
 $output=& $tool.FullName sign /q /fd SHA256 /sha1 $thumbprint /tr $timestamp.AbsoluteUri /td SHA256 $file.FullName 2>&1
 if($LASTEXITCODE -ne 0){throw "Authenticode signing failed (exit $LASTEXITCODE)."}
 $output=& $tool.FullName verify /q /pa /tw $file.FullName 2>&1
 if($LASTEXITCODE -ne 0){throw "Authenticode policy verification failed (exit $LASTEXITCODE)."}
 $signature=Get-AuthenticodeSignature -LiteralPath $file.FullName
 if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumbprint -or
  !$signature.TimeStamperCertificate){throw 'The resulting signature or timestamp did not verify.'}
 return [ordered]@{status='valid';thumbprint=$thumbprint;timestamped=$true}
}
