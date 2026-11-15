using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

public sealed class BenchmarkApiTests : IDisposable
{
    private readonly BenchmarkApiFactory _factory = new();

    public void Dispose() => _factory.Dispose();

    private HttpClient Client() => _factory.CreateClient();

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
        Assert.Contains("juez", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task CreateRun_RejectsMissingJudge()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(judge: null));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CreateRun_RejectsUnknownSuite()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", new { suite = "missing", models = new[] { "provider/model-a" }, judge = "provider/model-c" });
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Contains("no existe", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task CreateRun_Returns409WhenOpenCodeMissing()
    {
        _factory.Fake.Handler = _ => new ProcessResult(1, "", "boom", false, 10);
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("boom", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task CreateRun_RejectsUnknownModel()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(new[] { "a&calc" }));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("catálogo", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task CreateRun_RejectsUnknownJudge()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody(judge: "provider/model-z"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("juez", await response.Content.ReadAsStringAsync());
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
        Assert.Contains("no existe", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Runs_ReturnsHistory()
    {
        using var client = Client();
        await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());
        await client.PostAsJsonAsync("/api/v1/benchmarks/runs", RunBody());
        using var json = JsonDocument.Parse(await client.GetStringAsync("/api/v1/benchmarks/runs?suite=demo"));
        Assert.Equal(2, json.RootElement.GetArrayLength());
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
        if (disposing && File.Exists(_database)) File.Delete(_database);
        if (disposing && Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
