using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

public sealed class TelemetryApiTests : IDisposable
{
    private readonly ApiFactory _factory = new();
    private readonly HttpClient _client;
    public TelemetryApiTests() => _client = _factory.CreateClient();
    public void Dispose() { _client.Dispose(); _factory.Dispose(); }

    [Fact]
    public async Task HealthEndpointIsAvailable()
    {
        var response = await _client.GetAsync("/api/v1/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task IngestionRequiresLocalKey()
    {
        var response = await _client.PostAsJsonAsync("/api/v1/telemetry/events", Fixture("no-key", "session-no-key", "session.created"));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task DuplicateEventsAreIdempotentAndSensitiveAttributesAreDropped()
    {
        var payload = Fixture("tool-1", "session-safe", "tool.completed") with
        {
            Name = "bash", Status = "error", DurationMs = 47,
            Attributes = new Dictionary<string, string> { ["tool_name"] = "bash", ["prompt"] = "private prompt", ["command"] = "private command", ["trace.id"] = "trace-safe" }
        };
        var first = await Post(payload);
        var second = await Post(payload);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        using var firstJson = JsonDocument.Parse(await first.Content.ReadAsStringAsync());
        using var secondJson = JsonDocument.Parse(await second.Content.ReadAsStringAsync());
        Assert.False(firstJson.RootElement.GetProperty("duplicate").GetBoolean());
        Assert.True(secondJson.RootElement.GetProperty("duplicate").GetBoolean());

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-safe"));
        var events = detail.RootElement.GetProperty("events");
        Assert.Equal(1, events.GetArrayLength());
        var attributes = events[0].GetProperty("attributesJson").GetString()!;
        Assert.Contains("trace-safe", attributes);
        Assert.DoesNotContain("private", attributes);
        Assert.DoesNotContain("prompt", attributes);
        Assert.DoesNotContain("command", attributes);
    }

    [Fact]
    public async Task ConcurrentDuplicateEventsAreIdempotent()
    {
        var payload = Fixture("race-1", "session-race", "session.created");
        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => Post(payload)));
        Assert.All(responses, response => Assert.Equal(HttpStatusCode.OK, response.StatusCode));

        var duplicates = new List<bool>();
        foreach (var response in responses)
        {
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            duplicates.Add(json.RootElement.GetProperty("duplicate").GetBoolean());
        }
        Assert.Equal(1, duplicates.Count(value => !value));
        Assert.Equal(19, duplicates.Count(value => value));

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-race"));
        Assert.Equal(1, detail.RootElement.GetProperty("events").GetArrayLength());
    }

    [Fact]
    public async Task ConcurrentDuplicateEventsForExistingSessionAreIdempotent()
    {
        await Post(Fixture("seed", "session-race-existing", "session.created"));
        var payload = Fixture("race-existing", "session-race-existing", "session.created");
        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => Post(payload)));

