public sealed record ProcessRequest(
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    int TimeoutMs,
    IReadOnlyDictionary<string, string>? Environment = null);

public sealed record ProcessResult(
    int ExitCode,
    string StandardOutput,
    string StandardError,
    bool TimedOut,
    long DurationMs);

public interface IProcessRunner
{
    Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancellationToken);
}

public static class ShellCommand
{
    public static (string FileName, string[] Arguments) For(string command) =>
        OperatingSystem.IsWindows()
            ? ("cmd.exe", new[] { "/c", command })
            : ("/bin/sh", new[] { "-c", command });

    public static (string FileName, string[] Arguments) OpenCode(string executable, params string[] arguments) =>
        OperatingSystem.IsWindows()
            ? ("cmd.exe", new[] { "/c", QuoteForCmd(executable) }.Concat(arguments.Select(QuoteForCmd)).ToArray())
            : (executable, arguments);

    private static readonly char[] CmdSpecials = { '&', '|', '<', '>', '^', '(', ')', '%', '!', '"' };

    private static string QuoteForCmd(string value) =>
        value.Length == 0 || value.Any(character => char.IsWhiteSpace(character) || CmdSpecials.Contains(character))
            ? "\"" + value.Replace("\"", "\"\"") + "\""
            : value;
}
