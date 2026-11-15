using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace CodexDashboard;
internal static class Updater {
 internal static string DataDirectory=>Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexUsageDashboard");
 static string Text(string key,string dataDirectory){
  try{
   using var prefs=JsonDocument.Parse(File.ReadAllText(Path.Combine(dataDirectory,"preferences.json")));
   var language=prefs.RootElement.GetProperty("language").GetString()??"en";
   if(!new[]{"en","ja","zh-CN","zh-TW"}.Contains(language))language="en";
   using var catalog=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"locales",language+".json")));
   return catalog.RootElement.GetProperty("strings").GetProperty(key).GetString()??key;
  }catch{return key=="maintenanceBusy"?"Another installation or restore is running.":"Update did not finish. Please try again.";}
 }
 static ProcessStartInfo Command(string action,string target,string? dataDirectory=null){
  var command=new ProcessStartInfo(RuntimeHealth.NodeExecutable()){
   UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,
   StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8,
   WorkingDirectory=AppContext.BaseDirectory
  };
  command.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory,"update-client.js"));
  command.ArgumentList.Add(action);command.ArgumentList.Add(target);command.ArgumentList.Add(dataDirectory??DataDirectory);
  if(action=="--apply"){
   using var registration=Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexUsageDashboard");
   if(string.Equals(registration?.GetValue("InstallLocation") as string,target,StringComparison.OrdinalIgnoreCase))command.ArgumentList.Add("--integrate");
  }
  return command;
 }
 internal static async Task<string> VerifyReady(){
  using var process=Process.Start(Command("--verify-ready",Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory)))??throw new IOException();
  var output=process.StandardOutput.ReadToEndAsync();
  var errors=process.StandardError.ReadToEndAsync();
  try{await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(2));}
  catch{try{process.Kill(true);}catch{}throw;}
  var text=await output;await errors;
  if(process.ExitCode!=0)throw new IOException("Update verification failed");
  using var result=JsonDocument.Parse(text);
  return result.RootElement.GetProperty("executable").GetString()??throw new IOException();
 }
 internal static int Apply(string target,string? dataDirectory=null,bool open=true){
  target=Path.GetFullPath(target);
  dataDirectory=Path.GetFullPath(dataDirectory??DataDirectory);
  using var maintenance=new Mutex(false,@"Local\CodexUsageDashboard.maintenance.v1");
  bool locked;
  try{locked=maintenance.WaitOne(0);}catch(AbandonedMutexException){locked=true;}
  if(!locked){
   if(open)MessageBox.Show(Text("maintenanceBusy",dataDirectory),"Codex Usage",MessageBoxButtons.OK,MessageBoxIcon.Information);
   return 1;
  }
  var success=false;
  try{
   using var process=Process.Start(Command("--apply",target,dataDirectory))??throw new IOException();
   var output=process.StandardOutput.ReadToEndAsync();
   var errors=process.StandardError.ReadToEndAsync();
   if(!process.WaitForExit(660000)){process.Kill(true);throw new IOException();}
   output.GetAwaiter().GetResult();errors.GetAwaiter().GetResult();
   success=process.ExitCode==0;
  }catch{}
  finally{maintenance.ReleaseMutex();}
  try{
   Directory.CreateDirectory(dataDirectory);
   File.WriteAllText(Path.Combine(dataDirectory,"update-result.json"),JsonSerializer.Serialize(new {success,at=DateTimeOffset.UtcNow}));
  }catch{}
  if(open&&!success)MessageBox.Show(Text("updateFailed",dataDirectory),"Codex Usage",MessageBoxButtons.OK,MessageBoxIcon.Warning);
  try{if(open)Process.Start(new ProcessStartInfo(Path.Combine(target,"Codex大看板.exe")){UseShellExecute=true,WorkingDirectory=target,Arguments="--restart"});}
  catch{return 1;}
  return success?0:1;
 }
}
