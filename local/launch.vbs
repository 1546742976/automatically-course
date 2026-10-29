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
If result <> 0 Then MsgBox ChrW(23398) & ChrW(20064) & ChrW(36890) & ChrW(21161) & ChrW(25163) & ChrW(21551) & ChrW(21160) & ChrW(22833) & ChrW(36133) & ChrW(65292) & ChrW(35831) & ChrW(26597) & ChrW(30475) & ChrW(26085) & ChrW(24535) & ChrW(20013) & ChrW(30340) & ChrW(22833) & ChrW(36133) & ChrW(21407) & ChrW(22240) & ChrW(65306) & vbCrLf & logPath, vbExclamation, ChrW(23398) & ChrW(20064) & ChrW(36890) & ChrW(21161) & ChrW(25163)
