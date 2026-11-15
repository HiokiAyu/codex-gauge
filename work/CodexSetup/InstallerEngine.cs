using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32;

namespace CodexSetup;

internal sealed class LegacyTargetRunningException:IOException {
 internal LegacyTargetRunningException():base("The target legacy dashboard must be closed before updating."){}
}
internal static class InstallerEngine {
 internal static string DefaultTarget=>Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
  "Programs","CodexUsageDashboard");
 internal static string? ExistingTarget(){
  try{
   using var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexUsageDashboard");
   var value=key?.GetValue("InstallLocation") as string;
   return !string.IsNullOrWhiteSpace(value)&&File.Exists(Path.Combine(value,"Codex大看板.exe"))?Path.GetFullPath(value):null;
  }catch(ArgumentException){return null;}catch(NotSupportedException){return null;}catch(PathTooLongException){return null;}
 }
 internal static Stream Resource(string name)=>Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
  ??throw new IOException("Installer resource missing");
 internal static JsonDocument Manifest(){using var stream=Resource("Manifest.json");return JsonDocument.Parse(stream);}

 static bool SafePath(string value)=>value.Length is >0 and <=240&&!value.Any(c=>c=='\\'||c==':'||c<32)
  &&value.Split('/').All(part=>part.Length>0&&part!="."&&part!=".."&&!part.EndsWith('.')&&!part.EndsWith(' ')
   &&!System.Text.RegularExpressions.Regex.IsMatch(part,@"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)",
    System.Text.RegularExpressions.RegexOptions.IgnoreCase));

 internal static void Extract(string destination){
  using var manifest=Manifest();
  var files=manifest.RootElement.GetProperty("files").EnumerateArray().ToDictionary(
   file=>file.GetProperty("path").GetString()!,file=>file.Clone(),StringComparer.OrdinalIgnoreCase);
  if(files.Count is 0 or >20000)throw new IOException("Invalid package manifest");
  var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  using var stream=Resource("Payload.zip");
  using var zip=new ZipArchive(stream,ZipArchiveMode.Read);
  long total=0;
  Directory.CreateDirectory(destination);
  foreach(var entry in zip.Entries){
   if(entry.FullName.EndsWith('/'))continue;
   if(!SafePath(entry.FullName)||!names.Add(entry.FullName)||!files.TryGetValue(entry.FullName,out var expected)
    ||((entry.ExternalAttributes>>16)&0xf000)==0xa000)throw new IOException("Invalid archive entry");
   var size=expected.GetProperty("bytes").GetInt64();
   total=checked(total+size);
   if(entry.Length!=size||total>2L*1024*1024*1024)throw new IOException("Invalid package size");
   var target=Path.Combine(destination,entry.FullName.Replace('/',Path.DirectorySeparatorChar));
   Directory.CreateDirectory(Path.GetDirectoryName(target)!);
   using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write))
   using(var input=entry.Open())input.CopyTo(output);
   using var check=File.OpenRead(target);
   var hash=Convert.ToHexString(SHA256.HashData(check));
   if(!hash.Equals(expected.GetProperty("sha256").GetString(),StringComparison.OrdinalIgnoreCase)){
    throw new IOException("Package verification failed");
   }
  }
  if(names.Count!=files.Count)throw new IOException("Incomplete package");
 }

 internal static Task Install(string target,IProgress<string>? progress=null,string? dataDirectory=null,bool integrate=true,bool? startup=null,bool? desktop=null)=>Task.Run(()=>{
  using var maintenance=new Mutex(false,@"Local\CodexUsageDashboard.maintenance.v1");
  bool locked;
  try{locked=maintenance.WaitOne(0);}catch(AbandonedMutexException){locked=true;}
  if(!locked)throw new IOException("Another installation is running");
  try{InstallCore(target,progress,dataDirectory,integrate,startup,desktop).GetAwaiter().GetResult();}
  finally{maintenance.ReleaseMutex();}
 });
 static async Task InstallCore(string target,IProgress<string>? progress,string? dataDirectory,bool integrate,bool? startup,bool? desktop){
  target=Path.TrimEndingDirectorySeparator(Path.GetFullPath(target));
  if(target==Path.GetPathRoot(target))throw new IOException("Invalid installation directory");
  var data=Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataDirectory??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexUsageDashboard")));
  if(string.Equals(target,data,StringComparison.OrdinalIgnoreCase)||target.StartsWith(data+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||data.StartsWith(target+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("INSTALL_PATH_OVERLAP");
  var existing=integrate?ExistingTarget():null;
  if(existing!=null&&!string.Equals(existing,target,StringComparison.OrdinalIgnoreCase))throw new IOException("EXISTING_INSTALL_ELSEWHERE");
  if(File.Exists(target))throw new IOException("INSTALL_PATH_FILE");
  if(Directory.Exists(target)){
   var folder=new DirectoryInfo(target);
   if(folder.Attributes.HasFlag(FileAttributes.ReparsePoint))throw new IOException("INSTALL_PATH_LINK");
   if(Directory.EnumerateFileSystemEntries(target).Any()&&!File.Exists(Path.Combine(target,"app-info.json")))throw new IOException("INSTALL_PATH_OCCUPIED");
  }
  using(var package=Manifest()){
   var size=package.RootElement.GetProperty("files").EnumerateArray().Sum(x=>x.GetProperty("bytes").GetInt64());
   var root=Path.GetPathRoot(target);
   if(!string.IsNullOrEmpty(root))try{var drive=new DriveInfo(root);if(drive.IsReady&&drive.AvailableFreeSpace<size*2+104857600L)throw new IOException("INSTALL_NO_SPACE");}
   catch(ArgumentException){}
  }
  var temporary=Path.Combine(Path.GetTempPath(),"CodexDashboard-setup-"+Guid.NewGuid().ToString("N"));
  Directory.CreateDirectory(temporary);
  try{
   progress?.Report("setupVerifying");
   var source=Path.Combine(temporary,"payload");
   Extract(source);
   var manifest=Path.Combine(temporary,"manifest.json");
   using(var input=Resource("Manifest.json"))using(var output=File.Create(manifest))input.CopyTo(output);
   var request=Path.Combine(temporary,"request.json");
   File.WriteAllText(request,JsonSerializer.Serialize(new {source,target,manifest,dataDirectory,integrate,startup,desktop}));
   var start=new ProcessStartInfo {
    FileName=Path.Combine(source,"runtime","node.exe"),UseShellExecute=false,CreateNoWindow=true,
    RedirectStandardOutput=true,RedirectStandardError=true,
    StandardOutputEncoding=System.Text.Encoding.UTF8,StandardErrorEncoding=System.Text.Encoding.UTF8
   };
   start.ArgumentList.Add(Path.Combine(source,"install-worker.js"));
   start.ArgumentList.Add(request);
   using var process=Process.Start(start)??throw new IOException("Installation worker did not start");
   var errors=process.StandardError.ReadToEndAsync();
   while(await process.StandardOutput.ReadLineAsync() is { } line){
    using var result=JsonDocument.Parse(line);
    var stage=result.RootElement.GetProperty("stage").GetString();
    progress?.Report(stage switch {"migration"=>"setupMigrating","activation"=>"setupInstalling",_=>"setupInstalling"});
   }
   await process.WaitForExitAsync();
   if(process.ExitCode!=0){
    var detail=(await errors).Trim();
    if(detail.Contains("TARGET_RUNNING_LEGACY",StringComparison.Ordinal))throw new LegacyTargetRunningException();
    throw new IOException("Installer worker "+process.ExitCode.ToString("X8")+": "+detail);
   }
   progress?.Report("setupComplete");
  }finally{
   TemporaryCleanup.TryDelete(temporary);
  }
 }
}
