using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

public sealed class BenchmarkApiTests : IDisposable
{
    private readonly BenchmarkApiFactory _factory = new();

    public void Dispose() => _factory.Dispose();

    private HttpClient Client() => Authenticated(_factory.CreateClient());

    internal static HttpClient Authenticated(HttpClient client)
    {
        client.DefaultRequestHeaders.Add("X-Telemetry-Key", "test-key");
        return client;
    }

    private static object RunBody(string[]? models = null, string? judge = "provider/model-c") => new
    {
        suite = "demo",
        models = models ?? new[] { "provider/model-a" },
        judge,
    };

    [Fact]
    public async Task Suites_ReturnsCodeAndOpenWithoutPrompts()
    {
        using var client = Client();
        var body = await client.GetStringAsync("/api/v1/benchmarks/suites");
        using var json = JsonDocument.Parse(body);
        var suite = json.RootElement.GetProperty("suites")[0];
        Assert.Equal("demo", suite.GetProperty("id").GetString());
        Assert.Equal(2, suite.GetProperty("tests").GetArrayLength());
        Assert.DoesNotContain("Corregí el bug.", body);
    }

    [Fact]
    public async Task Models_ReturnsCatalog()
    {
        using var client = Client();
        using var json = JsonDocument.Parse(await client.GetStringAsync("/api/v1/benchmarks/models"));
        var models = json.RootElement.GetProperty("models").EnumerateArray().Select(item => item.GetString()).ToArray();
        Assert.Contains("provider/model-a", models);
        Assert.Null(json.RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public async Task CreateRun_RejectsJudgeInModels()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(new[] { "provider/model-a" }, "provider/model-a"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("judge", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("judge_is_model", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_RejectsMissingJudge()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(judge: null));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("judge", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("judge_missing", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_RejectsUnknownSuite()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", new { suite = "missing", models = new[] { "provider/model-a" }, judge = "provider/model-c" });
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("does not exist", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("suite_not_found", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_RejectsInvalidSuiteId()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", new { suite = "Bad Id", models = new[] { "provider/model-a" }, judge = "provider/model-c" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("suite_id_invalid", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_Returns409WhenOpenCodeMissing()
    {
        _factory.Fake.Handler = _ => new ProcessResult(1, "", "boom", false, 10);
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("boom", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("model_catalog_unavailable", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_Returns409WithTimeoutCodeWhenCatalogTimesOut()
    {
        _factory.Fake.Handler = _ => new ProcessResult(-1, "", "", true, 15000);
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("opencode models timed out.", document.RootElement.GetProperty("error").GetString());
        Assert.Equal("model_catalog_timeout", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_Returns409WithExitCodeWhenCatalogExitsWithoutStderr()
    {
        _factory.Fake.Handler = _ => new ProcessResult(1, "", "", false, 10);
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("opencode models exited with code 1.", document.RootElement.GetProperty("error").GetString());
        Assert.Equal("model_catalog_exit", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_RejectsUnknownModel()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(new[] { "a&calc" }));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("catalog", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("model_not_in_catalog", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_RejectsUnknownJudge()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(judge: "provider/model-z"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("judge", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("judge_not_in_catalog", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_AcceptsVariant()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(new[] { "provider/model-a#high" }));
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var result = json.RootElement.GetProperty("results")[0];
        Assert.Equal("provider/model-a#high", result.GetProperty("model").GetString());
    }

    [Fact]
    public async Task CreateRun_RejectsInvalidVariant()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(new[] { "provider/model-a#a&calc" }));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("variant", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("variant_invalid", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task CreateRun_CreatesOneResultPerCombination()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(new[] { "provider/model-a", "provider/model-b" }));
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var run = json.RootElement;
        Assert.Equal("queued", run.GetProperty("status").GetString());
        Assert.Equal(4, run.GetProperty("total").GetInt32());
        Assert.Equal(4, run.GetProperty("results").GetArrayLength());
        Assert.All(run.GetProperty("results").EnumerateArray(), result => Assert.Equal("pending", result.GetProperty("status").GetString()));
    }

    [Fact]
    public async Task Cancel_QueuedRunMarksPendingCancelled()
    {
        using var client = Client();
        using var created = JsonDocument.Parse(await (await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody())).Content.ReadAsStringAsync());
        var id = created.RootElement.GetProperty("id").GetString();
        var response = await client.PostAsync($"/api/v1/benchmarks/runs/{id}/cancel", null);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var detail = JsonDocument.Parse(await client.GetStringAsync($"/api/v1/benchmarks/runs/{id}"));
        Assert.Equal("cancelled", detail.RootElement.GetProperty("status").GetString());
        Assert.All(detail.RootElement.GetProperty("results").EnumerateArray(), result => Assert.Equal("cancelled", result.GetProperty("status").GetString()));
    }

    [Fact]
    public async Task Cancel_UnknownRun_Returns404()
    {
        using var client = Client();
        var response = await client.PostAsync("/api/v1/benchmarks/runs/missing/cancel", null);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("does not exist", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("run_not_found", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task DeleteRun_RejectsQueuedRun()
    {
        using var client = Client();
        using var created = JsonDocument.Parse(await (await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody())).Content.ReadAsStringAsync());
        var id = created.RootElement.GetProperty("id").GetString();
        var response = await client.DeleteAsync($"/api/v1/benchmarks/runs/{id}");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("before deleting", body);
        using var document = JsonDocument.Parse(body);
        Assert.Equal("cancel_before_delete", document.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task DeleteRun_RemovesRunAndResults()
    {
        using var client = Client();
        using var created = JsonDocument.Parse(await (await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody())).Content.ReadAsStringAsync());
        var id = created.RootElement.GetProperty("id").GetString();
        await client.PostAsync($"/api/v1/benchmarks/runs/{id}/cancel", null);

        var response = await client.DeleteAsync($"/api/v1/benchmarks/runs/{id}");
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var detail = await client.GetAsync($"/api/v1/benchmarks/runs/{id}");
        Assert.Equal(HttpStatusCode.NotFound, detail.StatusCode);
    }

    [Fact]
    public async Task DeleteRun_RemovesLinkedTelemetry()
    {
        using var client = Client();
        using var created = JsonDocument.Parse(await (await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody())).Content.ReadAsStringAsync());
        var id = created.RootElement.GetProperty("id").GetString();
        await client.PostAsync($"/api/v1/benchmarks/runs/{id}/cancel", null);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TelemetryDb>();
            var result = await db.BenchmarkResults.FirstAsync(item => item.RunId == id);
            result.SessionId = "bench-session";
            result.JudgeSessionId = "bench-judge";
            db.Sessions.Add(new Session { Id = "bench-session", Source = "opencode", Status = "completed", StartedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            db.Sessions.Add(new Session { Id = "bench-judge", Source = "opencode", Status = "completed", StartedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            db.Spans.Add(new Span { Id = "span-1", SessionId = "bench-session", Name = "model", Kind = "inference", Status = "ok", StartedAt = DateTime.UtcNow });
            db.Events.Add(new TelemetryEvent { EventId = "event-1", Source = "opencode", SessionId = "bench-session", Timestamp = DateTime.UtcNow, Type = "model.completed" });
            await db.SaveChangesAsync();
        }

        var response = await client.DeleteAsync($"/api/v1/benchmarks/runs/{id}");
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        using var verifyScope = _factory.Services.CreateScope();
        var verify = verifyScope.ServiceProvider.GetRequiredService<TelemetryDb>();
        Assert.False(await verify.Sessions.AnyAsync(item => item.Id == "bench-session" || item.Id == "bench-judge"));
        Assert.False(await verify.Spans.AnyAsync(item => item.SessionId == "bench-session"));
        Assert.False(await verify.Events.AnyAsync(item => item.SessionId == "bench-session"));
        Assert.False(await verify.BenchmarkRuns.AnyAsync(item => item.Id == id));
    }

    [Fact]
    public async Task Runs_ReturnsHistory()
    {
        using var client = Client();
        await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());
        await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());
        using var json = JsonDocument.Parse(await client.GetStringAsync("/api/v1/benchmarks/runs?suite=demo"));
        Assert.Equal(2, json.RootElement.GetProperty("total").GetInt32());
        Assert.Equal(2, json.RootElement.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task Runs_PaginatesHistory()
    {
        using var client = Client();
        for (var index = 0; index < 3; index++)
            await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());

        using var first = JsonDocument.Parse(await client.GetStringAsync("/api/v1/benchmarks/runs?suite=demo&page=1&pageSize=2"));
        Assert.Equal(3, first.RootElement.GetProperty("total").GetInt32());
        Assert.Equal(2, first.RootElement.GetProperty("items").GetArrayLength());

        using var second = JsonDocument.Parse(await client.GetStringAsync("/api/v1/benchmarks/runs?suite=demo&page=2&pageSize=2"));
        Assert.Equal(1, second.RootElement.GetProperty("items").GetArrayLength());
    }
}

public class BenchmarkApiFactory : WebApplicationFactory<Program>
{
    private readonly string _database = Path.Combine(Path.GetTempPath(), $"bench-api-{Guid.NewGuid():N}.db");
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"bench-api-{Guid.NewGuid():N}");

    public FakeProcessRunner Fake { get; } = new();
    public FakeSessionReader Sessions { get; } = new();

    protected virtual bool WorkerEnabled => false;

    public BenchmarkApiFactory()
    {
        Directory.CreateDirectory(_root);
        WriteSuite();
        Fake.Handler = request => request.Arguments.Contains("models")
            ? new ProcessResult(0, "provider/model-a\nprovider/model-b\nprovider/model-c\n", "", false, 10)
            : new ProcessResult(0, "", "", false, 0);
    }

    private void WriteSuite()
    {
        var suite = Path.Combine(_root, "demo");
        Directory.CreateDirectory(Path.Combine(suite, "prompts"));
        Directory.CreateDirectory(Path.Combine(suite, "fixtures", "app"));
        File.WriteAllText(Path.Combine(suite, "suite.json"), """
        {
          "name": "Demo",
          "defaultJudge": "provider/model-c",
          "modelTimeoutMs": 300000,
          "tests": [
            {
              "name": "code-test",
              "type": "code",
              "promptFile": "prompts/code.md",
              "fixture": "fixtures/app",
              "verify": { "command": "node --test", "timeoutMs": 120000 },
              "judge": true
            },
            {
              "name": "open-test",
              "type": "open",
              "promptFile": "prompts/open.md",
              "rubric": ["Claridad", "Correctitud"]
            }
          ]
        }
        """);
        File.WriteAllText(Path.Combine(suite, "prompts", "code.md"), "Corregí el bug.");
        File.WriteAllText(Path.Combine(suite, "prompts", "open.md"), "Explicá la caché.");
        File.WriteAllText(Path.Combine(suite, "fixtures", "app", "app.txt"), "app");
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration(config => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Telemetry"] = $"Data Source={_database};Pooling=False",
            ["Telemetry:ApiKey"] = "test-key",
            ["Benchmarks:Root"] = _root,
            ["Benchmarks:WorkingRoot"] = Path.Combine(_root, "work"),
            ["Benchmarks:TelemetryUrl"] = "http://127.0.0.1:9",
            ["Benchmarks:WorkerEnabled"] = WorkerEnabled ? "true" : "false",
            ["ASPNETCORE_ENVIRONMENT"] = "Development",
        }));
        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<IProcessRunner>(Fake);
            services.AddSingleton<IBenchmarkSessionReader>(Sessions);
            if (!WorkerEnabled)
            {
                var worker = services.FirstOrDefault(item => item.ImplementationType == typeof(BenchmarkWorker));
                if (worker is not null) services.Remove(worker);
            }
        });
        builder.ConfigureLogging(logging => logging.ClearProviders());
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        try
        {
            if (File.Exists(_database)) File.Delete(_database);
        }
        catch (IOException)
        {
            // La limpieza del test es best-effort.
        }
        catch (UnauthorizedAccessException)
        {
            // La limpieza del test es best-effort.
        }

        try
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // La limpieza del test es best-effort.
        }
        catch (UnauthorizedAccessException)
        {
            // La limpieza del test es best-effort.
        }
    }
}
