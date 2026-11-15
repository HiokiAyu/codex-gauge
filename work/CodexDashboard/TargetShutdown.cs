using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace CodexDashboard;
internal static class TargetShutdown {
 [StructLayout(LayoutKind.Sequential)]
 struct FileInformation {
  public uint Attributes;
  public System.Runtime.InteropServices.ComTypes.FILETIME Creation,LastAccess,LastWrite;
  public uint Volume,SizeHigh,SizeLow,LinkCount,IndexHigh,IndexLow;
 }
 [DllImport("kernel32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInformation information);
 static string FileIdentity(string executable){
  using var file=File.OpenHandle(Path.GetFullPath(executable),FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete);
  if(!GetFileInformationByHandle(file,out var info))throw new Win32Exception(Marshal.GetLastWin32Error());
  if(info.IndexHigh==0&&info.IndexLow==0)throw new IOException("Cannot identify the dashboard executable safely.");
  return $"{info.Volume:X8}{info.IndexHigh:X8}{info.IndexLow:X8}";
 }
 internal static string EventName(string executable){
  return @"Local\CodexUsageDashboard.stop."+FileIdentity(executable);
 }
 internal static void Request(string targetExecutable){
  var target=FileIdentity(targetExecutable);
  var matches=new List<Process>();
  var processes=Process.GetProcessesByName("Codex大看板");
  try{
   foreach(var process in processes){
    if(process.Id==Environment.ProcessId)continue;
    string? name;
    try{name=process.MainModule?.FileName;}
    catch(InvalidOperationException){continue;}
    catch(Exception error){throw new IOException("Cannot verify a dashboard process; close it and retry.",error);}
    if(name==null)throw new IOException("Cannot verify a dashboard process; close it and retry.");
    if(string.Equals(FileIdentity(name),target,StringComparison.Ordinal))matches.Add(process);
   }
   if(matches.Count==0)return;
   EventWaitHandle stop;
   try{stop=EventWaitHandle.OpenExisting(@"Local\CodexUsageDashboard.stop."+target);}
   catch(WaitHandleCannotBeOpenedException){
    if(matches.All(p=>{try{return p.HasExited;}catch{return true;}}))return;
    throw new IOException("TARGET_RUNNING_LEGACY: A legacy dashboard is running from the target directory. Close it and retry.");
   }
   using(stop){
    stop.Set();
    foreach(var process in matches)if(!process.WaitForExit(15000))throw new IOException("The target dashboard did not exit.");
   }
  }finally{foreach(var process in processes)process.Dispose();}
 }
}
