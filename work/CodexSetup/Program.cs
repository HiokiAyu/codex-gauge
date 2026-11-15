using System.Diagnostics;
using System.Globalization;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;

namespace CodexSetup;
internal static class Program {
 [STAThread] static void Main(string[] args){
  if(args.Contains("--silent")){
   var index=Array.IndexOf(args,"--target");
   if(index<0||index+1>=args.Length){Environment.ExitCode=2;return;}
   var dataIndex=Array.IndexOf(args,"--data-directory");
   var data=dataIndex>=0&&dataIndex+1<args.Length?args[dataIndex+1]:null;
   var resultIndex=Array.IndexOf(args,"--result");
   var result=resultIndex>=0&&resultIndex+1<args.Length?args[resultIndex+1]:null;
   string? error=null;
   bool? Option(string on,string off)=>args.Contains(on)?true:args.Contains(off)?false:null;
   try{InstallerEngine.Install(args[index+1],dataDirectory:data,integrate:!args.Contains("--no-integrations"),startup:Option("--startup-on","--startup-off"),desktop:Option("--desktop-on","--desktop-off")).GetAwaiter().GetResult();}
   catch(Exception failure){Environment.ExitCode=1;error=failure.Message;}
   if(result!=null)File.WriteAllText(result,JsonSerializer.Serialize(new {success=error==null,error}));
   return;
  }
  ApplicationConfiguration.Initialize();
  Application.Run(new InstallerWindow());
 }
}

