using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace CodexDashboard;

internal static class RuntimeHealth {
 internal static string NodeExecutable(){
  var bundled=Path.Combine(AppContext.BaseDirectory,"runtime","node.exe");
  if(File.Exists(bundled))return bundled;
  var development=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
   ".cache","codex-runtimes","codex-primary-runtime","dependencies","node","bin","node.exe");
  return File.Exists(development)?development:"node.exe";
 }

 internal static int Check(string resultFile){
  string? webview=null;
  string? node=null;
  string? error=null;
  try{
   var start=new ProcessStartInfo{
    FileName=NodeExecutable(),UseShellExecute=false,CreateNoWindow=true,
    RedirectStandardOutput=true,RedirectStandardError=true
   };
   start.ArgumentList.Add("-e");
   start.ArgumentList.Add("require('node:sqlite');if(typeof require('node:zlib').zstdDecompressSync!=='function')process.exit(2);console.log(process.version)");
   using var process=Process.Start(start)??throw new IOException("Node did not start");
   var output=process.StandardOutput.ReadToEndAsync();
   var stderr=process.StandardError.ReadToEndAsync();
   if(!process.WaitForExit(15000)){process.Kill(true);throw new IOException("Node health check timed out");}
   if(process.ExitCode!=0)throw new IOException("Node health check failed");
   node=output.GetAwaiter().GetResult().Trim();
   webview=CoreWebView2Environment.GetAvailableBrowserVersionString();
  }catch(WebView2RuntimeNotFoundException){error="webview-missing";}
  catch(Exception){error="runtime-unavailable";}
  var result=new {healthy=error==null,node,webview,error,framework=Environment.Version.ToString()};
  var temporary=resultFile+".tmp";
  File.WriteAllText(temporary,JsonSerializer.Serialize(result));
  File.Move(temporary,resultFile,true);
  return error==null?0:1;
 }
}
