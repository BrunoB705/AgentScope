using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

public sealed class BenchmarkExecutorTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"bench-exec-{Guid.NewGuid():N}");
    private TelemetryDb? _db;

    public void Dispose()
    {
        _db?.Dispose();
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private static string JsonText(string text, string sessionId) =>
        JsonSerializer.Serialize(new { type = "text", part = new { type = "text", text }, sessionID = sessionId });

    private static ProcessResult ModelResult() => new(0, JsonText("respuesta", "ses_model"), "", false, 1200);

    private static ProcessResult JudgeResult() => new(0, JsonText("{\"score\":4,\"rationale\":\"ok\"}", "ses_judge"), "", false, 10);

    private static bool IsJudge(ProcessRequest request) => request.Arguments.Contains("--archived");

    private static bool IsModel(ProcessRequest request) => request.Arguments.Contains("--model") && !IsJudge(request);

    private static bool IsVerify(ProcessRequest request) =>
        (request.FileName is "cmd.exe" or "/bin/sh") && !request.Arguments.Contains("--model");

    private static ProcessResult DefaultHandler(ProcessRequest request)
    {
        if (request.FileName == "git")
            return request.Arguments.Contains("diff")
                ? new ProcessResult(0, "diff de prueba", "", false, 10)
                : new ProcessResult(0, "", "", false, 10);
        if (IsVerify(request)) return new ProcessResult(0, "", "", false, 10);
        if (IsJudge(request)) return JudgeResult();
        return ModelResult();
    }

    private static string ArgValue(ProcessRequest request, string name)
    {
        var index = request.Arguments.ToList().IndexOf(name);
        return index >= 0 && index + 1 < request.Arguments.Count ? request.Arguments[index + 1] : "";
    }

    private void WriteSuite(string type, bool judge)
    {
        var suite = Path.Combine(_root, "demo");
        Directory.CreateDirectory(Path.Combine(suite, "prompts"));
        Directory.CreateDirectory(Path.Combine(suite, "fixtures", "app"));
        var test = type == "code"
            ? $$"""
              {
                "name": "code-test",
                "type": "code",
                "promptFile": "prompts/code.md",
                "fixture": "fixtures/app",
                "verify": { "command": "node --test", "timeoutMs": 120000 },
                "judge": {{(judge ? "true" : "false")}}
              }
              """
            : """
              {
                "name": "open-test",
                "type": "open",
                "promptFile": "prompts/open.md",
                "rubric": ["Claridad"]
              }
              """;
        File.WriteAllText(Path.Combine(suite, "suite.json"), $$"""
        {
          "name": "Demo",
          "defaultJudge": "judge/model",
          "modelTimeoutMs": 300000,
          "tests": [{{test}}]
        }
        """);
        File.WriteAllText(Path.Combine(suite, "prompts", "code.md"), "Corregí el bug.");
        File.WriteAllText(Path.Combine(suite, "prompts", "open.md"), "Explicá la caché.");
        File.WriteAllText(Path.Combine(suite, "fixtures", "app", "app.txt"), "app");
    }

    private Harness Create(string type = "code", bool judge = false, int results = 1, bool verdict = false)
    {
        WriteSuite(type, judge);
        var db = new TelemetryDb(new DbContextOptionsBuilder<TelemetryDb>()
            .UseSqlite($"Data Source={Path.Combine(_root, $"bench-{Guid.NewGuid():N}.db")};Pooling=False")
            .Options);
        db.Database.EnsureCreated();
        BenchmarkStorage.EnsureAsync(db).GetAwaiter().GetResult();

        var suite = new BenchmarkCatalog(_root).Load("demo");
        var run = new BenchmarkRunEntity
        {
            Id = "run1",
            Suite = "demo",
            JudgeModel = "judge/model",
            Status = "queued",
            Total = results,
            CreatedAt = DateTime.UtcNow,
            RequestVerdict = verdict,
        };
        db.BenchmarkRuns.Add(run);
        for (var index = 0; index < results; index++)
        {
            db.BenchmarkResults.Add(new BenchmarkResultEntity
            {
                Id = $"res{index + 1}",
                RunId = run.Id,
                TestName = suite.Tests[0].Name,
                TestType = suite.Tests[0].Type,
                Model = "provider/model-a",
                Status = "pending",
            });
        }
        db.SaveChanges();
        _db = db;

        var process = new FakeProcessRunner { Handler = DefaultHandler };
        var sessions = new FakeSessionReader();
        var notifier = new FakeNotifier();
        var options = Options.Create(new BenchmarkOptions
        {
            Root = _root,
            OpenCodeCommand = "opencode",
            JudgeTimeoutMs = 120000,
            TelemetryWaitMs = 15000,
            TelemetryUrl = "http://127.0.0.1:9",
            WorkingRoot = Path.Combine(_root, "work"),
        });
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Telemetry:ApiKey"] = "test-key" })
            .Build();
        var executor = new BenchmarkExecutor(db, new BenchmarkCatalog(_root), process, sessions, notifier, options, configuration, NullLogger<BenchmarkExecutor>.Instance);
        return new(executor, db, process, sessions, notifier, run.Id);
    }

    [Fact]
    public async Task ExecuteAsync_CodeTest_StoresVerifyPassedAndMetrics()
    {
        var harness = Create("code");
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);

        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal("completed", result.Status);
        Assert.True(result.VerifyPassed);
        Assert.Equal(0, result.VerifyExitCode);
        Assert.Equal(1200, result.DurationMs);
        Assert.Equal(100, result.InputTokens);
        Assert.Equal(7, result.ReasoningTokens);
        Assert.Equal("ses_model", result.SessionId);
        var run = harness.Db.BenchmarkRuns.Single();
        Assert.Equal("completed", run.Status);
        Assert.Equal(1, run.Completed);
    }

    [Fact]
    public async Task ExecuteAsync_OpenTest_StoresJudgeScore()
    {
        var harness = Create("open");
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);

        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal("completed", result.Status);
        Assert.Equal(4, result.JudgeScore);
        Assert.Equal("ok", result.JudgeRationale);
        Assert.Equal("ses_judge", result.JudgeSessionId);
        Assert.Contains("--standalone", harness.Process.Requests.First(IsJudge).Arguments);
    }

    [Fact]
    public async Task ExecuteAsync_CodeWithJudge_SendsFinalTextAndDiff()
    {
        var harness = Create("code", judge: true);
        string? captured = null;
        harness.Process.Handler = request =>
        {
            if (IsJudge(request))
            {
                captured = File.ReadAllText(ArgValue(request, "--file"));
                return JudgeResult();
            }
            return DefaultHandler(request);
        };
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        Assert.Contains("respuesta", captured);
        Assert.Contains("diff de prueba", captured);
    }

    [Fact]
    public async Task ExecuteAsync_Timeout_MarksTimedOutAndContinues()
    {
        var harness = Create("code");
        var modelCalls = 0;
        harness.Process.Handler = request =>
        {
            if (IsModel(request))
            {
                modelCalls++;
                return modelCalls == 1
                    ? new ProcessResult(-1, "", "", true, 300)
                    : ModelResult();
            }
            return DefaultHandler(request);
        };
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal("timedout", result.Status);
        Assert.Equal(BenchmarkErrorText.Encode("model_timeout"), result.Error);
        Assert.Equal("completed", harness.Db.BenchmarkRuns.Single().Status);
    }

    [Fact]
    public async Task ExecuteAsync_TelemetryMissing_StoresMetricsError()
    {
        var harness = Create("code");
        harness.Sessions.Result = null;
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal("completed", result.Status);
        Assert.Equal(BenchmarkErrorText.Encode("metrics_missing"), result.MetricsError);
    }

    [Fact]
    public async Task ExecuteAsync_Cancel_MarksPendingCancelled()
    {
        var harness = Create("code", results: 2);
        using var cancellation = new CancellationTokenSource();
        harness.Process.Handler = request =>
        {
            if (IsModel(request))
            {
                cancellation.Cancel();
                throw new OperationCanceledException();
            }
            return DefaultHandler(request);
        };
        await harness.Executor.ExecuteAsync(harness.RunId, cancellation.Token);

        harness.Db.ChangeTracker.Clear();
        var results = harness.Db.BenchmarkResults.OrderBy(item => item.Id).ToList();
        Assert.All(results, result => Assert.Equal("cancelled", result.Status));
        Assert.Equal("cancelled", harness.Db.BenchmarkRuns.Single().Status);
    }

    [Fact]
    public async Task ExecuteAsync_BaselinePasses_WritesWarning()
    {
        var harness = Create("code");
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        Assert.Contains("\"passed\":true", harness.Db.BenchmarkRuns.Single().BaselineJson);
    }

    [Fact]
    public async Task ExecuteAsync_BaselineCannotStart_FailsRunBeforeModel()
    {
        var harness = Create("code");
        harness.Process.Handler = request => IsVerify(request)
            ? new ProcessResult(-1, "", "", true, 300)
            : DefaultHandler(request);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var run = harness.Db.BenchmarkRuns.Single();
        Assert.Equal("failed", run.Status);
        Assert.Equal(
            BenchmarkErrorText.Encode("baseline_verify_timeout", new Dictionary<string, string> { ["test"] = "code-test" }),
            run.Error);
        Assert.DoesNotContain(harness.Process.Requests, IsModel);
    }

    [Fact]
    public async Task ExecuteAsync_BaselineVerifyThrows_StoresEncodedError()
    {
        var harness = Create("code");
        harness.Process.Handler = request => IsVerify(request)
            ? throw new InvalidOperationException("boom")
            : DefaultHandler(request);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var run = harness.Db.BenchmarkRuns.Single();
        Assert.Equal("failed", run.Status);
        Assert.Equal(
            BenchmarkErrorText.Encode("baseline_verify_failed", new Dictionary<string, string> { ["detail"] = "boom" }),
            run.Error);
    }

    [Fact]
    public async Task ExecuteAsync_BaselineDirectoryBlocked_StoresEncodedError()
    {
        var harness = Create("code");
        var baseline = Path.Combine(_root, "work", harness.RunId, "baseline");
        Directory.CreateDirectory(Path.GetDirectoryName(baseline)!);
        File.WriteAllText(baseline, "blocked");
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var run = harness.Db.BenchmarkRuns.Single();
        Assert.Equal("failed", run.Status);
        var error = BenchmarkErrorText.Read(run.Error);
        Assert.Equal("baseline_setup_failed", error.Code);
        Assert.False(string.IsNullOrWhiteSpace(error.Parameters!["detail"]));
    }

    [Fact]
    public async Task ExecuteAsync_GitInitFails_StoresEncodedError()
    {
        var harness = Create("code");
        harness.Process.Handler = request => request.FileName == "git"
            ? new ProcessResult(1, "", "fatal", false, 10)
            : DefaultHandler(request);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal("failed", result.Status);
        Assert.Equal(BenchmarkErrorText.Encode("git_init_failed"), result.Error);
        Assert.DoesNotContain(harness.Process.Requests, IsModel);
    }

    [Fact]
    public async Task ExecuteAsync_MissingTest_StoresEncodedError()
    {
        var harness = Create("code");
        var pending = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        pending.TestName = "gone";
        harness.Db.SaveChanges();
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal("failed", result.Status);
        Assert.Equal(BenchmarkErrorText.Encode("test_missing"), result.Error);
    }

    [Fact]
    public async Task ExecuteAsync_VerifyTimeout_StoresEncodedError()
    {
        var harness = Create("code");
        var verifyCalls = 0;
        harness.Process.Handler = request =>
        {
            if (!IsVerify(request)) return DefaultHandler(request);
            verifyCalls++;
            return verifyCalls == 1
                ? new ProcessResult(0, "", "", false, 10)
                : new ProcessResult(-1, "", "", true, 10);
        };
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal("timedout", result.Status);
        Assert.Equal(BenchmarkErrorText.Encode("verify_timeout"), result.Error);
    }

    [Fact]
    public async Task ExecuteAsync_JudgeTimeout_StoresEncodedError()
    {
        var harness = Create("open");
        harness.Process.Handler = request => IsJudge(request)
            ? new ProcessResult(-1, "", "", true, 10)
            : DefaultHandler(request);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal(BenchmarkErrorText.Encode("judge_timeout"), result.Error);
    }

    [Fact]
    public async Task ExecuteAsync_JudgeInvalidJson_StoresEncodedError()
    {
        var harness = Create("open");
        harness.Process.Handler = request => IsJudge(request)
            ? new ProcessResult(0, JsonText("no es json", "ses_judge"), "", false, 10)
            : DefaultHandler(request);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var result = harness.Db.BenchmarkResults.Single(item => item.Id == "res1");
        Assert.Equal(BenchmarkErrorText.Encode("judge_invalid_json"), result.Error);
    }

    [Fact]
    public async Task ExecuteAsync_VerdictTimeout_StoresEncodedError()
    {
        var harness = Create("code", verdict: true);
        harness.Process.Handler = request => request.Arguments.Any(argument => argument.Contains("bench-verdict"))
            ? new ProcessResult(-1, "", "", true, 10)
            : DefaultHandler(request);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        Assert.Equal(BenchmarkErrorText.Encode("verdict_timeout"), harness.Db.BenchmarkRuns.Single().Verdict);
    }

    [Fact]
    public async Task ExecuteAsync_MissingSuite_FailsRun()
    {
        var harness = Create("code");
        Directory.Delete(Path.Combine(_root, "demo"), recursive: true);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var run = harness.Db.BenchmarkRuns.Single();
        Assert.Equal("failed", run.Status);
        Assert.Equal(
            BenchmarkErrorText.Encode("suite_not_found", new Dictionary<string, string> { ["suite"] = "demo" }),
            run.Error);
    }

    [Fact]
    public async Task ExecuteAsync_SetsTelemetryEnvironment()
    {
        var harness = Create("code");
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var request = harness.Process.Requests.First(IsModel);
        Assert.Equal("http://127.0.0.1:9", request.Environment!["OPENCODE_OBSERVABILITY_URL"]);
        Assert.Equal("test-key", request.Environment!["OPENCODE_OBSERVABILITY_KEY"]);
        Assert.Contains("--standalone", request.Arguments);
    }

    [Fact]
    public async Task ExecuteAsync_DirtyWorkDirectory_FailsRunWithoutModel()
    {
        if (!OperatingSystem.IsWindows()) return;
        var harness = Create("code");
        var work = Path.Combine(_root, "work", harness.RunId, "res1", "benchmark");
        Directory.CreateDirectory(work);
        using var handle = new FileStream(Path.Combine(work, "locked.txt"), FileMode.Create, FileAccess.Write, FileShare.None);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        Assert.Equal("failed", harness.Db.BenchmarkRuns.Single().Status);
        Assert.DoesNotContain(harness.Process.Requests, IsModel);
    }

    [Fact]
    public async Task ExecuteAsync_PromptIncludesBenchmarkMarker()
    {
        var harness = Create("code");
        string? captured = null;
        harness.Process.Handler = request =>
        {
            if (IsModel(request)) captured = File.ReadAllText(ArgValue(request, "--file"));
            return DefaultHandler(request);
        };
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        Assert.StartsWith("[BENCHMARK]", captured);
        Assert.Contains("superpowers", captured);
        Assert.Contains("sdd", captured);
    }

    [Fact]
    public async Task ExecuteAsync_Verdict_StoresRecommendation()
    {
        var harness = Create("code", verdict: true);
        string? verdictPrompt = null;
        harness.Process.Handler = request =>
        {
            if (request.Arguments.Any(argument => argument.Contains("bench-verdict")))
            {
                verdictPrompt = File.ReadAllText(ArgValue(request, "--file"));
                return new ProcessResult(0, JsonText("Mejor: provider/model-a.", "ses_verdict"), "", false, 10);
            }
            return DefaultHandler(request);
        };
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var run = harness.Db.BenchmarkRuns.Single();
        Assert.False(string.IsNullOrWhiteSpace(run.Verdict));
        Assert.StartsWith("[BENCHMARK]", verdictPrompt);
        Assert.Contains("RESULTADOS", verdictPrompt);
        Assert.Contains("universitario", verdictPrompt);
    }

    [Fact]
    public void Truncate_DoesNotSplitSurrogatePair()
    {
        var value = new string('a', 4) + "\uD83D\uDE00";
        Assert.Equal("aaaa", BenchmarkExecutor.Truncate(value, 5));
        Assert.Equal(value, BenchmarkExecutor.Truncate(value, 6));
    }

    [Fact]
    public async Task ExecuteAsync_DoesNotCopyFixtureGitDirectory()
    {
        var harness = Create("code");
        var gitDirectory = Path.Combine(_root, "demo", "fixtures", "app", ".git");
        Directory.CreateDirectory(gitDirectory);
        File.WriteAllText(Path.Combine(gitDirectory, "config"), "fixture");
        string? workDirectory = null;
        harness.Process.Handler = request =>
        {
            if (IsModel(request)) workDirectory = request.WorkingDirectory;
            return DefaultHandler(request);
        };
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        Assert.NotNull(workDirectory);
        Assert.False(Directory.Exists(Path.Combine(workDirectory!, ".git")));
    }

    [Fact]
    public async Task ExecuteAsync_UsesUniqueWorkingDirectories()
    {
        var harness = Create("code", results: 2);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var directories = harness.Process.Requests.Where(IsModel).Select(request => request.WorkingDirectory).ToArray();
        Assert.Equal(2, directories.Length);
        Assert.Equal(2, directories.Distinct().Count());
        Assert.All(directories, directory => Assert.Equal("benchmark", Path.GetFileName(directory)));
    }

    [Fact]
    public void Cleanup_And_ResetDirectory_RejectPathsOutsideRoot()
    {
        var root = Path.Combine(_root, "sandbox");
        var sibling = Path.Combine(_root, "keep");
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(sibling);
        var marker = Path.Combine(sibling, "important.txt");
        File.WriteAllText(marker, "keep");

        Assert.Throws<InvalidOperationException>(() => BenchmarkExecutor.Cleanup(root, root));
        Assert.Throws<InvalidOperationException>(() => BenchmarkExecutor.Cleanup(root, Path.Combine(root, "..", "keep")));
        Assert.Throws<InvalidOperationException>(() => BenchmarkExecutor.ResetDirectory(root, Path.GetTempPath()));
        Assert.True(File.Exists(marker));
    }

    private sealed record Harness(
        BenchmarkExecutor Executor,
        TelemetryDb Db,
        FakeProcessRunner Process,
        FakeSessionReader Sessions,
        FakeNotifier Notifier,
        string RunId);
}
