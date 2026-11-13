Option Explicit

Dim shell, fso, scriptPath, command, exitCode, logPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "launch-agentscope.ps1")
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """"
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
    logPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\AgentObservabilityPlatform\logs"
    MsgBox "AgentScope no pudo iniciarse. Revisa los registros en " & logPath & ".", 16, "AgentScope"
End If
