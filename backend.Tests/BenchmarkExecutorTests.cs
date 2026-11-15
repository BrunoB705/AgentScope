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

    private Harness Create(string type = "code", bool judge = false, int results = 1)
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
            ModelTimeoutMs = 300000,
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
        Assert.Equal("timedout", harness.Db.BenchmarkResults.Single(item => item.Id == "res1").Status);
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
        Assert.False(string.IsNullOrWhiteSpace(result.MetricsError));
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
        Assert.DoesNotContain(harness.Process.Requests, IsModel);
    }

    [Fact]
    public async Task ExecuteAsync_MissingSuite_FailsRun()
    {
        var harness = Create("code");
        Directory.Delete(Path.Combine(_root, "demo"), recursive: true);
        await harness.Executor.ExecuteAsync(harness.RunId, CancellationToken.None);
        var run = harness.Db.BenchmarkRuns.Single();
        Assert.Equal("failed", run.Status);
        Assert.Contains("no existe", run.Error);
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

    private sealed record Harness(
        BenchmarkExecutor Executor,
        TelemetryDb Db,
        FakeProcessRunner Process,
        FakeSessionReader Sessions,
        FakeNotifier Notifier,
        string RunId);
}
