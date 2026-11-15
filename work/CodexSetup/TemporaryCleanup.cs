namespace CodexSetup;
internal static class TemporaryCleanup {
 // A just-exited process or antivirus may hold extracted files briefly.
 // Cleanup failure must never turn a successful installation into a failure.
 internal static bool TryDelete(string directory,Action<string,bool>? delete=null,Action<int>? wait=null){
  delete??=Directory.Delete;wait??=Thread.Sleep;
  for(int attempt=0;attempt<10;attempt++){
   try{if(Directory.Exists(directory))delete(directory,true);return true;}
   catch(IOException) when(attempt<9){wait(250);}
   catch(UnauthorizedAccessException) when(attempt<9){wait(250);}
   catch(IOException){return false;}
   catch(UnauthorizedAccessException){return false;}
  }
  return false;
 }
}
