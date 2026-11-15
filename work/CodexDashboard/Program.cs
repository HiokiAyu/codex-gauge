using System.Text.Json;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.WinForms;

namespace CodexDashboard;
static class Program {
 const string InstanceName = @"Local\CodexUsageDashboard.v1";

 [STAThread] static void Main(string[] args) {
  if(args.Contains("--apply-staged-update")){
   var target=Array.IndexOf(args,"--target");
   if(target<0||target+1>=args.Length){Environment.ExitCode=1;return;}
   var dataIndex=Array.IndexOf(args,"--data-directory");
   var data=dataIndex>=0&&dataIndex+1<args.Length?args[dataIndex+1]:null;
   try{Environment.ExitCode=Updater.Apply(args[target+1],data,!args.Contains("--no-open"));}catch{Environment.ExitCode=1;}
   return;
  }
  if(args.Contains("--register")){
   bool? Option(string on,string off)=>args.Contains(on)?true:args.Contains(off)?false:null;
   try{Maintenance.Register(Option("--startup-on","--startup-off"),Option("--desktop-on","--desktop-off"));}catch{Environment.ExitCode=1;}
   return;
  }
  if(args.Contains("--uninstall")){
   string? failure=null;
   var resultIndex=Array.IndexOf(args,"--result");
   var result=resultIndex>=0&&resultIndex+1<args.Length?args[resultIndex+1]:null;
   try{Maintenance.StartUninstall(args.Contains("--silent"),result);}
   catch(Exception error){
    failure=error.Message;
    Environment.ExitCode=1;
    if(!args.Contains("--silent"))Maintenance.ReportFailure(error);
   }
   if(failure!=null&&result!=null)File.WriteAllText(result,JsonSerializer.Serialize(new {success=false,error=failure}));
   return;
  }
  if(args.Contains("--uninstall-worker")){
   string? failure=null;
   var targetIndex=Array.IndexOf(args,"--target");
   var parentIndex=Array.IndexOf(args,"--parent");
   var resultIndex=Array.IndexOf(args,"--result");
   try{
    if(targetIndex<0||parentIndex<0)throw new IOException("Invalid maintenance request");
    Environment.ExitCode=Maintenance.UninstallWorker(args[targetIndex+1],int.Parse(args[parentIndex+1]),args.Contains("--silent"),args.Contains("--remove-local-data"));
   }catch(Exception error){
    failure=error.Message;
    Environment.ExitCode=1;
    if(!args.Contains("--silent"))Maintenance.ReportFailure(error);
   }
   if(resultIndex>=0&&resultIndex+1<args.Length)File.WriteAllText(args[resultIndex+1],JsonSerializer.Serialize(new {success=failure==null,error=failure}));
   return;
  }
  var stopTarget=Array.IndexOf(args,"--shutdown-target");
  if(stopTarget>=0){
   try{if(stopTarget+1>=args.Length)throw new IOException("Missing target");TargetShutdown.Request(args[stopTarget+1]);}
   catch(Exception error){Console.Error.WriteLine(error.Message);Environment.ExitCode=1;}
   return;
  }
  if(args.Contains("--shutdown")){
   try{
    using var stop=EventWaitHandle.OpenExisting(InstanceName+".stop");
    stop.Set();
    using var running=Mutex.OpenExisting(InstanceName);
    try{if(running.WaitOne(15000))running.ReleaseMutex();else Environment.ExitCode=1;}
    catch(AbandonedMutexException){running.ReleaseMutex();}
   }catch(WaitHandleCannotBeOpenedException){}
   return;
  }
  var health=Array.IndexOf(args,"--health-check");
  if(health>=0&&health+1<args.Length){
   Environment.ExitCode=RuntimeHealth.Check(args[health+1]);
   return;
  }
  bool startup=args.Contains("--startup");
  using var showRequest=new EventWaitHandle(false,EventResetMode.AutoReset,InstanceName+".show");
  using var stopRequest=new EventWaitHandle(false,EventResetMode.AutoReset,InstanceName+".stop");
  using var instance=new Mutex(false,InstanceName);
  bool ownsInstance;
  try{ownsInstance=instance.WaitOne(args.Contains("--restart")?15000:0);}
  catch(AbandonedMutexException){ownsInstance=true;}
  if(!ownsInstance){
   if(!startup)showRequest.Set();
   return;
  }
  try{
   using var targetStop=new EventWaitHandle(false,EventResetMode.AutoReset,TargetShutdown.EventName(Environment.ProcessPath!));
   ApplicationConfiguration.Initialize();
   using var dashboard=new Dashboard(startup);
   _=dashboard.Handle;
   var registration=ThreadPool.RegisterWaitForSingleObject(showRequest,(_,_)=>dashboard.RequestOpen(),null,-1,false);
   var stopRegistration=ThreadPool.RegisterWaitForSingleObject(stopRequest,(_,_)=>dashboard.RequestExit(),null,-1,false);
   var targetStopRegistration=ThreadPool.RegisterWaitForSingleObject(targetStop,(_,_)=>dashboard.RequestExit(),null,-1,false);
   try{Application.Run(dashboard);}
   finally{registration.Unregister(null);stopRegistration.Unregister(null);targetStopRegistration.Unregister(null);}
  }
  finally{instance.ReleaseMutex();}
 }
}
public class Dashboard : Form {
 Process? backend; WebView2 web = new() { Dock = DockStyle.Fill };
 int backendPort; Task? webStart; BackendJob? backendJob; bool recoveringBackend; int backendRestartAttempt; DateTime backendStartedAt;
 string language="zh-CN";
 readonly Icon brandIcon=LoadBrandIcon();
 NotifyIcon newsIcon=new();
 static Icon LoadBrandIcon(){using var stream=typeof(Dashboard).Assembly.GetManifestResourceStream("AppIcon.ico")??throw new InvalidOperationException("App icon missing");return new Icon(stream);}
 bool trayOnClose=true,exiting=false,maintenanceBusy=false; readonly bool startInTray; ContextMenuStrip? trayMenu;
 ToolStripMenuItem? trayStatus;
 double? trayRemaining,trayDuration;
 DateTimeOffset? trayUpdated;
 bool trayConnected,trayStatusReceived;
 string? trayTimeZone;
 const string RunPath=@"Software\Microsoft\Windows\CurrentVersion\Run", RunName="CodexUsageDashboard";
 static string StartupCommand => "\""+Application.ExecutablePath+"\" --startup";
 bool StartupEnabled(){try{using var key=Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunPath);return string.Equals(key?.GetValue(RunName) as string,StartupCommand,StringComparison.OrdinalIgnoreCase);}catch{return false;}}
 void SetStartup(bool enabled){try{using var key=Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunPath);if(key==null)throw new InvalidOperationException();if(enabled)key.SetValue(RunName,StartupCommand,Microsoft.Win32.RegistryValueKind.String);else key.DeleteValue(RunName,false);web.CoreWebView2.PostWebMessageAsString(StartupEnabled()?"startup-on":"startup-off");}catch{web.CoreWebView2.PostWebMessageAsString("startup-error");}}
 void OpenDashboard(){ShowInTaskbar=true;Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;if(restoreBubble&&web.CoreWebView2!=null){restoreBubble=false;SetCompact(true);}Activate();}
 internal void RequestOpen(){try{BeginInvoke(OpenDashboard);}catch(InvalidOperationException){}}
 internal void RequestExit(){try{BeginInvoke(()=>{if(maintenanceBusy)return;exiting=true;Close();});}catch(InvalidOperationException){}}
 void MakeTrayMenu(){
  trayMenu?.Dispose();
  trayMenu=new ContextMenuStrip();
  trayStatus=new ToolStripMenuItem {Enabled=false};
  trayMenu.Items.Add(trayStatus);
  trayMenu.Items.Add(new ToolStripSeparator());
  trayMenu.Items.Add(L("trayOpen"),null,(_,_)=>OpenDashboard());
  trayMenu.Items.Add(L("trayExit"),null,(_,_)=>{exiting=true;Close();});
  newsIcon.ContextMenuStrip=trayMenu;
  UpdateTrayStatus();
 }
 void UpdateTrayStatus(){
  if(trayStatus==null)return;
  var quota=trayRemaining is double remaining ? remaining.ToString("0")+"%" : "—";
  var connection=L(trayConnected?"connected":trayStatusReceived?"offline":"loading");
  var localTime=trayUpdated?.ToLocalTime();
  if(trayUpdated is DateTimeOffset reading&&trayTimeZone!=null){
   try{localTime=TimeZoneInfo.ConvertTime(reading,TimeZoneInfo.FindSystemTimeZoneById(trayTimeZone));}
   catch(TimeZoneNotFoundException){}
   catch(InvalidTimeZoneException){}
  }
  var time=localTime is DateTimeOffset updated
   ?" · "+L("quotaUpdated").Replace("{time}",updated.ToString("t")):"";
  var window=trayDuration is double minutes ? " ("+WindowDuration(minutes)+")" : "";
  trayStatus.Text=L("remaining")+window+" "+quota+" · "+connection+time;
 }
 async Task ReadBackendStatus(Process process){
  try{
   while(await process.StandardOutput.ReadLineAsync() is { } line){
    if(line.StartsWith("UPDATE ",StringComparison.Ordinal)){
     try{using var notice=JsonDocument.Parse(line.AsMemory(7));ShowNotification(L("updates"),L("updateAvailable").Replace("{version}",notice.RootElement.GetProperty("version").GetString()),ToolTipIcon.Info);}catch(JsonException){}
     continue;
    }
    if(line.StartsWith("BUDGET ",StringComparison.Ordinal)){
     ShowBudgetAlerts(line[7..]);
     continue;
    }
    if(line.StartsWith("NEWS ",StringComparison.Ordinal)){
     using var news=JsonDocument.Parse(line.AsMemory(5));
     var count=news.RootElement.GetProperty("count").GetInt32();
     ShowNotification(L("notificationTitle"),L("notificationBody").Replace("{n}",count.ToString()),ToolTipIcon.Info);
     continue;
    }
    if(!line.StartsWith("STATUS ",StringComparison.Ordinal))continue;
    using var doc=JsonDocument.Parse(line.AsMemory(7));
    var status=doc.RootElement;
    trayStatusReceived=true;
    trayConnected=status.GetProperty("connected").GetBoolean();
    trayRemaining=status.GetProperty("remaining").ValueKind==JsonValueKind.Number
     ?status.GetProperty("remaining").GetDouble():null;
    trayDuration=status.GetProperty("duration").ValueKind==JsonValueKind.Number
     ?status.GetProperty("duration").GetDouble():null;
    var timestamp=status.GetProperty("updated");
    trayTimeZone=status.TryGetProperty("timeZone",out var zone)&&zone.ValueKind==JsonValueKind.String?zone.GetString():null;
    trayUpdated=timestamp.ValueKind==JsonValueKind.String&&timestamp.TryGetDateTimeOffset(out var updated)?updated:null;
    ballValue=trayRemaining is double remaining?remaining.ToString("0")+"%":"—";
    if(ball!=null)ball.Value=ballValue;
    UpdateTrayStatus();
   }
  }catch(IOException){}
  catch(ObjectDisposedException){}
  finally{
   trayConnected=false;
   trayStatusReceived=true;
   if(!IsDisposed)UpdateTrayStatus();
   if(ReferenceEquals(backend,process)&&!IsDisposed&&!exiting&&!maintenanceBusy)_=RecoverBackend();
  }
 }
 async Task LaunchBackend(int port){
  var job=new BackendJob();
  Process? process=null;
  try{
  process=Process.Start(new ProcessStartInfo{
   FileName=RuntimeHealth.NodeExecutable(),UseShellExecute=false,CreateNoWindow=true,
   RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,
   WorkingDirectory=AppContext.BaseDirectory,
   ArgumentList={Path.Combine(AppContext.BaseDirectory,"backend.js"),port.ToString(),"--managed"}
  })??throw new IOException(L("nativeBackend"));
  job.Add(process);
  backendJob=job;
  backend=process;
   var ready=await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
   if(ready!="READY"||process.HasExited)throw new IOException(L("nativeBackend"));
   process.BeginErrorReadLine();backendStartedAt=DateTime.UtcNow;
   _=ReadBackendStatus(process);
  }catch{job.Dispose();try{if(process is {HasExited:false})process.Kill(true);}catch{}throw;}
 }
 async Task RecoverBackend(){
  if(recoveringBackend||backendPort==0)return;
  recoveringBackend=true;
  try{
   backendJob?.Dispose();backendJob=null;
   if(DateTime.UtcNow-backendStartedAt>TimeSpan.FromMinutes(1))backendRestartAttempt=0;
   while(!IsDisposed&&!exiting&&!maintenanceBusy){
    await Task.Delay(TimeSpan.FromSeconds(Math.Min(60,Math.Pow(2,Math.Min(backendRestartAttempt++,6)))));
    if(IsDisposed||exiting||maintenanceBusy)return;
    var previous=backend;
    try{
     if(previous is {HasExited:false}){previous.Kill(true);await previous.WaitForExitAsync();}
     await LaunchBackend(backendPort);
     previous?.Dispose();
     return;
    }catch{if(!ReferenceEquals(previous,backend))previous?.Dispose();}
   }
  }finally{
   recoveringBackend=false;
   if(!IsDisposed&&!exiting&&!maintenanceBusy&&backend is {HasExited:true})_=RecoverBackend();
  }
 }

 string L(string key){try{var file=Path.Combine(AppContext.BaseDirectory,"locales",language+".json");using var doc=JsonDocument.Parse(File.ReadAllText(file));return doc.RootElement.GetProperty("strings").GetProperty(key).GetString()??key;}catch{return key;}}
 void SetLanguage(string code){if(code.Length>32||!System.Text.RegularExpressions.Regex.IsMatch(code,"^[a-zA-Z0-9-]+$"))return;if(File.Exists(Path.Combine(AppContext.BaseDirectory,"locales",code+".json")))language=code;Text=L("app");newsIcon.Text=Text.Length>63?Text[..63]:Text;if(trayMenu!=null)MakeTrayMenu();}
 void ReadPreferences(){
  try{
   using var doc=JsonDocument.Parse(File.ReadAllText(Path.Combine(Updater.DataDirectory,"preferences.json")));
   var prefs=doc.RootElement;
   if(prefs.TryGetProperty("trayOnClose",out var tray)&&tray.ValueKind is JsonValueKind.True or JsonValueKind.False)
    trayOnClose=tray.GetBoolean();
   SetLanguage(prefs.TryGetProperty("language",out var selected)&&selected.ValueKind==JsonValueKind.String
    ?selected.GetString()??"zh-CN":"zh-CN");
  }catch{SetLanguage("zh-CN");}
 }
 void ShowNotification(string title,string body,ToolTipIcon icon){
  newsIcon.Visible=true;
  newsIcon.ShowBalloonTip(10000,title.Length>60?title[..60]:title,body.Length>240?body[..240]:body,icon);
 }
 void ShowNews(string payload){
  try{
   using var doc=JsonDocument.Parse(payload);
   var title=doc.RootElement.GetProperty("title").GetString()??L("notificationTitle");
   var body=doc.RootElement.GetProperty("body").GetString()??"";
   ShowNotification(title,body,ToolTipIcon.Info);
  }catch{}
 }
 void ShowBudgetAlerts(string payload){
  try{
   using var doc=JsonDocument.Parse(payload);
   var lines=doc.RootElement.EnumerateArray().Select(window=>{
    var minutes=window.GetProperty("duration").GetDouble();
    var duration=WindowDuration(minutes);
    var label=window.GetProperty("label").GetString();
    return L("budgetAlertLine").Replace("{window}",label=="codex"?duration:label+" · "+duration)
     .Replace("{remaining}",window.GetProperty("remaining").GetDouble().ToString("0.##"))
     .Replace("{reserve}",window.GetProperty("reserve").GetInt32().ToString());
   });
   ShowNotification(L("budgetAlertTitle"),string.Join("\n",lines),ToolTipIcon.Warning);
  }catch(JsonException){}
 }
 string WindowDuration(double minutes)=>minutes%1440==0?L("budgetDays").Replace("{n}",(minutes/1440).ToString("0"))
  :minutes%60==0?L("budgetHours").Replace("{n}",(minutes/60).ToString("0"))
  :L("budgetMinutes").Replace("{n}",minutes.ToString("0.##"));
 void PublishVisibility(){
  web.CoreWebView2?.PostWebMessageAsString(Visible&&WindowState!=FormWindowState.Minimized?"panel-visible":"panel-hidden");
 }
 void OnDashboardVisibilityChanged(){
  PublishVisibility();
  if(Visible&&WindowState!=FormWindowState.Minimized&&backendPort>0)_=EnsureDashboard();
 }
 Task EnsureDashboard()=>webStart??=InitializeDashboard();
 sealed class WindowConfig { public bool TopMost {get;set;}=true; public bool BubbleEnabled {get;set;} public int? X {get;set;} public int? Y {get;set;} public int? Width {get;set;} public int? Height {get;set;} public bool Maximized {get;set;} public int? BubbleX {get;set;} public int? BubbleY {get;set;} }
 readonly string windowConfigPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexUsageDashboard","window-config.json");
 readonly System.Windows.Forms.Timer configTimer=new(){Interval=700}; WindowConfig windowConfig=new(); bool configReady=false,restoreBubble=false;
 void ReadWindowConfig(){try{windowConfig=JsonSerializer.Deserialize<WindowConfig>(File.ReadAllText(windowConfigPath))??new();}catch{windowConfig=new();}}
 static bool VisibleOnScreen(Rectangle r)=>Screen.AllScreens.Any(s=>{var i=Rectangle.Intersect(s.WorkingArea,r);return i.Width>=32&&i.Height>=32;});
 void ApplyWindowConfig(){TopMost=windowConfig.TopMost;if(windowConfig.Width is int w&&windowConfig.Height is int h&&w>=850&&h>=600&&w<=10000&&h<=10000){Size=new Size(w,h);if(windowConfig.X is int x&&windowConfig.Y is int y&&VisibleOnScreen(new Rectangle(x,y,w,h))){StartPosition=FormStartPosition.Manual;Location=new Point(x,y);}}if(windowConfig.BubbleX is int bx&&windowConfig.BubbleY is int by&&VisibleOnScreen(new Rectangle(bx,by,64,64)))ballPosition=new Point(bx,by);restoreBubble=windowConfig.BubbleEnabled;}
 void QueueWindowConfig(){if(!configReady)return;configTimer.Stop();configTimer.Start();}
 void SaveWindowConfig(){if(!configReady)return;configTimer.Stop();windowConfig.TopMost=TopMost;windowConfig.BubbleEnabled=compact||restoreBubble;windowConfig.BubbleX=ballPosition?.X;windowConfig.BubbleY=ballPosition?.Y;if(WindowState!=FormWindowState.Minimized){windowConfig.Maximized=WindowState==FormWindowState.Maximized;var r=WindowState==FormWindowState.Normal?Bounds:RestoreBounds;if(r.Width>=850&&r.Height>=600){windowConfig.X=r.X;windowConfig.Y=r.Y;windowConfig.Width=r.Width;windowConfig.Height=r.Height;}}try{Directory.CreateDirectory(Path.GetDirectoryName(windowConfigPath)!);var temp=windowConfigPath+"."+Guid.NewGuid().ToString("N")+".tmp";File.WriteAllText(temp,JsonSerializer.Serialize(windowConfig,new JsonSerializerOptions{WriteIndented=true}));File.Move(temp,windowConfigPath,true);}catch{}}
 bool compact=false; BubbleWindow? ball; Point? ballPosition; string ballValue="—";
 protected override CreateParams CreateParams {get{var p=base.CreateParams;p.Style|=0x00040000;return p;}}
 protected override void WndProc(ref Message m){
  if(m.Msg==0x83&&m.WParam!=IntPtr.Zero){m.Result=IntPtr.Zero;return;}
  if(m.Msg==0x218&&m.WParam.ToInt64()==0x12)ResumeCollection();
  base.WndProc(ref m);
 }
 async void ResumeCollection(){
  if(backend is not { HasExited:false } process)return;
  try{await process.StandardInput.WriteLineAsync("resume");await process.StandardInput.FlushAsync();}
  catch(InvalidOperationException){}
  catch(IOException){}
 }
 void BeginMaintenance(){
  SaveWindowConfig();
  configReady=false;
  configTimer.Stop();
  maintenanceBusy=true;
 }
 async Task ApplyUpdate(){
  if(maintenanceBusy)return;
  if(MessageBox.Show(this,L("updateConfirm"),L("updates"),MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return;
  maintenanceBusy=true;
  try{
   var executable=await Updater.VerifyReady();
   SaveWindowConfig();configReady=false;configTimer.Stop();
   var start=new ProcessStartInfo(executable){UseShellExecute=true,WorkingDirectory=Path.GetDirectoryName(executable)!};
   start.ArgumentList.Add("--apply-staged-update");start.ArgumentList.Add("--target");
   start.ArgumentList.Add(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory));
   Process.Start(start);
   exiting=true;
  }catch{configReady=true;MessageBox.Show(this,L("updateFailed"),L("updates"),MessageBoxButtons.OK,MessageBoxIcon.Error);}
  finally{
   maintenanceBusy=false;
   if(!exiting&&!IsDisposed&&backend is {HasExited:true})_=RecoverBackend();
  }
  if(exiting)Close();
 }
 async Task RestoreBackup(string request){
  if(maintenanceBusy)return;
  string? id;
  try{id=JsonSerializer.Deserialize<string>(request);}catch{return;}
  if(id==null||!System.Text.RegularExpressions.Regex.IsMatch(id,@"^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-f0-9]{8}$"))return;
  if(MessageBox.Show(this,L("backupConfirm"),L("backupRestore"),MessageBoxButtons.OKCancel,MessageBoxIcon.Warning)!=DialogResult.OK)return;
  using var maintenance=new Mutex(false,@"Local\CodexUsageDashboard.maintenance.v1");
  bool locked;
  try{locked=maintenance.WaitOne(0);}catch(AbandonedMutexException){locked=true;}
  if(!locked){MessageBox.Show(this,L("maintenanceBusy"),L("app"));return;}
  try{
  BeginMaintenance();
  try{
   if(backend is {HasExited:false} active){active.Kill(true);await active.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));}
   var start=new ProcessStartInfo(RuntimeHealth.NodeExecutable()){
    UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,
    WorkingDirectory=AppContext.BaseDirectory
   };
   start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory,"storage-backup.js"));
   start.ArgumentList.Add("--restore");start.ArgumentList.Add(id);
   start.ArgumentList.Add(Path.GetDirectoryName(windowConfigPath)!);
   using var restore=Process.Start(start)??throw new IOException();
   var output=restore.StandardOutput.ReadToEndAsync();
   var errors=restore.StandardError.ReadToEndAsync();
   try{await restore.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(5));}
   catch{try{restore.Kill(true);await restore.WaitForExitAsync();}catch{}throw;}
   await output;await errors;
   if(restore.ExitCode!=0)throw new IOException();
  }catch{MessageBox.Show(this,L("backupFailed"),L("backupRestore"),MessageBoxButtons.OK,MessageBoxIcon.Error);}
  try{Process.Start(new ProcessStartInfo(Application.ExecutablePath){UseShellExecute=true,WorkingDirectory=AppContext.BaseDirectory,Arguments="--restart"});}
  catch{MessageBox.Show(this,L("restartError"),L("app"));}
  maintenanceBusy=false;exiting=true;Close();
  }finally{maintenance.ReleaseMutex();}
 }
 static bool IsDashboardSource(string source,int port){
  return Uri.TryCreate(source,UriKind.Absolute,out var uri)&&uri.Scheme=="http"&&uri.Host=="127.0.0.1"
   &&uri.Port==port&&string.IsNullOrEmpty(uri.UserInfo);
 }
 [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd,int attribute,ref uint value,int size);
 protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);uint noBorder=0xfffffffe;try{DwmSetWindowAttribute(Handle,34,ref noBorder,sizeof(uint));}catch(DllNotFoundException){}}
 [DllImport("user32.dll")] static extern bool ReleaseCapture();
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd,int msg,IntPtr wParam,IntPtr lParam);
 void ApplyShape() {
  if(Width<=0||Height<=0||WindowState==FormWindowState.Minimized)return;
  using var shape=new GraphicsPath();
  if(WindowState==FormWindowState.Maximized)shape.AddRectangle(new Rectangle(0,0,Width,Height));
  else {
   int diameter=Math.Min(Math.Min(Width,Height),Math.Max(2,(int)Math.Round(36.0*DeviceDpi/96)));
   var r=new Rectangle(0,0,Width,Height);shape.AddArc(r.Left,r.Top,diameter,diameter,180,90);
   shape.AddArc(r.Right-diameter,r.Top,diameter,diameter,270,90);
   shape.AddArc(r.Right-diameter,r.Bottom-diameter,diameter,diameter,0,90);
   shape.AddArc(r.Left,r.Bottom-diameter,diameter,diameter,90,90);shape.CloseFigure();
  }
  var old=Region;Region=new Region(shape);old?.Dispose();
 }
 void BeginWindowMove(){ReleaseCapture();SendMessage(Handle,0xA1,(IntPtr)2,IntPtr.Zero);}
 void BeginWindowResize(string side){
  if(WindowState!=FormWindowState.Normal)return;
  int hit=side switch {"left"=>10,"right"=>11,"top"=>12,"top-left"=>13,"top-right"=>14,"bottom"=>15,"bottom-left"=>16,"bottom-right"=>17,_=>0};
  if(hit==0)return;ReleaseCapture();SendMessage(Handle,0xA1,(IntPtr)hit,IntPtr.Zero);
 }
 void ToggleMaximize(){if(WindowState==FormWindowState.Maximized)WindowState=FormWindowState.Normal;else{MaximizedBounds=Screen.FromControl(this).WorkingArea;WindowState=FormWindowState.Maximized;}}
 void SetCompact(bool value) {
  if(compact==value)return;compact=value;
  if(value){ball=new BubbleWindow(()=>{if(Visible&&WindowState!=FormWindowState.Minimized)Hide();else{Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Activate();}},pos=>{ballPosition=pos;QueueWindowConfig();});ball.Value=ballValue;if(ballPosition.HasValue)ball.Location=ballPosition.Value;ball.Show();}
  else {if(ball!=null)ballPosition=ball.Location;ball?.Close();ball=null;if(!Visible){Show();Activate();}}
  web.CoreWebView2.PostWebMessageAsString(value?"bubble-on":"bubble-off");QueueWindowConfig();
 }
 public Dashboard(bool startup=false) {
  Icon=brandIcon;newsIcon.Icon=brandIcon;
  startInTray=startup;
  ReadPreferences();ReadWindowConfig();MakeTrayMenu();newsIcon.DoubleClick+=(_,_)=>OpenDashboard();FormClosing+=(_,e)=>{if(maintenanceBusy){e.Cancel=true;return;}if(e.CloseReason==CloseReason.UserClosing&&!exiting&&trayOnClose){e.Cancel=true;newsIcon.Visible=true;Hide();}};newsIcon.BalloonTipClicked += (_,_)=>{if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Show();Activate();};FormClosed += (_,_)=>{ball?.Close();newsIcon.Dispose();trayMenu?.Dispose();brandIcon.Dispose();};
  Text=L("app"); FormBorderStyle=FormBorderStyle.None; Width=Math.Min(1400,Screen.PrimaryScreen!.WorkingArea.Width); Height=Math.Min(920,Screen.PrimaryScreen.WorkingArea.Height); MinimumSize=new Size(850,600); StartPosition=FormStartPosition.CenterScreen; TopMost=true; BackColor=Color.FromArgb(12,18,30); Controls.Add(web);ApplyWindowConfig();configTimer.Tick+=(_,_)=>SaveWindowConfig();configReady=true;Move+=(_,_)=>QueueWindowConfig();FormClosed+=(_,_)=>{SaveWindowConfig();configTimer.Dispose();};
  if(startInTray){Opacity=0;ShowInTaskbar=false;newsIcon.Visible=true;Shown+=(_,_)=>{Hide();Opacity=1;};}
  SizeChanged += (_,_) => {QueueWindowConfig();ApplyShape();if(web.CoreWebView2!=null)web.CoreWebView2.PostWebMessageAsString(WindowState==FormWindowState.Maximized?"maximized":"restored");};
  VisibleChanged += (_,_) => OnDashboardVisibilityChanged(); Resize += (_,_) => OnDashboardVisibilityChanged();
  DpiChanged += (_,_) => ApplyShape(); Shown += (_,_) => {ApplyShape();if(windowConfig.Maximized)WindowState=FormWindowState.Maximized;QueueWindowConfig();};
  Shown += async (_,_) => await Start(); FormClosed += (_,_) => { backendJob?.Dispose(); try { if(backend!=null&&!backend.HasExited)backend.Kill(true); } catch {} };
 }
 async Task Start() { try {
  var listener=new TcpListener(IPAddress.Loopback,0); listener.Start(); var port=((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
  backendPort=port;await LaunchBackend(port);
  if(Visible&&WindowState!=FormWindowState.Minimized)await EnsureDashboard();
 } catch(Exception ex) { if(IsDisposed||exiting)return;MessageBox.Show(L("nativeStartup")+": "+ex.Message,L("app")); exiting=true;Close(); } }
 async Task InitializeDashboard(){try{
  var port=backendPort;
  var env=await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(Path.GetTempPath(),"CodexUsageDashboardWebView2")); await web.EnsureCoreWebView2Async(env); web.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
  web.CoreWebView2.WebMessageReceived += (_,e)=> {if(!IsDashboardSource(e.Source,port))return;var cmd=e.TryGetWebMessageAsString();if(cmd=="apply-update"){_ = ApplyUpdate();return;}if(cmd.StartsWith("restore-backup:")){_ = RestoreBackup(cmd[15..]);return;} if(cmd.StartsWith("language:")){SetLanguage(cmd[9..]);}else if(cmd=="tray-close:on"){trayOnClose=true;}else if(cmd=="tray-close:off"){trayOnClose=false;}else if(cmd=="startup:on"){SetStartup(true);}else if(cmd=="startup:off"){SetStartup(false);}else if(cmd=="choose-project-folder"){using var picker=new FolderBrowserDialog{Description=L("projectAddFolder"),UseDescriptionForTitle=true,ShowNewFolderButton=false};if(picker.ShowDialog(this)==DialogResult.OK)web.CoreWebView2.PostWebMessageAsString("project-folder-picked:"+JsonSerializer.Serialize(picker.SelectedPath));}else if(cmd=="choose-data-root"){using var picker=new FolderBrowserDialog{Description=L("chooseDataFolder"),UseDescriptionForTitle=true,ShowNewFolderButton=false};if(picker.ShowDialog(this)==DialogResult.OK)web.CoreWebView2.PostWebMessageAsString("data-root-picked:"+JsonSerializer.Serialize(picker.SelectedPath));}else if(cmd=="restart-dashboard"){try{Process.Start(new ProcessStartInfo(Application.ExecutablePath){UseShellExecute=true,WorkingDirectory=AppContext.BaseDirectory,Arguments="--restart"});exiting=true;Close();}catch{web.CoreWebView2.PostWebMessageAsString("restart-error");}}else if(cmd=="reset-bubble-position"){ballPosition=null;ball?.ResetPosition();if(ball!=null)ballPosition=ball.Location;QueueWindowConfig();}else if(cmd.StartsWith("notify:")){ShowNews(cmd[7..]);}else if(cmd=="state"){PublishVisibility();if(restoreBubble&&(!startInTray||Visible)){restoreBubble=false;SetCompact(true);}web.CoreWebView2.PostWebMessageAsString(TopMost?"pinned":"unpinned");web.CoreWebView2.PostWebMessageAsString(compact?"bubble-on":"bubble-off");web.CoreWebView2.PostWebMessageAsString(StartupEnabled()?"startup-on":"startup-off");}else if(cmd=="pin") {TopMost=!TopMost;QueueWindowConfig(); web.CoreWebView2.PostWebMessageAsString(TopMost?"pinned":"unpinned");} else if(cmd=="compact") SetCompact(true); else if(cmd=="expand") SetCompact(false); else if(cmd=="drag" && compact) BeginWindowMove(); else if(cmd=="move" && WindowState==FormWindowState.Normal) BeginWindowMove(); else if(cmd.StartsWith("resize:",StringComparison.Ordinal)) BeginWindowResize(cmd[7..]); else if(cmd=="maximize") ToggleMaximize(); else if(cmd=="minimize") WindowState=FormWindowState.Minimized; else if(cmd=="close") Close();};
  web.CoreWebView2.NavigationStarting += (_,e)=>{if(!IsDashboardSource(e.Uri,port))e.Cancel=true;};
  web.CoreWebView2.NewWindowRequested += (_,e) => {e.Handled=true;if(Uri.TryCreate(e.Uri,UriKind.Absolute,out var link)&&link.Scheme=="https"&&new[]{"x.com","twitter.com","tokenusage.dev","agentresets.com","whenreset.dev","codex-resets.com","claude-resets.com"}.Contains(link.Host)){try{Process.Start(new ProcessStartInfo(link.AbsoluteUri){UseShellExecute=true});}catch{MessageBox.Show(L("nativeBrowser"),L("app"));}}};
  web.CoreWebView2.Navigate($"http://127.0.0.1:{port}/");
 } catch(Exception ex) { if(IsDisposed||exiting)return;MessageBox.Show(L("nativeStartup")+": "+ex.Message,L("app")); exiting=true;Close(); } }
}

