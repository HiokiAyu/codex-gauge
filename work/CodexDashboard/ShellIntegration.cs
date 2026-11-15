using Microsoft.Win32;
using System.Runtime.InteropServices;

namespace CodexDashboard;
internal static class ShellIntegration {
 const string AppName="CodexUsageDashboard";
 internal static bool PointsTo(string shortcut,string target){
  if(!File.Exists(shortcut))return false;object? shell=null,link=null;
  try{shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!);dynamic s=shell!;link=s.CreateShortcut(shortcut);dynamic l=link!;return string.Equals((string)l.TargetPath,target,StringComparison.OrdinalIgnoreCase);}
  finally{if(link!=null)Marshal.FinalReleaseComObject(link);if(shell!=null)Marshal.FinalReleaseComObject(shell);}
 }
 static void SaveShortcut(string shortcut,string executable,string target){
  Directory.CreateDirectory(Path.GetDirectoryName(shortcut)!);object? shell=null,link=null;
  try{shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!);dynamic s=shell!;link=s.CreateShortcut(shortcut);dynamic l=link!;l.TargetPath=executable;l.WorkingDirectory=target;l.IconLocation=executable+",0";l.Save();}
  finally{if(link!=null)Marshal.FinalReleaseComObject(link);if(shell!=null)Marshal.FinalReleaseComObject(shell);}
 }
 static (object? Value,RegistryValueKind Kind,bool Exists) ReadValue(RegistryKey? key,string name){
  if(key==null||!key.GetValueNames().Contains(name,StringComparer.OrdinalIgnoreCase))return (null,RegistryValueKind.None,false);
  return (key.GetValue(name,null,RegistryValueOptions.DoNotExpandEnvironmentNames),key.GetValueKind(name),true);
 }
 static void RestoreValue(RegistryKey key,string name,(object? Value,RegistryValueKind Kind,bool Exists) old){
  if(old.Exists)key.SetValue(name,old.Value!,old.Kind);else key.DeleteValue(name,false);
 }
 internal static void Register(RegistryKey root,string uninstallKey,string runKey,string shortcut,string desktopShortcut,string target,string displayName,string version,bool? startupOption,bool? desktopOption){
  var executable=Path.Combine(target,"Codex大看板.exe");
  if(File.Exists(shortcut)&&!PointsTo(shortcut,executable))throw new IOException("Start menu shortcut name is already in use");
  if(desktopOption==true&&File.Exists(desktopShortcut)&&!PointsTo(desktopShortcut,executable))throw new IOException("Desktop shortcut name is already in use");
  var names=new[]{"DisplayName","DisplayVersion","Publisher","InstallLocation","DisplayIcon","UninstallString","QuietUninstallString","NoModify","NoRepair","EstimatedSize"};
  using var priorKey=root.OpenSubKey(uninstallKey);bool existed=priorKey!=null;
  var previous=names.ToDictionary(name=>name,name=>ReadValue(priorKey,name));
  using var priorRun=root.OpenSubKey(runKey);var priorStartup=ReadValue(priorRun,AppName);
  var menuBytes=File.Exists(shortcut)?File.ReadAllBytes(shortcut):null;
  var desktopBytes=File.Exists(desktopShortcut)?File.ReadAllBytes(desktopShortcut):null;
  try{
   using var key=root.CreateSubKey(uninstallKey)??throw new IOException("Uninstall registration failed");
   key.SetValue("DisplayName",displayName);key.SetValue("DisplayVersion",version);key.SetValue("Publisher","Codex Usage Dashboard");
   key.SetValue("InstallLocation",target);key.SetValue("DisplayIcon",executable);
   key.SetValue("UninstallString","\""+executable+"\" --uninstall");key.SetValue("QuietUninstallString","\""+executable+"\" --uninstall --silent");
   key.SetValue("NoModify",1,RegistryValueKind.DWord);key.SetValue("NoRepair",1,RegistryValueKind.DWord);
   key.SetValue("EstimatedSize",(int)(Directory.EnumerateFiles(target,"*",SearchOption.AllDirectories).Sum(file=>new FileInfo(file).Length)/1024),RegistryValueKind.DWord);
   SaveShortcut(shortcut,executable,target);
   if(desktopOption==true)SaveShortcut(desktopShortcut,executable,target);
   else if(desktopOption==false&&PointsTo(desktopShortcut,executable))File.Delete(desktopShortcut);
   using var startup=root.CreateSubKey(runKey)??throw new IOException("Startup registration failed");
   if(startupOption==true)startup.SetValue(AppName,"\""+executable+"\" --startup",RegistryValueKind.String);
   else if(startupOption==false){if(startup.GetValue(AppName) is string current&&current.StartsWith("\""+executable+"\"",StringComparison.OrdinalIgnoreCase))startup.DeleteValue(AppName,false);}
   else if(startup.GetValue(AppName) is string prior&&prior.Contains("Codex大看板.exe",StringComparison.OrdinalIgnoreCase))startup.SetValue(AppName,"\""+executable+"\" --startup",RegistryValueKind.String);
  }catch(Exception failure){
   try{
    if(existed){using var key=root.CreateSubKey(uninstallKey)??throw new IOException("Cannot restore registration");foreach(var name in names)RestoreValue(key,name,previous[name]);}
    else root.DeleteSubKeyTree(uninstallKey,false);
    using(var startup=root.CreateSubKey(runKey)??throw new IOException("Cannot restore startup"))RestoreValue(startup,AppName,priorStartup);
    if(menuBytes==null){if(File.Exists(shortcut)&&PointsTo(shortcut,executable))File.Delete(shortcut);}else File.WriteAllBytes(shortcut,menuBytes);
    if(desktopBytes==null){if(File.Exists(desktopShortcut)&&PointsTo(desktopShortcut,executable))File.Delete(desktopShortcut);}else File.WriteAllBytes(desktopShortcut,desktopBytes);
   }catch(Exception rollback){throw new IOException("Registration failed and could not be fully restored: "+rollback.Message,failure);}
   throw;
  }
 }
}
