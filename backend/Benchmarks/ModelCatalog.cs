public sealed record ModelCatalogResult(string[] Models, string? Error, string? Code);

public sealed class ModelCatalog
{
    private static readonly string[] ExcludedPrefixes = { "nvidia/", "lmstudio/" };

    private readonly IProcessRunner _processRunner;
    private readonly string _openCodeCommand;

    public ModelCatalog(IProcessRunner processRunner, string openCodeCommand = "opencode")
    {
        _processRunner = processRunner;
        _openCodeCommand = openCodeCommand;
    }

    public async Task<ModelCatalogResult> ListAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var openCode = ShellCommand.OpenCode(_openCodeCommand, "models");
            var result = await _processRunner.RunAsync(
                new ProcessRequest(openCode.FileName, openCode.Arguments, Directory.GetCurrentDirectory(), 15000),
                cancellationToken);

            if (result.TimedOut)
                return new(Array.Empty<string>(), "opencode models timed out.", "model_catalog_timeout");
            if (result.ExitCode != 0)
                return string.IsNullOrWhiteSpace(result.StandardError)
                    ? new(Array.Empty<string>(), $"opencode models exited with code {result.ExitCode}.", "model_catalog_exit")
                    : new(Array.Empty<string>(), result.StandardError.Trim(), null);

            return new(Parse(result.StandardOutput)
                .Where(model => !ExcludedPrefixes.Any(prefix => model.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                .ToArray(), null, null);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new(Array.Empty<string>(), ex.Message, null);
        }
    }

    public static string[] Parse(string stdout) => stdout
        .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Distinct(StringComparer.Ordinal)
        .OrderBy(line => line, StringComparer.Ordinal)
        .ToArray();
}
