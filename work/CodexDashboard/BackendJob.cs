using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace CodexDashboard;
internal sealed class BackendJob : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
  public long ProcessTime,JobTime;
  public uint Flags;
  public UIntPtr MinimumWorkingSet,MaximumWorkingSet;
  public uint ActiveProcesses;
  public UIntPtr Affinity;
  public uint Priority,Scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters {
  public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes;
 }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
  public BasicLimits Basic;
  public IoCounters Io;
  public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateJobObject(IntPtr attributes,string? name);
 [DllImport("kernel32.dll",SetLastError=true)]
 static extern bool SetInformationJobObject(SafeFileHandle job,int infoClass,ref ExtendedLimits information,uint length);
 [DllImport("kernel32.dll",SetLastError=true)]
 static extern bool AssignProcessToJobObject(SafeFileHandle job,IntPtr process);
 readonly SafeFileHandle handle;
 internal BackendJob(){
  handle=CreateJobObject(IntPtr.Zero,null);
  if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
  var limits=new ExtendedLimits{Basic=new BasicLimits{Flags=0x2000}};
  if(!SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimits>())){
   var error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error);
  }
 }
 internal void Add(Process process){
  if(!AssignProcessToJobObject(handle,process.Handle))throw new Win32Exception(Marshal.GetLastWin32Error());
 }
 public void Dispose()=>handle.Dispose();
}
