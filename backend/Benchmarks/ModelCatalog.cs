public sealed record ModelCatalogResult(string[] Models, string? Error);

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
                return new(Array.Empty<string>(), "opencode models tardó demasiado.");
            if (result.ExitCode != 0)
                return new(Array.Empty<string>(), string.IsNullOrWhiteSpace(result.StandardError)
                    ? $"opencode models terminó con código {result.ExitCode}."
                    : result.StandardError.Trim());

            return new(Parse(result.StandardOutput)
                .Where(model => !ExcludedPrefixes.Any(prefix => model.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                .ToArray(), null);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new(Array.Empty<string>(), ex.Message);
        }
    }

    public static string[] Parse(string stdout) => stdout
        .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Distinct(StringComparer.Ordinal)
        .OrderBy(line => line, StringComparer.Ordinal)
        .ToArray();
}
