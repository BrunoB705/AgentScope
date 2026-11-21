using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

internal sealed class BenchmarkExecutor
{
    private readonly TelemetryDb _db;
    private readonly BenchmarkCatalog _catalog;
    private readonly IProcessRunner _processRunner;
    private readonly IBenchmarkSessionReader _sessionReader;
    private readonly IBenchmarkNotifier _notifier;
    private readonly IOptions<BenchmarkOptions> _options;
    private readonly IConfiguration _configuration;
    private readonly ILogger<BenchmarkExecutor> _logger;

    public BenchmarkExecutor(
        TelemetryDb db,
        BenchmarkCatalog catalog,
        IProcessRunner processRunner,
        IBenchmarkSessionReader sessionReader,
        IBenchmarkNotifier notifier,
        IOptions<BenchmarkOptions> options,
        IConfiguration configuration,
        ILogger<BenchmarkExecutor> logger)
    {
        _db = db;
        _catalog = catalog;
        _processRunner = processRunner;
        _sessionReader = sessionReader;
        _notifier = notifier;
        _options = options;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task ExecuteAsync(string runId, CancellationToken cancellationToken)
    {
        var run = await _db.BenchmarkRuns.FirstOrDefaultAsync(item => item.Id == runId, cancellationToken);
        if (run is null) return;

        var workRoot = _options.Value.WorkingRoot ?? Path.GetTempPath();
        var runRoot = Path.Combine(workRoot, run.Id);
        try
        {
            var suite = _catalog.Load(run.Suite);
            var results = await _db.BenchmarkResults
                .Where(item => item.RunId == runId)
                .OrderBy(item => item.Id)
                .ToListAsync(cancellationToken);

            run.Status = "running";
            run.StartedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync(cancellationToken);
            await _notifier.UpdatedAsync(run.Id, run.Status, cancellationToken);

            var baseline = await RunBaselineAsync(run, suite, runRoot, cancellationToken);
            if (baseline is null) return;
            run.BaselineJson = baseline;
            await _db.SaveChangesAsync(cancellationToken);

            foreach (var result in results)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await ExecuteResultAsync(run, result, suite, runRoot, cancellationToken);
                run.Completed++;
                await _db.SaveChangesAsync(cancellationToken);
                await _notifier.UpdatedAsync(run.Id, run.Status, cancellationToken);
            }

            if (run.RequestVerdict)
                await CreateVerdictAsync(run, results, runRoot, cancellationToken);

            cancellationToken.ThrowIfCancellationRequested();
            run.Status = "completed";
            run.CompletedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync(CancellationToken.None);
            await _notifier.UpdatedAsync(run.Id, run.Status, CancellationToken.None);
        }
        catch (BenchmarkValidationException ex)
        {
            await FailRunAsync(run, ex.Message, CancellationToken.None);
        }
        catch (OperationCanceledException)
        {
            await _db.BenchmarkResults
                .Where(result => result.RunId == runId && (result.Status == "pending" || result.Status == "running"))
                .ExecuteUpdateAsync(setters => setters.SetProperty(result => result.Status, "cancelled"), CancellationToken.None);
            await _db.BenchmarkRuns
                .Where(item => item.Id == runId && item.Status != "cancelled")
                .ExecuteUpdateAsync(setters => setters
                    .SetProperty(item => item.Status, "cancelled")
                    .SetProperty(item => item.CompletedAt, DateTime.UtcNow), CancellationToken.None);
            await _db.Entry(run).ReloadAsync(CancellationToken.None);
            await _notifier.UpdatedAsync(run.Id, run.Status, CancellationToken.None);
        }
        catch (DbUpdateConcurrencyException)
        {
            try
            {
                await _db.Entry(run).ReloadAsync(CancellationToken.None);
            }
            catch (Exception)
            {
                return;
            }

            if (run.Status == "cancelled")
            {
                foreach (var item in await _db.BenchmarkResults
                    .Where(result => result.RunId == runId && (result.Status == "pending" || result.Status == "running"))
                    .ToListAsync(CancellationToken.None))
                    item.Status = "cancelled";
            }
            else
            {
                run.Status = "failed";
                run.Error = "La corrida cambió de estado mientras se ejecutaba.";
                run.CompletedAt = DateTime.UtcNow;
                foreach (var item in await _db.BenchmarkResults
                    .Where(result => result.RunId == runId && (result.Status == "pending" || result.Status == "running"))
                    .ToListAsync(CancellationToken.None))
                    item.Status = "failed";
            }

            await _db.SaveChangesAsync(CancellationToken.None);
            await _notifier.UpdatedAsync(run.Id, run.Status, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Falló la corrida de benchmark {RunId}", run.Id);
            run.Status = "failed";
            run.Error = ex.Message;
            run.CompletedAt = DateTime.UtcNow;
            foreach (var item in await _db.BenchmarkResults
                .Where(result => result.RunId == runId && (result.Status == "pending" || result.Status == "running"))
                .ToListAsync(CancellationToken.None))
                item.Status = "failed";
            await _db.SaveChangesAsync(CancellationToken.None);
            await _notifier.UpdatedAsync(run.Id, run.Status, CancellationToken.None);
        }
        finally
        {
            Cleanup(workRoot, runRoot);
        }
    }

    private async Task<string?> RunBaselineAsync(
        BenchmarkRunEntity run,
        BenchmarkSuite suite,
        string runRoot,
        CancellationToken cancellationToken)
    {
        var records = new List<object>();
        foreach (var test in suite.Tests.Where(item => item.Type == "code"))
        {
            var directory = Path.Combine(runRoot, "baseline");
            try
            {
                ResetDirectory(runRoot, directory);
                CopyDirectory(test.FixturePath!, directory);
                var shell = ShellCommand.For(test.VerifyCommand!);
                ProcessResult verify;
                try
                {
                    verify = await _processRunner.RunAsync(
                        new ProcessRequest(shell.FileName, shell.Arguments, directory, test.VerifyTimeoutMs),
                        cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    await FailRunAsync(run, $"No se pudo ejecutar verify de línea base: {ex.Message}", CancellationToken.None);
                    return null;
                }

                if (verify.TimedOut)
                {
                    await FailRunAsync(run, $"El verify de línea base de '{test.Name}' superó el timeout.", CancellationToken.None);
                    return null;
                }

                records.Add(new { test = test.Name, passed = verify.ExitCode == 0, exitCode = verify.ExitCode, error = (string?)null });
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                await FailRunAsync(run, $"No se pudo preparar la línea base: {ex.Message}", CancellationToken.None);
                return null;
            }
            finally
            {
                Cleanup(runRoot, directory);
            }
        }
        return JsonSerializer.Serialize(records);
    }

    private async Task ExecuteResultAsync(
        BenchmarkRunEntity run,
        BenchmarkResultEntity result,
        BenchmarkSuite suite,
        string runRoot,
        CancellationToken cancellationToken)
    {
        var test = suite.Tests.FirstOrDefault(item => item.Name == result.TestName);
        if (test is null)
        {
            result.Status = "failed";
            result.Error = "La prueba ya no existe en la suite.";
            result.CompletedAt = DateTime.UtcNow;
            return;
        }

        result.Status = "running";
        result.StartedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync(cancellationToken);

        var workDir = Path.Combine(runRoot, result.Id, "benchmark");
        var judgeDir = Path.Combine(runRoot, result.Id, "benchmark-judge");
        var promptDir = Path.Combine(runRoot, result.Id, "prompts");
        Directory.CreateDirectory(promptDir);
        try
        {
            ResetDirectory(runRoot, workDir);
            if (test.Type == "code")
            {
                CopyDirectory(test.FixturePath!, workDir);
                if (!await InitGitAsync(workDir, cancellationToken))
                {
                    result.Status = "failed";
                    result.Error = "No se pudo inicializar git en el fixture.";
                    result.CompletedAt = DateTime.UtcNow;
                    return;
                }
            }

            var promptPath = Path.Combine(promptDir, $"{result.Id}-prompt.md");
            await File.WriteAllTextAsync(promptPath, BenchmarkPrompt.Prefix + test.Prompt, cancellationToken);

            var environment = TelemetryEnvironment();

            var modelTitle = $"bench/{run.Id}/{result.Id}";
            var openCode = ShellCommand.OpenCode(
                _options.Value.OpenCodeCommand,
                "--standalone", "run", "--model", result.Model, "--title", modelTitle, "--format", "json", "--auto",
                "--file", promptPath, "Seguí las instrucciones del archivo adjunto.");
            var model = await _processRunner.RunAsync(new ProcessRequest(
                openCode.FileName,
                openCode.Arguments,
                workDir,
                suite.ModelTimeoutMs,
                environment), cancellationToken);

            result.DurationMs = model.DurationMs;
            if (model.TimedOut)
            {
                result.Status = "timedout";
                result.Error = "El modelo superó el timeout.";
                result.CompletedAt = DateTime.UtcNow;
                return;
            }

            var finalText = OpenCodeOutput.ExtractFinalText(model.StandardOutput) ?? "";
            var parsedSessionId = OpenCodeOutput.ExtractSessionId(model.StandardOutput);
            var diff = "";

            if (test.Type == "code")
            {
                await RunGitAsync(workDir, new[] { "add", "-A" }, cancellationToken);
                var diffResult = await _processRunner.RunAsync(
                    new ProcessRequest("git", new[] { "diff", "--cached", "--no-ext-diff", "--no-binary" }, workDir, 30000),
                    cancellationToken);
                diff = Truncate(diffResult.StandardOutput, 40000);

                var shell = ShellCommand.For(test.VerifyCommand!);
                var verify = await _processRunner.RunAsync(
                    new ProcessRequest(shell.FileName, shell.Arguments, workDir, test.VerifyTimeoutMs),
                    cancellationToken);
                if (verify.TimedOut)
                {
                    result.Status = "timedout";
                    result.Error = "verify superó el timeout.";
                    result.CompletedAt = DateTime.UtcNow;
                    return;
                }
                result.VerifyPassed = verify.ExitCode == 0;
                result.VerifyExitCode = verify.ExitCode;
            }

            if (test.Type == "open" || test.Judge)
            {
                var cappedText = Truncate(finalText, 20000);
                var artifact = test.Type == "code" ? cappedText + "\n\nDIFF\n" + diff : cappedText;
                var rubric = test.Rubric.Length > 0 ? test.Rubric : new[] { "Corrección funcional", "Claridad del cambio" };
                var judgePath = Path.Combine(promptDir, $"{result.Id}-judge.md");
                await File.WriteAllTextAsync(judgePath, JudgePrompt.Build(test.Prompt, rubric, artifact), cancellationToken);

                ResetDirectory(runRoot, judgeDir);
                var judgeCommand = ShellCommand.OpenCode(
                    _options.Value.OpenCodeCommand,
                    "--standalone", "run", "--model", run.JudgeModel, "--title", $"bench-judge/{run.Id}/{result.Id}",
                    "--format", "json", "--archived", "--file", judgePath,
                    "Evaluá el archivo adjunto y respondé sólo JSON.");
                var judge = await _processRunner.RunAsync(new ProcessRequest(
                    judgeCommand.FileName,
                    judgeCommand.Arguments,
                    judgeDir,
                    _options.Value.JudgeTimeoutMs,
                    environment), cancellationToken);

                result.JudgeSessionId = OpenCodeOutput.ExtractSessionId(judge.StandardOutput);
                if (judge.TimedOut)
                {
                    result.Error = "El juez superó el timeout.";
                }
                else
                {
                    var judgeText = OpenCodeOutput.ExtractFinalText(judge.StandardOutput);
                    var score = judgeText is null ? null : JudgeResponse.Parse(judgeText);
                    if (score is null)
                    {
                        result.Error = "El juez no devolvió un JSON válido.";
                    }
                    else
                    {
                        result.JudgeScore = score.Score;
                        result.JudgeRationale = Truncate(score.Rationale, 500);
                    }
                }
            }

            var metrics = await _sessionReader.FindByTitleAsync(
                modelTitle,
                TimeSpan.FromMilliseconds(_options.Value.TelemetryWaitMs),
                cancellationToken);
            if (metrics is null)
            {
                result.MetricsError = "No llegó la telemetría de la sesión.";
                result.SessionId = parsedSessionId;
            }
            else
            {
                result.SessionId = metrics.SessionId;
                result.InputTokens = metrics.InputTokens;
                result.OutputTokens = metrics.OutputTokens;
                result.ReasoningTokens = metrics.ReasoningTokens;
                result.CacheReadTokens = metrics.CacheReadTokens;
                result.CacheWriteTokens = metrics.CacheWriteTokens;
                result.Cost = metrics.Cost;
                result.QuotaCostEstimate = metrics.QuotaCostEstimate;
            }

            result.Status = "completed";
            result.CompletedAt = DateTime.UtcNow;
        }
        catch (OperationCanceledException)
        {
            result.Status = "cancelled";
            result.CompletedAt = DateTime.UtcNow;
            throw;
        }
        finally
        {
            Cleanup(runRoot, Path.Combine(runRoot, result.Id));
        }
    }

    private async Task CreateVerdictAsync(
        BenchmarkRunEntity run,
        IReadOnlyList<BenchmarkResultEntity> results,
        string runRoot,
        CancellationToken cancellationToken)
    {
        var verdictRoot = Path.Combine(runRoot, "verdict");
        var promptDir = Path.Combine(verdictRoot, "prompt");
        var judgeDir = Path.Combine(verdictRoot, "benchmark-judge");
        try
        {
            ResetDirectory(runRoot, verdictRoot);
            Directory.CreateDirectory(promptDir);
            ResetDirectory(runRoot, judgeDir);

            var promptPath = Path.Combine(promptDir, "verdict.md");
            await File.WriteAllTextAsync(promptPath, VerdictPrompt.Build(run, results), cancellationToken);

            var command = ShellCommand.OpenCode(
                _options.Value.OpenCodeCommand,
                "--standalone", "run", "--model", run.JudgeModel, "--title", $"bench-verdict/{run.Id}",
                "--format", "json", "--archived", "--file", promptPath,
                "Leé el resumen adjunto y recomendá un modelo.");
            var verdict = await _processRunner.RunAsync(new ProcessRequest(
                command.FileName,
                command.Arguments,
                judgeDir,
                _options.Value.JudgeTimeoutMs,
                TelemetryEnvironment()), cancellationToken);

            if (verdict.TimedOut)
            {
                run.Verdict = "La recomendación final superó el timeout.";
                return;
            }

            var text = OpenCodeOutput.ExtractFinalText(verdict.StandardOutput);
            if (!string.IsNullOrWhiteSpace(text))
                run.Verdict = Truncate(VerdictText.Extract(text), 1000);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "No se pudo generar la recomendación final de {RunId}", run.Id);
        }
        finally
        {
            Cleanup(runRoot, verdictRoot);
        }
    }

    private Dictionary<string, string> TelemetryEnvironment() => new()
    {
        ["OPENCODE_OBSERVABILITY_URL"] = _options.Value.TelemetryUrl,
        ["OPENCODE_OBSERVABILITY_KEY"] = _configuration["Telemetry:ApiKey"] ?? "",
    };

    private async Task FailRunAsync(BenchmarkRunEntity run, string error, CancellationToken cancellationToken)
    {
        run.Status = "failed";
        run.Error = error;
        run.CompletedAt = DateTime.UtcNow;
        foreach (var result in await _db.BenchmarkResults
            .Where(item => item.RunId == run.Id && (item.Status == "pending" || item.Status == "running"))
            .ToListAsync(cancellationToken))
            result.Status = "failed";
        await _db.SaveChangesAsync(cancellationToken);
        await _notifier.UpdatedAsync(run.Id, run.Status, cancellationToken);
    }

    private async Task<bool> InitGitAsync(string directory, CancellationToken cancellationToken)
    {
        if (!await RunGitAsync(directory, new[] { "init" }, cancellationToken)) return false;
        if (!await RunGitAsync(directory, new[] { "add", "." }, cancellationToken)) return false;
        return await RunGitAsync(directory, new[]
        {
            "-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-m", "baseline",
        }, cancellationToken);
    }

    private async Task<bool> RunGitAsync(string directory, string[] arguments, CancellationToken cancellationToken)
    {
        var result = await _processRunner.RunAsync(
            new ProcessRequest("git", arguments, directory, 30000),
            cancellationToken);
        return result.ExitCode == 0;
    }

    internal static string EnsureChildPath(string root, string candidate)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var fullCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var prefix = fullRoot.Length == 0 ? Path.DirectorySeparatorChar.ToString() : fullRoot + Path.DirectorySeparatorChar;
        if (fullCandidate.Length <= fullRoot.Length || !fullCandidate.StartsWith(prefix, comparison))
            throw new InvalidOperationException($"La ruta '{candidate}' queda fuera de la raíz permitida '{root}'.");
        return fullCandidate;
    }

    internal static void ResetDirectory(string root, string path)
    {
        var safe = EnsureChildPath(root, path);
        if (Directory.Exists(safe)) Directory.Delete(safe, recursive: true);
        Directory.CreateDirectory(safe);
    }

    internal static void Cleanup(string root, string path)
    {
        var safe = EnsureChildPath(root, path);
        try
        {
            if (Directory.Exists(safe)) Directory.Delete(safe, recursive: true);
        }
        catch (IOException)
        {
            // La limpieza es best-effort; el sistema operativo liberará el temporal.
        }
        catch (UnauthorizedAccessException)
        {
            // La limpieza es best-effort.
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            if (relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Contains(".git")) continue;
            var target = Path.Combine(destination, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }

    internal static string Truncate(string value, int max)
    {
        if (max <= 0) return "";
        if (value.Length <= max) return value;
        var cut = value[..max];
        return char.IsHighSurrogate(cut[^1]) ? cut[..^1] : cut;
    }
}
