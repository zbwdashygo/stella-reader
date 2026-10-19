Option Explicit
Dim fso, sh, appDir, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = appDir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exePath) Then
  MsgBox "Electron runtime is missing. Please restore the application runtime.", 16, "Stella Reader"
  WScript.Quit 1
End If
On Error Resume Next
sh.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
sh.Environment("PROCESS").Remove "ELECTRON_NO_ATTACH_CONSOLE"
sh.Environment("PROCESS").Remove "ELECTRON_ENABLE_LOGGING"
On Error GoTo 0
sh.CurrentDirectory = appDir
sh.Run """" & exePath & """ """ & appDir & """", 1, False
