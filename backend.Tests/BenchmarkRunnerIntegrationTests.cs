using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

/// <summary>
/// Las pruebas de integración del runner levantan un worker real y esperan una
/// corrida completa contra un `opencode` falso. En paralelo con el resto de las
/// factorías el margen de 15 s se vuelve inestable, así que la colección corre sola.
/// </summary>
[CollectionDefinition("benchmark-runner", DisableParallelization = true)]
public sealed class BenchmarkRunnerCollectionDefinition { }

[Collection("benchmark-runner")]
public sealed class BenchmarkRunnerIntegrationTests : IDisposable
{
    private readonly BenchmarkRunnerApiFactory _factory = new();

    public void Dispose() => _factory.Dispose();

    private HttpClient Client() => BenchmarkApiTests.Authenticated(_factory.CreateClient());

    private static async Task<JsonElement> WaitAsync(
        HttpClient client,
        string id,
        Func<JsonElement, bool> predicate,
        int timeoutMs = 15000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        string last = "sin respuesta";
        while (DateTime.UtcNow < deadline)
        {
            using var document = JsonDocument.Parse(await client.GetStringAsync($"/api/v1/benchmarks/runs/{id}"));
            last = document.RootElement.ToString();
            if (predicate(document.RootElement)) return document.RootElement.Clone();
            await Task.Delay(100);
        }
        throw new TimeoutException($"La corrida {id} no llegó al estado esperado. Último estado: {last}");
    }

    private static async Task<string> CreateRunAsync(HttpClient client, string[] models)
    {
        var response = await client.PostAsJsonAsync("/api/v1/benchmarks/runs", new
        {
            suite = "demo",
            models,
            judge = "provider/model-c",
        });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("id").GetString()!;
    }

    [Fact]
    public async Task Run_CompletesWithFakeOpenCode()
    {
        using var client = Client();
        var id = await CreateRunAsync(client, new[] { "provider/model-a", "provider/model-b" });
        var run = await WaitAsync(client, id, element => element.GetProperty("status").GetString() == "completed");

        var results = run.GetProperty("results").EnumerateArray().ToArray();
        Assert.Equal(4, results.Length);
        Assert.All(results, result => Assert.Equal("completed", result.GetProperty("status").GetString()));
        Assert.Contains(results, result => result.TryGetProperty("verifyPassed", out var passed) && passed.ValueKind == JsonValueKind.True);
        Assert.Contains(results, result => result.GetProperty("judgeScore").GetInt32() == 4);
        Assert.False(string.IsNullOrWhiteSpace(run.GetProperty("verdict").GetString()));
    }

    [Fact]
    public async Task Cancel_RunningRunStopsAndMarksCancelled()
    {
        _factory.HoldModel = new TaskCompletionSource();
        using var client = Client();
        var id = await CreateRunAsync(client, new[] { "provider/model-a" });

        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!_factory.Fake.Requests.Any(IsModel))
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("El modelo no arrancó.");
            await Task.Delay(50);
        }

        var response = await client.PostAsync($"/api/v1/benchmarks/runs/{id}/cancel", null);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        var run = await WaitAsync(client, id, element => element.GetProperty("status").GetString() == "cancelled");
        Assert.All(run.GetProperty("results").EnumerateArray(), result => Assert.Equal("cancelled", result.GetProperty("status").GetString()));
    }

    [Fact]
    public async Task Worker_ContinuesAfterFailedRun()
    {
        _factory.FailFirstModel = true;
        using var client = Client();
        var first = await CreateRunAsync(client, new[] { "provider/model-a" });
        await WaitAsync(client, first, element => element.GetProperty("status").GetString() == "failed");

        var second = await CreateRunAsync(client, new[] { "provider/model-a" });
        var run = await WaitAsync(client, second, element => element.GetProperty("status").GetString() == "completed");
        Assert.Equal("completed", run.GetProperty("status").GetString());
    }

    private static bool IsModel(ProcessRequest request) =>
        request.Arguments.Contains("--model") && !request.Arguments.Contains("--archived");
}

public sealed class BenchmarkRunnerApiFactory : BenchmarkApiFactory
{
    private int _modelCalls;

    public TaskCompletionSource? HoldModel { get; set; }
    public bool FailFirstModel { get; set; }

    public BenchmarkRunnerApiFactory()
    {
        Fake.Handler = Handle;
        Fake.AsyncHandler = async (request, cancellationToken) =>
        {
            if (IsModel(request) && HoldModel is not null)
                await HoldModel.Task.WaitAsync(cancellationToken);
            return Fake.Handler!(request);
        };
    }

    protected override bool WorkerEnabled => true;

    private ProcessResult Handle(ProcessRequest request)
    {
        if (request.Arguments.Contains("models"))
            return new ProcessResult(0, "provider/model-a\nprovider/model-b\nprovider/model-c\n", "", false, 10);
        if (request.FileName == "git")
            return request.Arguments.Contains("diff")
                ? new ProcessResult(0, "diff de prueba", "", false, 10)
                : new ProcessResult(0, "", "", false, 10);
        if (request.Arguments.Contains("--archived"))
            return new ProcessResult(0, JsonText("{\"score\":4,\"rationale\":\"ok\"}", "ses_judge"), "", false, 10);
        if (IsModel(request))
        {
            _modelCalls++;
            if (_modelCalls == 1 && FailFirstModel) throw new InvalidOperationException("boom");
            return new ProcessResult(0, JsonText("respuesta", "ses_model"), "", false, 1200);
        }
        return new ProcessResult(0, "", "", false, 10);
    }

    private static bool IsModel(ProcessRequest request) =>
        request.Arguments.Contains("--model") && !request.Arguments.Contains("--archived");

    private static string JsonText(string text, string sessionId) =>
        JsonSerializer.Serialize(new { type = "text", part = new { type = "text", text }, sessionID = sessionId });
}