        Assert.All(responses, response => Assert.Equal(HttpStatusCode.OK, response.StatusCode));
        var duplicates = new List<bool>();
        foreach (var response in responses)
        {
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            duplicates.Add(json.RootElement.GetProperty("duplicate").GetBoolean());
        }
        Assert.Equal(1, duplicates.Count(value => !value));
        Assert.Equal(19, duplicates.Count(value => value));

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-race-existing"));
        Assert.Equal(2, detail.RootElement.GetProperty("events").GetArrayLength());
    }

    [Fact]
    public async Task LateEventsBuildAParentedTraceAndKeepTheEarliestStart()
    {
        var start = DateTimeOffset.UtcNow.AddMinutes(-3);
        await Post(Fixture("idle", "session-late", "session.idle", start.AddMinutes(2)) with { Status = "completed" });
        await Post(Fixture("model:m1", "session-late", "model.completed", start) with { Name = "gpt-test", Model = "gpt-test", DurationMs = 900, InputTokens = 21, OutputTokens = 9 });
        await Post(Fixture("tool:t1", "session-late", "tool.completed", start.AddSeconds(1)) with { Name = "read", ParentId = "model:m1", DurationMs = 80 });

        using var session = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-late"));
        Assert.Equal(start.UtcDateTime, session.RootElement.GetProperty("session").GetProperty("startedAt").GetDateTime().ToUniversalTime());
        var spans = session.RootElement.GetProperty("spans");
        Assert.Equal(2, spans.GetArrayLength());
        Assert.Contains(spans.EnumerateArray(), span => span.GetProperty("id").GetString() == "opencode:tool:t1" && span.GetProperty("parentId").GetString() == "opencode:model:m1");
        Assert.Equal(30, session.RootElement.GetProperty("metrics").GetProperty("inputTokens").GetInt32() + session.RootElement.GetProperty("metrics").GetProperty("outputTokens").GetInt32());

        using var trace = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/traces/session-late"));
        Assert.Equal("session-late", trace.RootElement.GetProperty("traceId").GetString());
    }

    [Fact]
    public async Task SessionListCanFilterAndPaginate()
    {
        await Post(Fixture("ok", "session-ok", "session.created") with { Model = "model-a" });
        await Post(Fixture("err", "session-err", "session.error") with { Status = "error", Model = "model-b" });
        using var result = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions?status=error&model=model-b&page=1&pageSize=1"));
        Assert.Equal(1, result.RootElement.GetProperty("total").GetInt32());
        Assert.Equal("session-err", result.RootElement.GetProperty("items")[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task SuccessfulExecutionClosesTheSession()
    {
        await Post(Fixture("success", "session-success", "session.execution.succeeded") with { Status = "completed" });
        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-success"));
        var session = detail.RootElement.GetProperty("session");
        Assert.Equal("completed", session.GetProperty("status").GetString());
        Assert.NotEqual(JsonValueKind.Null, session.GetProperty("endedAt").ValueKind);
    }

    [Fact]
    public async Task InterruptedExecutionKeepsItsOwnStatus()
    {
        await Post(Fixture("interrupted", "session-interrupted", "session.idle") with { Status = "interrupted" });
        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-interrupted"));
        Assert.Equal("interrupted", detail.RootElement.GetProperty("session").GetProperty("status").GetString());
    }

    [Fact]
    public async Task StartedExecutionReopensAClosedSession()
    {
        await Post(Fixture("idle", "session-reopen", "session.idle", DateTimeOffset.UtcNow.AddMinutes(-1)) with { Status = "completed" });
        await Post(Fixture("start", "session-reopen", "session.execution.started", DateTimeOffset.UtcNow) with { Status = "active" });
        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-reopen"));
        var session = detail.RootElement.GetProperty("session");
        Assert.Equal("active", session.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, session.GetProperty("endedAt").ValueKind);
    }

    [Fact]
    public async Task InterruptedThenIdleKeepsInterrupted()
    {
        var start = DateTimeOffset.UtcNow.AddMinutes(-2);
        await Post(Fixture("interrupted", "session-interrupted-tail", "session.idle", start) with { Status = "interrupted" });
        await Post(Fixture("idle-tail", "session-interrupted-tail", "session.idle", start.AddSeconds(5)) with { Status = "completed" });
        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-interrupted-tail"));
        Assert.Equal("interrupted", detail.RootElement.GetProperty("session").GetProperty("status").GetString());
    }

    [Fact]
    public async Task LateIdleDoesNotCloseReopenedSession()
    {
        var start = DateTimeOffset.UtcNow.AddMinutes(-3);
        await Post(Fixture("idle-old", "session-late-idle", "session.idle", start) with { Status = "completed" });
        await Post(Fixture("start-new", "session-late-idle", "session.execution.started", start.AddMinutes(2)) with { Status = "active" });
        await Post(Fixture("idle-late", "session-late-idle", "session.idle", start.AddMinutes(1)) with { Status = "completed" });
        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-late-idle"));
        var session = detail.RootElement.GetProperty("session");
        Assert.Equal("active", session.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, session.GetProperty("endedAt").ValueKind);
    }

    [Fact]
    public async Task LateStartedDoesNotReopenNewerTerminal()
    {
        var start = DateTimeOffset.UtcNow.AddMinutes(-3);
        await Post(Fixture("idle-new", "session-late-start", "session.idle", start.AddMinutes(2)) with { Status = "completed" });
        await Post(Fixture("start-late", "session-late-start", "session.execution.started", start.AddMinutes(1)) with { Status = "active" });
        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-late-start"));
        var session = detail.RootElement.GetProperty("session");
        Assert.Equal("completed", session.GetProperty("status").GetString());
        Assert.NotEqual(JsonValueKind.Null, session.GetProperty("endedAt").ValueKind);
    }

    [Fact]
    public async Task SucceededExecutionIgnoresInterruptedStatus()
    {
        await Post(Fixture("succeeded-interrupted", "session-succeeded-interrupted", "session.execution.succeeded") with { Status = "interrupted" });
        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-succeeded-interrupted"));
        Assert.Equal("completed", detail.RootElement.GetProperty("session").GetProperty("status").GetString());
    }

    private async Task<HttpResponseMessage> Post(TelemetryEventDto dto)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/telemetry/events") { Content = JsonContent.Create(dto) };
        request.Headers.Add("X-Telemetry-Key", TestCredentials.ApiKey);
        return await _client.SendAsync(request);
    }

    private static TelemetryEventDto Fixture(string eventId, string sessionId, string type, DateTimeOffset? timestamp = null) => new(
        eventId, "opencode", sessionId, timestamp ?? DateTimeOffset.UtcNow, type, Project: "fixture", Status: "ok");
}

public sealed class ApiFactory : WebApplicationFactory<Program>
{
    private readonly string _database = Path.Combine(Path.GetTempPath(), $"agent-observability-{Guid.NewGuid():N}.db");
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration(config => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Telemetry"] = $"Data Source={_database};Pooling=False",
            ["Telemetry:ApiKey"] = TestCredentials.ApiKey,
            ["ASPNETCORE_ENVIRONMENT"] = "Development"
        }));
        builder.ConfigureLogging(logging => logging.ClearProviders());
    }
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && File.Exists(_database)) File.Delete(_database);
    }
}

public sealed record TelemetryEventDto(
    string EventId, string Source, string SessionId, DateTimeOffset Timestamp, string Type,
    string? Project = null, string? Status = null, long? DurationMs = null, string? Model = null,
    int InputTokens = 0, int OutputTokens = 0, string? ParentId = null, string? Name = null,
    Dictionary<string, string>? Attributes = null);

internal static class TestCredentials
{
    internal static readonly string ApiKey = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
}
