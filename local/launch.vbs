Option Explicit
Dim fs, sh, root, data, logPath, command, result
Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
data = fs.BuildPath(root, ".local-data")
If Not fs.FolderExists(data) Then fs.CreateFolder data
logPath = fs.BuildPath(data, "startup.log")
command = "cmd.exe /d /c " & Chr(34) & Chr(34) & fs.BuildPath(root, "local\start.cmd") & Chr(34) & " > " & Chr(34) & logPath & Chr(34) & " 2>&1" & Chr(34)
result = sh.Run(command, 0, True)
If result <> 0 Then MsgBox "The course assistant could not start. Please check:" & vbCrLf & logPath, vbExclamation, "Course Assistant"