internal sealed class InstallerWindow:Form {
 readonly Icon brandIcon=LoadBrandIcon();
 static Icon LoadBrandIcon(){using var stream=typeof(InstallerWindow).Assembly.GetManifestResourceStream("AppIcon.ico")??throw new InvalidOperationException("App icon missing");return new Icon(stream);}
 readonly Label status=new(){AutoSize=false,Height=55};
 readonly Button install=new(){AutoSize=true};
 readonly Button close=new(){Text="×",Width=40,Height=32,FlatStyle=FlatStyle.Flat};
 readonly ProgressBar progress=new(){Style=ProgressBarStyle.Marquee,Visible=false,Height=5};
 readonly TextBox location=new();
 readonly Button browse=new(){AutoSize=true};
 readonly CheckBox startup=new(){AutoSize=true};
 readonly CheckBox desktop=new(){AutoSize=true};
 readonly CheckBox openAfter=new(){AutoSize=true,Checked=true};
 readonly Dictionary<string,string> strings;
 bool running,completed;
 string TextFor(string key)=>strings.GetValueOrDefault(key,key);
 [DllImport("user32.dll")] static extern bool ReleaseCapture();
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window,int message,IntPtr wParam,IntPtr lParam);

 static bool LightTheme(string? value){
  if(value==null)try{
   var file=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexUsageDashboard","preferences.json");
   using var prefs=JsonDocument.Parse(File.ReadAllText(file));value=prefs.RootElement.GetProperty("theme").GetString();
  }catch{}
  return string.Equals(value,"light",StringComparison.OrdinalIgnoreCase);
 }
 internal InstallerWindow(string? themeOverride=null){
  Icon=brandIcon;FormClosed+=(_,_)=>brandIcon.Dispose();
  var culture=CultureInfo.CurrentUICulture.Name;
  var language=culture.StartsWith("ja")?"ja":culture.StartsWith("zh")?
   (culture.Contains("TW")||culture.Contains("HK")?"zh-TW":"zh-CN"):"en";
  using var catalog=InstallerEngine.Resource("locales/"+language+".json");
  using var parsed=JsonDocument.Parse(catalog);
  strings=parsed.RootElement.GetProperty("strings").EnumerateObject()
   .ToDictionary(property=>property.Name,property=>property.Value.GetString()??property.Name);
  Text=TextFor("setupTitle");FormBorderStyle=FormBorderStyle.None;StartPosition=FormStartPosition.CenterScreen;
  var light=LightTheme(themeOverride);
  ClientSize=new Size(610,365);BackColor=light?Color.FromArgb(246,249,248):Color.FromArgb(14,23,35);ForeColor=light?Color.FromArgb(30,48,46):Color.FromArgb(232,240,248);
  Font=new Font("Segoe UI",10);Padding=new Padding(25);MaximizeBox=false;
  using var shape=new GraphicsPath();
  shape.AddArc(0,0,22,22,180,90);shape.AddArc(Width-22,0,22,22,270,90);
  shape.AddArc(Width-22,Height-22,22,22,0,90);shape.AddArc(0,Height-22,22,22,90,90);shape.CloseFigure();
  Region=new Region(shape);
  using var manifest=InstallerEngine.Manifest();
  var title=new Label {Text=Text+" · "+manifest.RootElement.GetProperty("version").GetString(),
   Location=new Point(25,20),Width=490,Height=30,Font=new Font(Font.FontFamily,13,FontStyle.Bold)};
  title.MouseDown+=(_,e)=>{if(e.Button==MouseButtons.Left){ReleaseCapture();SendMessage(Handle,0xa1,(IntPtr)2,IntPtr.Zero);}};
  close.Location=new Point(550,15);close.ForeColor=ForeColor;close.FlatAppearance.BorderSize=0;close.Click+=(_,_)=>Close();
  var pathLabel=new Label{Text=TextFor("setupLocation"),Location=new Point(25,62),Width=540,Height=24};
  var existing=InstallerEngine.ExistingTarget();
  location.Text=existing??InstallerEngine.DefaultTarget;location.Location=new Point(25,91);location.Width=440;
  browse.Text=TextFor("setupBrowse");browse.Location=new Point(475,87);browse.MinimumSize=new Size(105,32);
  browse.Click+=(_,_)=>{using var dialog=new FolderBrowserDialog{Description=TextFor("setupLocation"),UseDescriptionForTitle=true};
   if(Directory.Exists(location.Text))dialog.InitialDirectory=location.Text;
   if(dialog.ShowDialog(this)==DialogResult.OK){var selected=Path.TrimEndingDirectorySeparator(dialog.SelectedPath);
    location.Text=string.Equals(Path.GetFileName(selected),"CodexUsageDashboard",StringComparison.OrdinalIgnoreCase)?selected:Path.Combine(selected,"CodexUsageDashboard");}};
  startup.Text=TextFor("setupStartup");startup.Location=new Point(25,137);startup.ForeColor=ForeColor;
  desktop.Text=TextFor("setupDesktop");desktop.Location=new Point(25,169);desktop.ForeColor=ForeColor;
  openAfter.Text=TextFor("setupOpenAfter");openAfter.Location=new Point(25,201);openAfter.ForeColor=ForeColor;
  using(var run=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
   startup.Checked=existing!=null&&(run?.GetValue("CodexUsageDashboard") as string)?.StartsWith("\""+Path.Combine(existing,"Codex大看板.exe")+"\"",StringComparison.OrdinalIgnoreCase)==true;
  desktop.Checked=existing!=null&&ShortcutPointsTo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Codex 用量.lnk"),Path.Combine(existing,"Codex大看板.exe"));
  status.Location=new Point(25,238);status.Width=555;status.Height=45;status.Text=TextFor("setupReady");
  progress.Location=new Point(25,291);progress.Width=555;
  install.Text=TextFor("setupAction");install.Location=new Point(425,312);install.MinimumSize=new Size(155,35);
  install.BackColor=Color.FromArgb(32,104,85);install.ForeColor=Color.White;install.FlatStyle=FlatStyle.Flat;
  install.FlatAppearance.BorderSize=0;
  install.Click+=async(_,_)=>{
   if(completed){Close();return;}
   string selected;
   try{selected=Path.TrimEndingDirectorySeparator(Path.GetFullPath(location.Text));if(!Path.IsPathFullyQualified(location.Text)||selected==Path.GetPathRoot(selected))throw new IOException();}
   catch{status.Text=TextFor("setupInvalidPath");return;}
   var desktopPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Codex 用量.lnk");
   if(desktop.Checked&&File.Exists(desktopPath)&&!ShortcutPointsTo(desktopPath,Path.Combine(selected,"Codex大看板.exe"))){status.Text=TextFor("setupDesktopConflict");return;}
   running=true;close.Enabled=false;install.Enabled=false;browse.Enabled=false;location.Enabled=false;startup.Enabled=false;desktop.Enabled=false;openAfter.Enabled=false;progress.Visible=true;
   try{
    await InstallerEngine.Install(selected,new Progress<string>(key=>status.Text=TextFor(key)),startup:startup.Checked,desktop:desktop.Checked);
    completed=true;install.Text=TextFor("setupDone");
    if(openAfter.Checked)try{Process.Start(new ProcessStartInfo(Path.Combine(selected,"Codex大看板.exe")){UseShellExecute=true});}catch{status.Text=TextFor("setupLaunchFailed");}
   }catch(LegacyTargetRunningException){
    status.Text=TextFor("setupCloseLegacy");
    install.Text=TextFor("setupRetry");
   }catch(Exception error) when(error.Message.Contains("EXISTING_INSTALL_ELSEWHERE",StringComparison.Ordinal)){
    status.Text=TextFor("setupOtherInstall");install.Text=TextFor("setupRetry");
   }catch(Exception error) when(error.Message.Contains("INSTALL_PATH_",StringComparison.Ordinal)){
    status.Text=TextFor("setupPathOccupied");install.Text=TextFor("setupRetry");
   }catch(Exception error) when(error.Message.Contains("INSTALL_NO_SPACE",StringComparison.Ordinal)){
    status.Text=TextFor("setupNoSpace");install.Text=TextFor("setupRetry");
   }catch{
    status.Text=TextFor("setupFailed");
    install.Text=TextFor("setupRetry");
   }finally{running=false;close.Enabled=true;install.Enabled=true;browse.Enabled=!completed;location.Enabled=!completed;startup.Enabled=!completed;desktop.Enabled=!completed;openAfter.Enabled=!completed;progress.Visible=false;}
  };
  FormClosing+=(_,e)=>{if(running)e.Cancel=true;};
  Controls.AddRange([title,close,pathLabel,location,browse,startup,desktop,openAfter,status,progress,install]);
  AcceptButton=install;
 }
 static bool ShortcutPointsTo(string shortcut,string target){
  if(!File.Exists(shortcut))return false;object? shell=null,link=null;
  try{shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!);dynamic s=shell!;link=s.CreateShortcut(shortcut);dynamic l=link!;return string.Equals((string)l.TargetPath,target,StringComparison.OrdinalIgnoreCase);}
  catch{return false;}finally{if(link!=null)Marshal.FinalReleaseComObject(link);if(shell!=null)Marshal.FinalReleaseComObject(shell);}
 }
}