public sealed class BubbleWindow : Form {
 [StructLayout(LayoutKind.Sequential)] struct MinMaxInfo { public Point Reserved,MaxSize,MaxPosition,MinTrackSize,MaxTrackSize; }
 protected override void WndProc(ref Message m){if(m.Msg==0x24&&m.LParam!=IntPtr.Zero){base.WndProc(ref m);var info=Marshal.PtrToStructure<MinMaxInfo>(m.LParam);info.MinTrackSize=new Point(1,1);Marshal.StructureToPtr(info,m.LParam,false);return;}base.WndProc(ref m);}

 readonly Action toggle; Point down,origin; bool dragging; string current="—"; double level=-1,target=-1,phase=0;
 readonly System.Windows.Forms.Timer animation=new(){Interval=40};
 [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
 public string Value {get=>current;set{current=value;var text=value.Trim().TrimEnd('%');target=double.TryParse(text,System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var n)?Math.Clamp(n/100,0,1):-1;if(level<0)level=target;Invalidate();}}
 public void ResetPosition(){var area=Screen.FromControl(this).WorkingArea;Location=new Point(area.Right-Width-24,area.Top+90);}
 public BubbleWindow(Action action,Action<Point>? moved=null){toggle=action;FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;AutoScaleMode=AutoScaleMode.None;Size=new Size(64,64);BackColor=Color.FromArgb(18,43,53);DoubleBuffered=true;var area=Screen.PrimaryScreen!.WorkingArea;Location=new Point(area.Right-Width-24,area.Top+90);animation.Tick+=(_,_)=>{phase=(phase+0.09)%(Math.PI*2);if(target>=0){level+=(target-level)*0.08;if(Math.Abs(target-level)<0.001)level=target;}Invalidate();};animation.Start();FormClosed+=(_,_)=>animation.Dispose();UpdateBallRegion();SizeChanged+=(_,_)=>UpdateBallRegion();MouseDown+=(_,e)=>{if(e.Button==MouseButtons.Left){down=Cursor.Position;origin=Location;dragging=false;Capture=true;}};MouseMove+=(_,e)=>{if(!Capture)return;var now=Cursor.Position;int dx=now.X-down.X,dy=now.Y-down.Y;if(Math.Abs(dx)+Math.Abs(dy)>5)dragging=true;if(dragging)Location=new Point(origin.X+dx,origin.Y+dy);};MouseUp+=(_,e)=>{if(e.Button!=MouseButtons.Left)return;Capture=false;if(!dragging)toggle();else moved?.Invoke(Location);};}
 void UpdateBallRegion(){if(ClientSize.Width<=0||ClientSize.Height<=0)return;using var p=new GraphicsPath();int d=Math.Min(ClientSize.Width,ClientSize.Height);p.AddEllipse((ClientSize.Width-d)/2,(ClientSize.Height-d)/2,d,d);var old=Region;Region=new Region(p);old?.Dispose();}
 protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;int d=Math.Min(ClientSize.Width,ClientSize.Height);float x=(ClientSize.Width-d)/2f,y=(ClientSize.Height-d)/2f;using var circle=new GraphicsPath();circle.AddEllipse(x+1,y+1,d-2,d-2);var state=e.Graphics.Save();e.Graphics.SetClip(circle);if(level>=0){using var liquid=new GraphicsPath();float surface=y+(float)(d*(1-level));float amplitude=(float)(Math.Min(level,1-level)*4);liquid.StartFigure();liquid.AddLine(x,y+d,x,surface);for(int i=0;i<=d;i+=2){float px=x+i,py=surface+(float)Math.Sin(i*0.13+phase)*amplitude;liquid.AddLine(px,py,px+2,surface+(float)Math.Sin((i+2)*0.13+phase)*amplitude);}liquid.AddLine(x+d,surface,x+d,y+d);liquid.CloseFigure();using var brush=new LinearGradientBrush(new RectangleF(x,y,d,d),Color.FromArgb(115,222,189),Color.FromArgb(30,116,105),90f);e.Graphics.FillPath(brush,liquid);}e.Graphics.Restore(state);using var pen=new Pen(Color.FromArgb(114,217,188),2);e.Graphics.DrawEllipse(pen,x+1,y+1,d-2,d-2);using var font=new Font("Segoe UI",13,FontStyle.Bold,GraphicsUnit.Point);var color=level>0.55?Color.FromArgb(8,45,43):Color.FromArgb(233,255,245);TextRenderer.DrawText(e.Graphics,current,font,ClientRectangle,color,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.SingleLine|TextFormatFlags.NoPadding);}
}
