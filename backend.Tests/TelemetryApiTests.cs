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

    [Fact]
    public async Task StartedWithSameTimestampDoesNotReopenTerminal()
    {
        var instant = DateTimeOffset.UtcNow.AddMinutes(-1);
        await Post(Fixture("succeeded", "session-same-timestamp", "session.execution.succeeded", instant) with { Status = "completed" });
        await Post(Fixture("start", "session-same-timestamp", "session.execution.started", instant) with { Status = "active" });
        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-same-timestamp"));
        var session = detail.RootElement.GetProperty("session");
        Assert.Equal("completed", session.GetProperty("status").GetString());
        Assert.NotEqual(JsonValueKind.Null, session.GetProperty("endedAt").ValueKind);
    }

    [Fact]
    public async Task BehaviorFlagsRepeatedToolCalls()
    {
        await Post(Fixture("created", "behavior-loop", "session.created"));
        for (var i = 0; i < 4; i++)
            await Post(Fixture($"tool-{i}", "behavior-loop", "tool.completed") with { Name = "bash", Status = "ok" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        var session = json.RootElement.GetProperty("sessions").EnumerateArray().Single();
        var signal = session.GetProperty("signals").EnumerateArray().Single(item => item.GetProperty("kind").GetString() == "tool_loop");
        Assert.Equal(4, signal.GetProperty("evidence").GetProperty("calls").GetInt32());
        Assert.Equal(4, signal.GetProperty("evidence").GetProperty("maxConsecutive").GetInt32());
    }

    [Fact]
    public async Task BehaviorFlagsErrorBurst()
    {
        await Post(Fixture("created", "behavior-errors", "session.created"));
        for (var i = 0; i < 3; i++)
            await Post(Fixture($"error-{i}", "behavior-errors", "tool.completed") with { Name = $"tool-{i}", Status = "error" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        var signals = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals").EnumerateArray().ToArray();
        Assert.Single(signals);
        Assert.Equal("error_burst", signals[0].GetProperty("kind").GetString());
    }

    [Fact]
    public async Task BehaviorFlagsThreeConsecutiveTools()
    {
        await Post(Fixture("created", "behavior-three", "session.created"));
        for (var i = 0; i < 3; i++)
            await Post(Fixture($"tool-{i}", "behavior-three", "tool.completed") with { Name = "bash", Status = "ok" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        var signal = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals").EnumerateArray().Single();
        Assert.Equal("tool_loop", signal.GetProperty("kind").GetString());
        Assert.Equal(3, signal.GetProperty("evidence").GetProperty("calls").GetInt32());
        Assert.Equal(3, signal.GetProperty("evidence").GetProperty("maxConsecutive").GetInt32());
    }

    [Fact]
    public async Task BehaviorFlagsModelErrorBurst()
    {
        await Post(Fixture("created", "behavior-model-errors", "session.created"));
        for (var i = 0; i < 2; i++)
            await Post(Fixture($"model-{i}", "behavior-model-errors", "model.completed") with { Name = "model-a", Model = "model-a", Status = "error" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        var signals = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals").EnumerateArray().ToArray();
        Assert.Single(signals);
        Assert.Equal("error_burst", signals[0].GetProperty("kind").GetString());
        Assert.Equal(2, signals[0].GetProperty("evidence").GetProperty("modelErrors").GetInt32());
    }

    [Fact]
    public async Task BehaviorFlagsLongSessionBySpanCount()
    {
        await Post(Fixture("created", "behavior-spans", "session.created"));
        for (var i = 0; i < 30; i++)
            await Post(Fixture($"tool-{i}", "behavior-spans", "tool.completed") with { Name = $"tool-{i}", Status = "ok" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        var signal = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals").EnumerateArray().Single();
        Assert.Equal("long_session", signal.GetProperty("kind").GetString());
        Assert.Equal(30, signal.GetProperty("evidence").GetProperty("spans").GetInt32());
    }

    [Fact]
    public async Task BehaviorOrdersSessionsAndSignals()
    {
        await Post(Fixture("a-idle", "behavior-order-a", "session.idle") with { Status = "interrupted" });
        for (var i = 0; i < 4; i++)
            await Post(Fixture($"a-tool-{i}", "behavior-order-a", "tool.completed") with { Name = "bash", Status = "ok" });
        await Post(Fixture("b-idle", "behavior-order-b", "session.idle") with { Status = "interrupted" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        var sessions = json.RootElement.GetProperty("sessions").EnumerateArray().ToArray();
        Assert.Equal("behavior-order-a", sessions[0].GetProperty("id").GetString());
        Assert.Equal("behavior-order-b", sessions[1].GetProperty("id").GetString());
        var signals = sessions[0].GetProperty("signals").EnumerateArray().ToArray();
        Assert.Equal(2, signals.Length);
        Assert.Equal("interrupted", signals[0].GetProperty("kind").GetString());
        Assert.Equal("tool_loop", signals[1].GetProperty("kind").GetString());
    }

    [Fact]
    public async Task BehaviorFlagsLongSession()
    {
        await Post(Fixture("created", "behavior-long", "session.created"));
        for (var i = 0; i < 20; i++)
            await Post(Fixture($"model-{i}", "behavior-long", "model.completed") with { Name = "model-a", Model = "model-a", Status = "ok" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        var signals = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals");
        Assert.Contains(signals.EnumerateArray(), item => item.GetProperty("kind").GetString() == "long_session");
    }

    [Fact]
    public async Task BehaviorFlagsInterruptedSession()
    {
        await Post(Fixture("interrupted", "behavior-interrupted", "session.idle") with { Status = "interrupted" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        var signals = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals");
        Assert.Contains(signals.EnumerateArray(), item => item.GetProperty("kind").GetString() == "interrupted");
    }

    [Fact]
    public async Task BehaviorIgnoresHealthySession()
    {
        await Post(Fixture("created", "behavior-healthy", "session.created"));
        await Post(Fixture("model", "behavior-healthy", "model.completed") with { Name = "model-a", Model = "model-a", Status = "ok" });
        await Post(Fixture("tool", "behavior-healthy", "tool.completed") with { Name = "read", Status = "ok" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
        Assert.Equal(0, json.RootElement.GetProperty("totals").GetProperty("flaggedSessions").GetInt32());
        Assert.Empty(json.RootElement.GetProperty("sessions").EnumerateArray());
    }

    [Fact]
    public async Task BehaviorFiltersByWindow()
    {
        var old = DateTimeOffset.UtcNow.AddDays(-40);
        await Post(Fixture("old", "behavior-old", "session.idle", old) with { Status = "interrupted" });
        await Post(Fixture("recent", "behavior-recent", "session.idle") with { Status = "interrupted" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior?days=30"));
        var sessions = json.RootElement.GetProperty("sessions").EnumerateArray().ToArray();
        Assert.DoesNotContain(sessions, session => session.GetProperty("id").GetString() == "behavior-old");
        Assert.Contains(sessions, session => session.GetProperty("id").GetString() == "behavior-recent");
    }

    [Fact]
    public async Task BehaviorFiltersByOneDay()
    {
        var old = DateTimeOffset.UtcNow.AddDays(-2);
        await Post(Fixture("old-day", "behavior-old-day", "session.idle", old) with { Status = "interrupted" });
        await Post(Fixture("recent-day", "behavior-recent-day", "session.idle") with { Status = "interrupted" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior?days=1"));
        var sessions = json.RootElement.GetProperty("sessions").EnumerateArray().ToArray();
        Assert.DoesNotContain(sessions, session => session.GetProperty("id").GetString() == "behavior-old-day");
        Assert.Contains(sessions, session => session.GetProperty("id").GetString() == "behavior-recent-day");
    }

    [Fact]
    public async Task OverviewCountsSessionsAndRates()
    {
        await Post(Fixture("active", "overview-active", "session.created"));
        await Post(Fixture("completed", "overview-completed", "session.idle") with { Status = "completed" });
        await Post(Fixture("error", "overview-error", "session.error") with { Status = "error" });
        await Post(Fixture("interrupted", "overview-interrupted", "session.idle") with { Status = "interrupted" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview"));
        var totals = json.RootElement.GetProperty("totals");
        Assert.Equal(4, totals.GetProperty("sessions").GetInt32());
        Assert.Equal(1, totals.GetProperty("active").GetInt32());
        Assert.Equal(1, totals.GetProperty("completed").GetInt32());
        Assert.Equal(1, totals.GetProperty("error").GetInt32());
        Assert.Equal(1, totals.GetProperty("interrupted").GetInt32());
        Assert.Equal(3, totals.GetProperty("finished").GetInt32());
        Assert.Equal(1d / 3d, totals.GetProperty("successRate").GetDouble(), 3);
        Assert.Equal(1d / 3d, totals.GetProperty("errorRate").GetDouble(), 3);
    }

    [Fact]
    public async Task OverviewAggregatesTokensAndCosts()
    {
        await Post(Fixture("created", "overview-tokens", "session.created"));
        await Post(Fixture("model-1", "overview-tokens", "model.completed") with
        {
            Name = "model-a", Model = "model-a", Status = "ok",
            InputTokens = 10, OutputTokens = 5, ReasoningTokens = 1, CacheReadTokens = 2, CacheWriteTokens = 1,
            Cost = 0.1, QuotaCostEstimate = 0.05
        });
        await Post(Fixture("model-2", "overview-tokens", "model.completed") with
        {
            Name = "model-a", Model = "model-a", Status = "ok",
            InputTokens = 20, OutputTokens = 5, ReasoningTokens = 1, CacheReadTokens = 2, CacheWriteTokens = 1,
            Cost = 0.2, QuotaCostEstimate = 0.10
        });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview"));
        var totals = json.RootElement.GetProperty("totals");
        Assert.Equal(30, totals.GetProperty("inputTokens").GetInt64());
        Assert.Equal(10, totals.GetProperty("outputTokens").GetInt64());
        Assert.Equal(2, totals.GetProperty("reasoningTokens").GetInt64());
        Assert.Equal(4, totals.GetProperty("cacheReadTokens").GetInt64());
        Assert.Equal(2, totals.GetProperty("cacheWriteTokens").GetInt64());
        Assert.Equal(46, totals.GetProperty("totalTokens").GetInt64());
        Assert.Equal(0.3, totals.GetProperty("reportedCost").GetDouble(), 6);
        Assert.Equal(0.15, totals.GetProperty("quotaEstimate").GetDouble(), 6);
    }

    [Fact]
    public async Task OverviewReturnsTopFiveTools()
    {
        await Post(Fixture("created", "overview-tools", "session.created"));
        var counts = new[] { ("a", 6), ("b", 5), ("c", 4), ("d", 3), ("e", 2), ("f", 1) };
        foreach (var (name, count) in counts)
            for (var i = 0; i < count; i++)
                await Post(Fixture($"tool-{name}-{i}", "overview-tools", "tool.completed") with { Name = name, Status = "ok" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview"));
        var tools = json.RootElement.GetProperty("topTools").EnumerateArray().ToArray();
        Assert.Equal(5, tools.Length);
        Assert.Equal("a", tools[0].GetProperty("name").GetString());
        Assert.Equal("e", tools[4].GetProperty("name").GetString());
        Assert.DoesNotContain(tools, tool => tool.GetProperty("name").GetString() == "f");
    }

    [Fact]
    public async Task OverviewReturnsTopFiveModels()
    {
        await Post(Fixture("created", "overview-models", "session.created"));
        var tokens = new[] { ("model-a", 60), ("model-b", 50), ("model-c", 40), ("model-d", 30), ("model-e", 20), ("model-f", 10) };
        foreach (var (name, count) in tokens)
            await Post(Fixture($"model-{name}", "overview-models", "model.completed") with { Name = name, Model = name, Status = "ok", OutputTokens = count });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview"));
        var models = json.RootElement.GetProperty("topModels").EnumerateArray().ToArray();
        Assert.Equal(5, models.Length);
        Assert.Equal("model-a", models[0].GetProperty("name").GetString());
        Assert.Equal("model-e", models[4].GetProperty("name").GetString());
        Assert.DoesNotContain(models, model => model.GetProperty("name").GetString() == "model-f");
    }

    [Fact]
    public async Task OverviewFiltersByWindow()
    {
        var old = DateTimeOffset.UtcNow.AddDays(-40);
        await Post(Fixture("old", "overview-old", "session.created", old));
        await Post(Fixture("recent", "overview-recent", "session.created"));

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview?days=30"));
        Assert.Equal(1, json.RootElement.GetProperty("totals").GetProperty("sessions").GetInt32());
        var recent = json.RootElement.GetProperty("recentSessions").EnumerateArray().ToArray();
        Assert.Contains(recent, session => session.GetProperty("id").GetString() == "overview-recent");
        Assert.DoesNotContain(recent, session => session.GetProperty("id").GetString() == "overview-old");
    }

    [Fact]
    public async Task OverviewReturnsFiveRecentSessions()
    {
        for (var i = 0; i < 6; i++)
            await Post(Fixture($"recent-{i}", $"overview-recent-{i}", "session.created"));

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview"));
        var recent = json.RootElement.GetProperty("recentSessions").EnumerateArray().ToArray();
        Assert.Equal(5, recent.Length);
        Assert.Contains(recent, session => session.GetProperty("id").GetString() == "overview-recent-5");
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
    Dictionary<string, string>? Attributes = null, double? Cost = null, int ReasoningTokens = 0,
    int CacheReadTokens = 0, int CacheWriteTokens = 0, double? QuotaCostEstimate = null);

internal static class TestCredentials
{
    internal static readonly string ApiKey = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
}
