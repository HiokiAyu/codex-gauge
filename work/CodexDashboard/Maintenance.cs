using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace CodexDashboard;

internal static class Maintenance {
 const string ApplicationName="CodexUsageDashboard";
 const string UninstallKey=@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexUsageDashboard";
 const string RunKey=@"Software\Microsoft\Windows\CurrentVersion\Run";
 static string? uninstallTarget;
 static string Target=>uninstallTarget??Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);
 static string Shortcut=>Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Codex 用量.lnk");
 static string DesktopShortcut=>Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Codex 用量.lnk");
 static string Executable=>Path.Combine(Target,"Codex大看板.exe");
 static string Quote(string value)=>"'"+value.Replace("'","''")+"'";

 static Dictionary<string,string> Strings(){
  var language="en";
  try{
   using var prefs=JsonDocument.Parse(File.ReadAllText(Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),ApplicationName,"preferences.json")));
   language=prefs.RootElement.GetProperty("language").GetString()??language;
  }catch{
   var culture=System.Globalization.CultureInfo.CurrentUICulture.Name;
   if(culture.StartsWith("zh"))language=culture.Contains("TW")||culture.Contains("HK")?"zh-TW":"zh-CN";
   else if(culture.StartsWith("ja"))language="ja";
  }
  if(!new[]{"en","ja","zh-CN","zh-TW"}.Contains(language))language="en";
  using var catalog=JsonDocument.Parse(File.ReadAllText(Path.Combine(Target,"locales",language+".json")));
  return catalog.RootElement.GetProperty("strings").EnumerateObject()
   .ToDictionary(property=>property.Name,property=>property.Value.GetString()??property.Name);
 }

 static void CheckIdentity(){
  using var identity=JsonDocument.Parse(File.ReadAllText(Path.Combine(Target,"app-info.json")));
  if(identity.RootElement.GetProperty("name").GetString()!=ApplicationName
   ||new DirectoryInfo(Target).Attributes.HasFlag(FileAttributes.ReparsePoint))throw new IOException("Unrecognized installation");
 }

 internal static void Register(bool? startupOption=null,bool? desktopOption=null){
  CheckIdentity();
  using var info=JsonDocument.Parse(File.ReadAllText(Path.Combine(Target,"app-info.json")));
  ShellIntegration.Register(Registry.CurrentUser,UninstallKey,RunKey,Shortcut,DesktopShortcut,Target,
   Strings().GetValueOrDefault("app","Codex Usage"),info.RootElement.GetProperty("version").GetString()??"1.0.0",startupOption,desktopOption);
 }
 internal static void ReportFailure(Exception error){
  var folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),ApplicationName);
  try{
   Directory.CreateDirectory(folder);
   File.WriteAllText(Path.Combine(folder,"maintenance-error.json"),
    JsonSerializer.Serialize(new {at=DateTimeOffset.UtcNow,error=error.Message}));
  }catch{}
  var strings=Strings();
  MessageBox.Show(strings["uninstallFailed"],strings["uninstallTitle"],MessageBoxButtons.OK,MessageBoxIcon.Warning);
 }

 static void Unregister(){
  using(var key=Registry.CurrentUser.OpenSubKey(UninstallKey)){
   if(string.Equals(key?.GetValue("InstallLocation") as string,Target,StringComparison.OrdinalIgnoreCase)){
    key!.Close();
    Registry.CurrentUser.DeleteSubKeyTree(UninstallKey,false);
   }
  }
  using(var startup=Registry.CurrentUser.OpenSubKey(RunKey,true)){
   if(startup?.GetValue(ApplicationName) is string value&&value.StartsWith("\""+Executable+"\"",StringComparison.OrdinalIgnoreCase)){
    startup.DeleteValue(ApplicationName,false);
   }
  }
  foreach(var shortcut in new[]{Shortcut,DesktopShortcut})if(ShellIntegration.PointsTo(shortcut,Executable))File.Delete(shortcut);
 }

 internal static void StartUninstall(bool silent,string? resultFile){
  CheckIdentity();
  var strings=Strings();
  if(!silent&&MessageBox.Show(strings["uninstallPrompt"],strings["uninstallTitle"],MessageBoxButtons.YesNo,
   MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)!=DialogResult.Yes){
   if(resultFile!=null)File.WriteAllText(resultFile,JsonSerializer.Serialize(new {success=true,cancelled=true}));
   return;
  }
  bool removeData=false;
  if(!silent){
   var choice=MessageBox.Show(strings["uninstallDataChoice"],strings["uninstallTitle"],MessageBoxButtons.YesNoCancel,
    MessageBoxIcon.Question,MessageBoxDefaultButton.Button2);
   if(choice==DialogResult.Cancel){if(resultFile!=null)File.WriteAllText(resultFile,JsonSerializer.Serialize(new {success=true,cancelled=true}));return;}
   if(choice==DialogResult.Yes){
    if(MessageBox.Show(strings["uninstallDataConfirm"],strings["uninstallTitle"],MessageBoxButtons.YesNo,
     MessageBoxIcon.Warning,MessageBoxDefaultButton.Button2)!=DialogResult.Yes){if(resultFile!=null)File.WriteAllText(resultFile,JsonSerializer.Serialize(new {success=true,cancelled=true}));return;}
    removeData=true;
   }
  }
  var helper=Path.Combine(Path.GetTempPath(),"CodexUsageDashboard-maintenance-"+Guid.NewGuid().ToString("N"));
  Directory.CreateDirectory(helper);
  try{
   File.Copy(Executable,Path.Combine(helper,"maintenance.exe"));
   File.Copy(Path.Combine(Target,"app-info.json"),Path.Combine(helper,"app-info.json"));
   var command=new ProcessStartInfo {
    FileName=Path.Combine(helper,"maintenance.exe"),UseShellExecute=false,CreateNoWindow=true
   };
   foreach(var arg in new[]{"--uninstall-worker","--target",Target,"--parent",Environment.ProcessId.ToString()}){
    command.ArgumentList.Add(arg);
   }
   if(silent)command.ArgumentList.Add("--silent");
   if(removeData)command.ArgumentList.Add("--remove-local-data");
   if(resultFile!=null){command.ArgumentList.Add("--result");command.ArgumentList.Add(resultFile);}
   using var process=Process.Start(command)??throw new IOException("Uninstall helper did not start");
  }catch{
   Directory.Delete(helper,true);
   throw;
  }
 }

 internal static int UninstallWorker(string target,int parentProcessId,bool silent,bool removeData){
  using var maintenance=new Mutex(false,@"Local\CodexUsageDashboard.maintenance.v1");
  bool locked;
  try{locked=maintenance.WaitOne(0);}catch(AbandonedMutexException){locked=true;}
  if(!locked)throw new IOException("Another installation or restore is running");
  try{return UninstallCore(target,parentProcessId,silent,removeData);}
  finally{maintenance.ReleaseMutex();}
 }
 static int UninstallCore(string target,int parentProcessId,bool silent,bool removeData){
  uninstallTarget=Path.TrimEndingDirectorySeparator(Path.GetFullPath(target));
  CheckIdentity();
  var strings=Strings();
  try{
   using var parentProcess=Process.GetProcessById(parentProcessId);
   if(!parentProcess.WaitForExit(20000))throw new IOException("Uninstall launcher did not exit");
  }catch(ArgumentException){}
  TargetShutdown.Request(Executable);
  // Prevent a new dashboard instance from reopening the shared data folder
  // while the user-approved removal is in progress.
  using var dataGuard=removeData?UninstallData.AcquireApplicationLock():null;
  var dataRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),ApplicationName);
  var dataParent=Path.GetDirectoryName(dataRoot)??throw new IOException("Invalid data directory");
  var dataTrash=Path.Combine(dataParent,"CodexUsageDashboard-uninstall-data-"+Guid.NewGuid().ToString("N"));
  if(removeData){
   var processes=Process.GetProcessesByName("Codex大看板");
   try{if(processes.Any(p=>p.Id!=Environment.ProcessId))throw new IOException("Close all dashboard instances before removing local data");}
   finally{foreach(var p in processes)p.Dispose();}
   UninstallData.Validate(dataRoot,dataTrash,Target);
  }
  var parent=Path.GetDirectoryName(Target)??throw new IOException("Invalid installation directory");
  var trash=Path.Combine(parent,"CodexUsageDashboard-uninstall-"+Guid.NewGuid().ToString("N"));
  var moved=new List<(string Original,string Temporary)>();
  using var registration=Registry.CurrentUser.OpenSubKey(UninstallKey);
  var registered=string.Equals(registration?.GetValue("InstallLocation") as string,Target,StringComparison.OrdinalIgnoreCase);
  registration?.Close();
  using var startup=Registry.CurrentUser.OpenSubKey(RunKey);
  var startupBefore=startup?.GetValue(ApplicationName) as string;
  startup?.Close();
  var menuBefore=ShellIntegration.PointsTo(Shortcut,Executable)?File.ReadAllBytes(Shortcut):null;
  var desktopBefore=ShellIntegration.PointsTo(DesktopShortcut,Executable)?File.ReadAllBytes(DesktopShortcut):null;
  var script=$$"""
   $ErrorActionPreference='Stop'
   Wait-Process -Id {{Environment.ProcessId}} -ErrorAction SilentlyContinue
   $candidate=[IO.Path]::GetFullPath({{Quote(trash)}})
   $base=[IO.Path]::GetFullPath({{Quote(parent)}})
   if(![string]::Equals([IO.Path]::GetDirectoryName($candidate),$base,[StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFileName($candidate).StartsWith('CodexUsageDashboard-uninstall-')){throw 'Invalid cleanup path'}
   $item=Get-Item -LiteralPath $candidate
   if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Cleanup link rejected'}
   $identity=Get-Content -LiteralPath (Join-Path $candidate 'app-info.json') -Raw|ConvertFrom-Json
   if($identity.name -ne 'CodexUsageDashboard'){throw 'Cleanup identity mismatch'}
   [IO.Directory]::Delete($candidate,$true)
   $helper=[IO.Path]::GetFullPath({{Quote(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory))}})
   $temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
   if(![string]::Equals([IO.Path]::GetDirectoryName($helper),$temporary,[StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFileName($helper).StartsWith('CodexUsageDashboard-maintenance-')){throw 'Invalid helper cleanup path'}
   $item=Get-Item -LiteralPath $helper
   if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Helper link rejected'}
   [IO.Directory]::Delete($helper,$true)
   """;
  var command=new ProcessStartInfo{
   FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"),
   UseShellExecute=false,CreateNoWindow=true
  };
  foreach(var argument in new[]{"-NoProfile","-NonInteractive","-WindowStyle","Hidden","-EncodedCommand",Convert.ToBase64String(Encoding.Unicode.GetBytes(script))}){
   command.ArgumentList.Add(argument);
  }
  try{
   Directory.Move(Target,trash);
   moved.Add((Target,trash));
   if(removeData&&Directory.Exists(dataRoot)){Directory.Move(dataRoot,dataTrash);moved.Add((dataRoot,dataTrash));}
   foreach(var suffix in new[]{".rollback",".failed"}){
    var extra=Target+suffix;
    if(!Directory.Exists(extra)||new DirectoryInfo(extra).Attributes.HasFlag(FileAttributes.ReparsePoint))continue;
    var identity=Path.Combine(extra,"app-info.json");
    if(!File.Exists(identity))continue;
    using var info=JsonDocument.Parse(File.ReadAllText(identity));
    if(info.RootElement.GetProperty("name").GetString()!=ApplicationName)continue;
    var destination=Path.Combine(trash,suffix[1..]);
    Directory.Move(extra,destination);
    moved.Add((extra,destination));
   }
   Unregister();
   if(removeData)UninstallData.DeleteStaged(dataRoot,dataTrash);
   using var cleanup=Process.Start(command)??throw new IOException("Uninstall cleanup did not start");
  }catch{
   foreach(var folder in moved.AsEnumerable().Reverse()){
    if(Directory.Exists(folder.Temporary)&&!Directory.Exists(folder.Original))Directory.Move(folder.Temporary,folder.Original);
   }
   if(registered)Register();
   if(menuBefore!=null)File.WriteAllBytes(Shortcut,menuBefore);
   if(desktopBefore!=null)File.WriteAllBytes(DesktopShortcut,desktopBefore);
   if(startupBefore?.StartsWith("\""+Executable+"\"",StringComparison.OrdinalIgnoreCase)==true){
    using var restore=Registry.CurrentUser.CreateSubKey(RunKey);
    restore?.SetValue(ApplicationName,startupBefore,RegistryValueKind.String);
   }
   throw;
  }
  if(!silent)MessageBox.Show(strings[removeData?"uninstallCompleteData":"uninstallComplete"],strings["uninstallTitle"],MessageBoxButtons.OK,MessageBoxIcon.Information);
  return 0;
 }
}
