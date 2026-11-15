namespace CodexDashboard;

// Only the application's own local data may enter this path. Codex session
// logs live elsewhere and must never be removed by the uninstaller.
internal static class UninstallData {
 sealed class InstanceGuard(Mutex mutex):IDisposable {
  public void Dispose(){mutex.ReleaseMutex();mutex.Dispose();}
 }
 internal static IDisposable AcquireApplicationLock(string? name=null){
  var mutex=new Mutex(false,name??@"Local\CodexUsageDashboard.v1");bool locked;
  try{try{locked=mutex.WaitOne(0);}catch(AbandonedMutexException){locked=true;}}
  catch{mutex.Dispose();throw;}
  if(!locked){mutex.Dispose();throw new IOException("Close all dashboard instances before removing local data");}
  return new InstanceGuard(mutex);
 }
 static void RejectLinks(string root){
  var pending=new Stack<string>();pending.Push(root);
  while(pending.Count>0){
   var folder=pending.Pop();
   foreach(var entry in Directory.EnumerateFileSystemEntries(folder)){
    var attributes=File.GetAttributes(entry);
    if(attributes.HasFlag(FileAttributes.ReparsePoint))throw new IOException("Data directory contains a link");
    if(attributes.HasFlag(FileAttributes.Directory))pending.Push(entry);
   }
  }
 }
 internal static void Validate(string root,string trash,string target){
  root=Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));trash=Path.TrimEndingDirectorySeparator(Path.GetFullPath(trash));target=Path.TrimEndingDirectorySeparator(Path.GetFullPath(target));
  var parent=Path.GetDirectoryName(root);
  if(!string.Equals(Path.GetFileName(root),"CodexUsageDashboard",StringComparison.OrdinalIgnoreCase)||parent==null||
   !string.Equals(Path.GetDirectoryName(trash),parent,StringComparison.OrdinalIgnoreCase)||
   !Path.GetFileName(trash).StartsWith("CodexUsageDashboard-uninstall-data-",StringComparison.Ordinal))throw new IOException("Invalid data cleanup path");
  if(target.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||root.StartsWith(target+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||string.Equals(target,root,StringComparison.OrdinalIgnoreCase))throw new IOException("Installation overlaps local data");
  if(Directory.Exists(root)){
   if(new DirectoryInfo(root).Attributes.HasFlag(FileAttributes.ReparsePoint))throw new IOException("Data directory link rejected");
   RejectLinks(root);
  }
  if(Directory.Exists(trash))throw new IOException("Data cleanup destination already exists");
 }
 internal static void DeleteStaged(string root,string trash){
  root=Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));trash=Path.TrimEndingDirectorySeparator(Path.GetFullPath(trash));
  if(!string.Equals(Path.GetFileName(root),"CodexUsageDashboard",StringComparison.OrdinalIgnoreCase)||
   !string.Equals(Path.GetDirectoryName(root),Path.GetDirectoryName(trash),StringComparison.OrdinalIgnoreCase)||
   !Path.GetFileName(trash).StartsWith("CodexUsageDashboard-uninstall-data-",StringComparison.Ordinal))throw new IOException("Invalid data cleanup path");
  if(!Directory.Exists(trash))return;
  if(new DirectoryInfo(trash).Attributes.HasFlag(FileAttributes.ReparsePoint))throw new IOException("Data cleanup link rejected");
  RejectLinks(trash);
  Directory.Delete(trash,true);
 }
}
