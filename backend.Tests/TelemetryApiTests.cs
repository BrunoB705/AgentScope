using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

public sealed class TelemetryApiTests : IDisposable
{
    private readonly ApiFactory _factory = new();
    private readonly HttpClient _client;
    public TelemetryApiTests()
    {
        _client = _factory.CreateClient();
        _client.DefaultRequestHeaders.Add("X-Telemetry-Key", TestCredentials.ApiKey);
    }
    public void Dispose() { _client.Dispose(); _factory.Dispose(); }

    [Fact]
    public async Task HealthEndpointIsAvailable()
    {
        var response = await _factory.CreateClient().GetAsync("/api/v1/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Theory]
    [InlineData("/api/v1/sessions")]
    [InlineData("/api/v1/overview")]
    [InlineData("/api/v1/analytics/tools")]
    [InlineData("/api/v1/analytics/models")]
    [InlineData("/api/v1/behavior")]
    [InlineData("/api/v1/comparisons")]
    [InlineData("/api/v1/budgets")]
    [InlineData("/api/v1/benchmarks/suites")]
    public async Task ReadEndpointsRequireLocalKey(string path)
    {
        using var anonymous = _factory.CreateClient();
        var response = await anonymous.GetAsync(path);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);

        var authorized = await _client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, authorized.StatusCode);
    }

    [Fact]
    public async Task MutatingEndpointsRequireLocalKey()
    {
        using var anonymous = _factory.CreateClient();
        var response = await anonymous.PutAsJsonAsync("/api/v1/budgets", new { project = "x", monthlyLimit = 10, metric = "cost" });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task IngestionRequiresLocalKey()
    {
        using var anonymous = _factory.CreateClient();
        var response = await anonymous.PostAsJsonAsync("/api/v1/telemetry/events", Fixture("no-key", "session-no-key", "session.created"));
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
    public async Task MissingTokenCountersStayNullInsteadOfZero()
    {
        var payload = Fixture("model-null-tokens", "session-null-tokens", "model.completed") with { Name = "opencode-go/model-z" };
        Assert.Equal(HttpStatusCode.OK, (await Post(payload)).StatusCode);

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-null-tokens"));
        var metrics = detail.RootElement.GetProperty("metrics");
        Assert.Equal(JsonValueKind.Null, metrics.GetProperty("inputTokens").ValueKind);
        Assert.Equal(JsonValueKind.Null, metrics.GetProperty("outputTokens").ValueKind);

        using var overview = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview"));
        Assert.Equal(JsonValueKind.Null, overview.RootElement.GetProperty("totals").GetProperty("totalTokens").ValueKind);
    }

    [Fact]
    public async Task ReportedZeroTokensStayZero()
    {
        var payload = Fixture("model-zero-tokens", "session-zero-tokens", "model.completed") with
        {
            Name = "opencode-go/model-z", InputTokens = 0, OutputTokens = 0,
        };
        Assert.Equal(HttpStatusCode.OK, (await Post(payload)).StatusCode);

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-zero-tokens"));
        var metrics = detail.RootElement.GetProperty("metrics");
        Assert.Equal(0, metrics.GetProperty("inputTokens").GetInt64());
        Assert.Equal(0, metrics.GetProperty("outputTokens").GetInt64());
    }

    [Fact]
    public async Task LateTitleDoesNotOverwriteNewerTitle()
    {
        var newer = DateTimeOffset.UtcNow;
        Assert.Equal(HttpStatusCode.OK, (await Post(Fixture("title-new", "session-title-order", "session.title.updated", newer) with { Title = "nuevo" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Post(Fixture("title-old", "session-title-order", "session.title.updated", newer.AddMinutes(-5)) with { Title = "viejo" })).StatusCode);

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-title-order"));
        Assert.Equal("nuevo", detail.RootElement.GetProperty("session").GetProperty("title").GetString());
    }

    [Fact]
    public async Task LateModelDoesNotOverwriteNewerModel()
    {
        var newer = DateTimeOffset.UtcNow;
        Assert.Equal(HttpStatusCode.OK, (await Post(Fixture("model-new", "session-model-order", "session.model.selected", newer) with { Model = "opencode-go/nuevo" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Post(Fixture("model-old", "session-model-order", "session.model.selected", newer.AddMinutes(-5)) with { Model = "opencode-go/viejo" })).StatusCode);

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-model-order"));
        Assert.Equal("opencode-go/nuevo", detail.RootElement.GetProperty("session").GetProperty("model").GetString());
    }

    [Fact]
    public async Task QuotaProvenanceIsPersistedOnTheSpan()
    {
        var payload = Fixture("model-prov", "session-provenance", "model.completed") with
        {
            Name = "opencode-go/model-x", Status = "ok", InputTokens = 1000, OutputTokens = 500,
            QuotaCostEstimate = 0.004325,
            QuotaCatalogFetchedAt = "2026-11-17T10:22:00.000Z",
            QuotaRateSnapshot = "{\"input\":0.15,\"output\":0.6,\"cacheRead\":0.015,\"cacheWrite\":0.1875,\"tier\":null}",
        };
        Assert.Equal(HttpStatusCode.OK, (await Post(payload)).StatusCode);

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-provenance"));
        var span = detail.RootElement.GetProperty("spans")[0];
        Assert.Equal(0.004325, span.GetProperty("quotaCostEstimate").GetDouble(), 9);
        Assert.Equal("2026-11-17T10:22:00.000Z", span.GetProperty("quotaCatalogFetchedAt").GetString());
        Assert.Contains("\"cacheWrite\":0.1875", span.GetProperty("quotaRateSnapshot").GetString()!);
        Assert.Equal(JsonValueKind.Null, span.GetProperty("quotaMissingReason").ValueKind);
    }

    [Fact]
    public async Task MissingQuotaPersistsItsReason()
    {
        var payload = Fixture("model-missing", "session-provenance-missing", "model.completed") with
        {
            Name = "opencode-go/model-y", Status = "ok", QuotaMissingReason = "no_catalog",
        };
        Assert.Equal(HttpStatusCode.OK, (await Post(payload)).StatusCode);

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-provenance-missing"));
        var span = detail.RootElement.GetProperty("spans")[0];
        Assert.Equal(JsonValueKind.Null, span.GetProperty("quotaCostEstimate").ValueKind);
        Assert.Equal("no_catalog", span.GetProperty("quotaMissingReason").GetString());
    }

    [Fact]
    public async Task OversizedQuotaSnapshotIsRejected()
    {
        var payload = Fixture("model-big", "session-provenance-big", "model.completed") with
        {
            QuotaRateSnapshot = new string('x', 501),
        };
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(payload)).StatusCode);
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
        Assert.StartsWith("Tool loop", signal.GetProperty("title").GetString());
        Assert.Contains("was called 4 times", signal.GetProperty("explanation").GetString());
        Assert.Contains("longest streak was 4", signal.GetProperty("explanation").GetString());
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
        Assert.Equal("Error burst", signals[0].GetProperty("title").GetString());
        Assert.Contains("tool errors", signals[0].GetProperty("explanation").GetString());
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
        Assert.Equal("Long session", signal.GetProperty("title").GetString());
        Assert.Contains("model steps and 30 spans", signal.GetProperty("explanation").GetString());
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
        var signal = signals.EnumerateArray().Single(item => item.GetProperty("kind").GetString() == "interrupted");
        Assert.Equal("Interrupted session", signal.GetProperty("title").GetString());
        Assert.Equal("The run was left interrupted.", signal.GetProperty("explanation").GetString());
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
        var counts = new[] { ("z", 6), ("y", 5), ("x", 4), ("w", 3), ("v", 2), ("u", 1) };
        foreach (var (name, count) in counts)
            for (var i = 0; i < count; i++)
                await Post(Fixture($"tool-{name}-{i}", "overview-tools", "tool.completed") with { Name = name, Status = "ok" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview"));
        var tools = json.RootElement.GetProperty("topTools").EnumerateArray().ToArray();
        Assert.Equal(5, tools.Length);
        Assert.Equal("z", tools[0].GetProperty("name").GetString());
        Assert.Equal("v", tools[4].GetProperty("name").GetString());
        Assert.DoesNotContain(tools, tool => tool.GetProperty("name").GetString() == "u");
    }

    [Fact]
    public async Task OverviewReturnsTopFiveModels()
    {
        await Post(Fixture("created", "overview-models", "session.created"));
        var tokens = new[] { ("model-z", 60), ("model-y", 50), ("model-x", 40), ("model-w", 30), ("model-v", 20), ("model-u", 10) };
        foreach (var (name, count) in tokens)
            await Post(Fixture($"model-{name}", "overview-models", "model.completed") with { Name = name, Model = name, Status = "ok", OutputTokens = count });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview"));
        var models = json.RootElement.GetProperty("topModels").EnumerateArray().ToArray();
        Assert.Equal(5, models.Length);
        Assert.Equal("model-z", models[0].GetProperty("name").GetString());
        Assert.Equal("model-v", models[4].GetProperty("name").GetString());
        Assert.DoesNotContain(models, model => model.GetProperty("name").GetString() == "model-u");
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
    public async Task OverviewFiltersByOneDay()
    {
        var old = DateTimeOffset.UtcNow.AddDays(-2);
        await Post(Fixture("old-day", "overview-old-day", "session.created", old));
        await Post(Fixture("recent-day", "overview-recent-day", "session.created"));

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview?days=1"));
        Assert.Equal(1, json.RootElement.GetProperty("totals").GetProperty("sessions").GetInt32());
        var recent = json.RootElement.GetProperty("recentSessions").EnumerateArray().ToArray();
        Assert.Contains(recent, session => session.GetProperty("id").GetString() == "overview-recent-day");
        Assert.DoesNotContain(recent, session => session.GetProperty("id").GetString() == "overview-old-day");
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
        Assert.DoesNotContain(recent, session => session.GetProperty("id").GetString() == "overview-recent-0");
    }

    [Fact]
    public async Task DeleteSessionRemovesSessionSpansAndEvents()
    {
        await Post(Fixture("del-1", "session-delete", "session.created"));
        await Post(Fixture("del-2", "session-delete", "model.completed") with { Name = "opencode-go/model-a", InputTokens = 10 });

        var missing = await _client.DeleteAsync("/api/v1/sessions/does-not-exist");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);

        var deleted = await _client.DeleteAsync("/api/v1/sessions/session-delete");
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);

        var detail = await _client.GetAsync("/api/v1/sessions/session-delete");
        Assert.Equal(HttpStatusCode.NotFound, detail.StatusCode);

        var repeated = await _client.DeleteAsync("/api/v1/sessions/session-delete");
        Assert.Equal(HttpStatusCode.NotFound, repeated.StatusCode);
    }

    [Fact]
    public async Task PurgeDataSupportsDryRunAndDeletesOlderSessions()
    {
        await Post(Fixture("old-c", "session-old", "session.created"));
        await Post(Fixture("old-m", "session-old", "model.completed") with { Name = "opencode-go/model-a", InputTokens = 5 });
        await Post(Fixture("new-c", "session-new", "session.created"));

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TelemetryDb>();
            await db.Sessions.Where(s => s.Id == "session-old")
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.UpdatedAt, DateTime.UtcNow.AddDays(-10)));
        }

        var cutoff = Uri.EscapeDataString(DateTimeOffset.UtcNow.AddDays(-5).ToString("O"));
        var dryResponse = await _client.DeleteAsync($"/api/v1/data?before={cutoff}&dryRun=true");
        Assert.Equal(HttpStatusCode.OK, dryResponse.StatusCode);
        using (var dryJson = JsonDocument.Parse(await dryResponse.Content.ReadAsStringAsync()))
        {
            Assert.True(dryJson.RootElement.GetProperty("dryRun").GetBoolean());
            Assert.Equal(1, dryJson.RootElement.GetProperty("sessions").GetInt32());
            Assert.Equal(1, dryJson.RootElement.GetProperty("spans").GetInt32());
            Assert.Equal(2, dryJson.RootElement.GetProperty("events").GetInt32());
        }
        Assert.Equal(HttpStatusCode.OK, (await _client.GetAsync("/api/v1/sessions/session-old")).StatusCode);

        var purgeResponse = await _client.DeleteAsync($"/api/v1/data?before={cutoff}&dryRun=false");
        Assert.Equal(HttpStatusCode.OK, purgeResponse.StatusCode);
        using (var purgeJson = JsonDocument.Parse(await purgeResponse.Content.ReadAsStringAsync()))
        {
            Assert.False(purgeJson.RootElement.GetProperty("dryRun").GetBoolean());
            Assert.Equal(1, purgeJson.RootElement.GetProperty("sessions").GetInt32());
        }
        Assert.Equal(HttpStatusCode.NotFound, (await _client.GetAsync("/api/v1/sessions/session-old")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _client.GetAsync("/api/v1/sessions/session-new")).StatusCode);
    }

    [Fact]
    public async Task ExportReturnsJsonLinesWithSafeAttributes()
    {
        await Post(Fixture("exp-1", "session-export", "session.created"));
        await Post(Fixture("exp-2", "session-export", "tool.completed") with
        {
            Name = "bash",
            Attributes = new Dictionary<string, string> { ["trace.id"] = "trace-exp", ["secret"] = "should-not-appear" }
        });

        var response = await _client.GetAsync("/api/v1/export");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/x-ndjson", response.Content.Headers.ContentType?.MediaType);
        var body = await response.Content.ReadAsStringAsync();
        var lines = body.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Single(lines);

        using var lineJson = JsonDocument.Parse(lines[0]);
        Assert.Equal("session-export", lineJson.RootElement.GetProperty("session").GetProperty("id").GetString());
        Assert.Equal(1, lineJson.RootElement.GetProperty("spans").GetArrayLength());
        Assert.Equal(2, lineJson.RootElement.GetProperty("events").GetArrayLength());
        Assert.Contains("trace-exp", body);
        Assert.DoesNotContain("should-not-appear", body);
    }

    [Fact]
    public async Task ScopeFilterSeparatesRealWorkFromBenchmarks()
    {
        await Post(Fixture("real-1", "session-real", "session.created") with { Project = "my-app" });
        await Post(Fixture("real-m", "session-real", "model.completed") with { Project = "my-app", Name = "opencode-go/m1", InputTokens = 10 });
        await Post(Fixture("bench-1", "session-bench", "session.created") with { Project = "benchmark" });
        await Post(Fixture("bench-t", "session-bench", "session.title.updated") with { Project = "benchmark", Title = "bench/run1/res1" });
        await Post(Fixture("bench-m", "session-bench", "model.completed") with { Project = "benchmark", Name = "opencode-go/m1", InputTokens = 90 });

        using (var allOverview = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview")))
            Assert.Equal(2, allOverview.RootElement.GetProperty("totals").GetProperty("sessions").GetInt32());

        using (var realOverview = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview?scope=real")))
        {
            Assert.Equal(1, realOverview.RootElement.GetProperty("totals").GetProperty("sessions").GetInt32());
            Assert.Equal(10, realOverview.RootElement.GetProperty("totals").GetProperty("inputTokens").GetInt64());
        }

        using (var benchOverview = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/overview?scope=benchmarks")))
        {
            Assert.Equal(1, benchOverview.RootElement.GetProperty("totals").GetProperty("sessions").GetInt32());
            Assert.Equal(90, benchOverview.RootElement.GetProperty("totals").GetProperty("inputTokens").GetInt64());
        }

        using (var realSessions = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions?scope=real")))
        {
            var items = realSessions.RootElement.GetProperty("items");
            Assert.Equal(1, items.GetArrayLength());
            Assert.Equal("session-real", items[0].GetProperty("id").GetString());
        }
    }

    [Fact]
    public async Task RetentionPurgesExpiredSessionsOnStartup()
    {
        var dbPath = Path.Combine(Path.GetTempPath(), $"retention-{Guid.NewGuid():N}.db");
        try
        {
            await using (var seed = new TelemetryDb(new DbContextOptionsBuilder<TelemetryDb>().UseSqlite($"Data Source={dbPath};Pooling=False").Options))
            {
                await SchemaMigrator.ApplyAsync(seed);
                seed.Sessions.AddRange(
                    new Session { Id = "expired", Source = "opencode", Status = "completed", StartedAt = DateTime.UtcNow.AddDays(-40), UpdatedAt = DateTime.UtcNow.AddDays(-40) },
                    new Session { Id = "current", Source = "opencode", Status = "completed", StartedAt = DateTime.UtcNow.AddDays(-2), UpdatedAt = DateTime.UtcNow.AddDays(-2) });
                await seed.SaveChangesAsync();
            }

            using var factory = new ApiFactory(dbPath, retentionDays: 30);
            using var client = factory.CreateClient();
            client.DefaultRequestHeaders.Add("X-Telemetry-Key", TestCredentials.ApiKey);

            using var listing = JsonDocument.Parse(await client.GetStringAsync("/api/v1/sessions"));
            var ids = listing.RootElement.GetProperty("items").EnumerateArray().Select(item => item.GetProperty("id").GetString()).ToArray();
            Assert.Equal(new[] { "current" }, ids);
        }
        finally
        {
            if (File.Exists(dbPath)) File.Delete(dbPath);
        }
    }

    [Fact]
    public async Task HealthReportsDatabaseAndSchemaStatus()
    {
        var response = await _factory.CreateClient().GetAsync("/api/v1/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("ok", json.RootElement.GetProperty("status").GetString());
        Assert.Equal("ok", json.RootElement.GetProperty("database").GetString());
        Assert.Equal("current", json.RootElement.GetProperty("migrations").GetString());
        Assert.Equal(SchemaMigrator.LatestVersion, json.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(1, json.RootElement.GetProperty("protocolVersion").GetInt32());
    }

    [Fact]
    public async Task VersionEndpointReportsProtocolAndSchemaVersion()
    {
        using var anonymous = _factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/v1/version")).StatusCode);

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/version"));
        Assert.Equal(1, json.RootElement.GetProperty("protocolVersion").GetInt32());
        Assert.Equal(SchemaMigrator.LatestVersion, json.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(SchemaMigrator.LatestVersion, json.RootElement.GetProperty("latestSchemaVersion").GetInt32());
    }

    [Fact]
    public async Task IngestionRejectsUnsupportedProtocolVersionWith426()
    {
        using var byHeader = new HttpRequestMessage(HttpMethod.Post, "/api/v1/telemetry/events")
        {
            Content = JsonContent.Create(Fixture("proto-hdr", "session-proto", "session.created"))
        };
        byHeader.Headers.Add("X-Telemetry-Protocol", "99");
        var headerResponse = await _client.SendAsync(byHeader);
        Assert.Equal(HttpStatusCode.UpgradeRequired, headerResponse.StatusCode);
        Assert.Equal("1", headerResponse.Headers.GetValues("X-Telemetry-Protocol").Single());

        var payloadResponse = await Post(Fixture("proto-dto", "session-proto", "session.created") with { ProtocolVersion = 99 });
        Assert.Equal(HttpStatusCode.UpgradeRequired, payloadResponse.StatusCode);
    }

    [Fact]
    public async Task SessionListFiltersByProjectToolAndSpanError()
    {
        await Post(Fixture("s1-c", "sess-filter-1", "session.created") with { Project = "alpha-app" });
        await Post(Fixture("s1-t", "sess-filter-1", "tool.completed") with { Project = "alpha-app", Name = "bash", Status = "error" });
        await Post(Fixture("s1-i", "sess-filter-1", "session.idle") with { Project = "alpha-app", Status = "completed" });

        await Post(Fixture("s2-c", "sess-filter-2", "session.created") with { Project = "beta-app" });
        await Post(Fixture("s2-t", "sess-filter-2", "tool.completed") with { Project = "beta-app", Name = "read", Status = "ok" });
        await Post(Fixture("s2-i", "sess-filter-2", "session.idle") with { Project = "beta-app", Status = "completed" });

        using (var byProject = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions?project=beta")))
        {
            var items = byProject.RootElement.GetProperty("items");
            Assert.Equal(1, items.GetArrayLength());
            Assert.Equal("sess-filter-2", items[0].GetProperty("id").GetString());
        }

        using (var byToolAndError = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions?tool=bash&error=true")))
        {
            var items = byToolAndError.RootElement.GetProperty("items");
            Assert.Equal(1, items.GetArrayLength());
            Assert.Equal("sess-filter-1", items[0].GetProperty("id").GetString());
        }
    }

    [Fact]
    public async Task ComparisonsNormalizeWhitespaceAndCaseInTaskLabel()
    {
        await Post(Fixture("c1", "comp-1", "session.created"));
        await Post(Fixture("c2", "comp-2", "session.created"));

        var r1 = await _client.PutAsJsonAsync("/api/v1/sessions/comp-1/review", new { rating = 5, note = "ok", taskLabel = "  Revisar   Contrato  " });
        var r2 = await _client.PutAsJsonAsync("/api/v1/sessions/comp-2/review", new { rating = 4, note = "bien", taskLabel = "revisar contrato" });
        Assert.Equal(HttpStatusCode.OK, r1.StatusCode);
        Assert.Equal(HttpStatusCode.OK, r2.StatusCode);

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/comparisons"));
        var group = Assert.Single(json.RootElement.EnumerateArray());
        Assert.Equal(2, group.GetProperty("sessions").GetArrayLength());
    }

    [Fact]
    public async Task BudgetsReportPartialSpanCoverage()
    {
        var putBudget = await _client.PutAsJsonAsync("/api/v1/budgets", new { project = "partial-proj", monthlyLimit = 10, metric = "cost" });
        Assert.Equal(HttpStatusCode.OK, putBudget.StatusCode);

        await Post(Fixture("b1-c", "sess-budget-partial", "session.created") with { Project = "partial-proj" });
        await Post(Fixture("b1-m1", "sess-budget-partial", "model.completed") with { Project = "partial-proj", Name = "m", Cost = 0.25 });
        await Post(Fixture("b1-m2", "sess-budget-partial", "model.completed") with { Project = "partial-proj", Name = "m", Cost = null });
        await Post(Fixture("b1-t1", "sess-budget-partial", "tool.completed") with { Project = "partial-proj", Name = "read" });

        using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/budgets"));
        var entry = json.RootElement.EnumerateArray().Single(item => item.GetProperty("project").GetString() == "partial-proj");
        Assert.Equal(2, entry.GetProperty("totalSpans").GetInt32());
        Assert.Equal(1, entry.GetProperty("measuredSpans").GetInt32());
        Assert.True(entry.GetProperty("isPartial").GetBoolean());
        Assert.Equal(0.25, entry.GetProperty("spent").GetDouble(), 6);
    }

    [Fact]
    public async Task SessionDetailIncludesTraceQualityAndUnrelatedEvents()
    {
        await Post(Fixture("q1-c", "sess-complete", "session.created"));
        await Post(Fixture("q1-m", "sess-complete", "model.completed") with { Name = "opencode-go/m1", DurationMs = 100, InputTokens = 10, OutputTokens = 5 });
        await Post(Fixture("q1-t", "sess-complete", "tool.completed") with { Name = "read", ParentId = "q1-m", DurationMs = 20 });

        using (var complete = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/sess-complete")))
        {
            var quality = complete.RootElement.GetProperty("quality");
            Assert.Equal("complete", quality.GetProperty("status").GetString());
            Assert.True(quality.GetProperty("hasSessionCreated").GetBoolean());
            Assert.Equal(0, quality.GetProperty("orphanToolSpans").GetInt32());
            Assert.Equal(1, complete.RootElement.GetProperty("unrelatedEvents").GetArrayLength());
        }

        await Post(Fixture("q2-m", "sess-partial", "model.completed") with { Name = "model" });
        await Post(Fixture("q2-t", "sess-partial", "tool.completed") with { Name = "bash" });

        using (var partial = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/sess-partial")))
        {
            var quality = partial.RootElement.GetProperty("quality");
            Assert.Equal("partial", quality.GetProperty("status").GetString());
            Assert.False(quality.GetProperty("hasSessionCreated").GetBoolean());
            Assert.Equal(1, quality.GetProperty("orphanToolSpans").GetInt32());
            Assert.Equal(2, quality.GetProperty("missingDurationSpans").GetInt32());
            Assert.Equal(1, quality.GetProperty("missingTokenSpans").GetInt32());
            Assert.Equal(1, quality.GetProperty("unknownModelSpans").GetInt32());
        }
    }

    [Fact]
    public async Task IngestionFlagsTruncatedAttributesAndKeepsSafeSubstringKeys()
    {
        var attributes = Enumerable.Range(0, 40).ToDictionary(i => $"attr_{i:D2}", i => i.ToString());
        attributes["compassion"] = "kept";
        attributes["filePath"] = "C:/private/file.txt";
        await Post(Fixture("attr-trunc", "sess-attr-trunc", "session.created") with { Attributes = attributes });

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/sess-attr-trunc"));
        using var stored = JsonDocument.Parse(detail.RootElement.GetProperty("events")[0].GetProperty("attributesJson").GetString()!);
        var root = stored.RootElement;
        Assert.Equal("true", root.GetProperty("attributes_truncated").GetString());
        Assert.Equal("9", root.GetProperty("attributes_dropped").GetString());
        Assert.False(root.TryGetProperty("filePath", out _));
        Assert.DoesNotContain("private", root.GetRawText());
    }

    [Fact]
    public async Task SessionKeepsFirstSourceAndReportsSourceConflicts()
    {
        await Post(Fixture("src-1", "sess-source", "session.created"));
        await Post(Fixture("src-2", "sess-source", "model.completed") with { Source = "other-agent", Name = "opencode-go/m1", DurationMs = 10, InputTokens = 1, OutputTokens = 1 });

        using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/sess-source"));
        Assert.Equal("opencode", detail.RootElement.GetProperty("session").GetProperty("source").GetString());
        var quality = detail.RootElement.GetProperty("quality");
        Assert.Equal(1, quality.GetProperty("sourceConflictEvents").GetInt32());
        Assert.Equal("partial", quality.GetProperty("status").GetString());
    }

    [Fact]
    public async Task ModelAnalyticsComputesSpeedUnitCostReliabilityAndIgnoresMissingDurations()
    {
        await Post(Fixture("ma-s1", "sess-ma-1", "session.created"));
        await Post(Fixture("ma-1", "sess-ma-1", "model.completed") with { Name = "opencode-go/fast", DurationMs = 2000, InputTokens = 300, OutputTokens = 100, CacheReadTokens = 100, QuotaCostEstimate = 0.02, Cost = 0.01 });
        await Post(Fixture("ma-2", "sess-ma-1", "model.completed") with { Name = "opencode-go/fast", DurationMs = null, InputTokens = 50, OutputTokens = 50, QuotaCostEstimate = null, Cost = null });
        await Post(Fixture("ma-e1", "sess-ma-1", "session.execution.succeeded"));
        await Post(Fixture("ma-z1", "sess-ma-zero", "model.completed") with { Name = "opencode-go/zero-dur", DurationMs = 0, InputTokens = 10, OutputTokens = 10 });

        using var doc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/analytics/models"));
        var models = doc.RootElement.GetProperty("models").EnumerateArray().ToDictionary(m => m.GetProperty("name").GetString()!);

        var fast = models["opencode-go/fast"];
        Assert.Equal(2000, fast.GetProperty("averageDurationMs").GetDouble(), 6);
        Assert.Equal(50, fast.GetProperty("outputTokensPerSec").GetDouble(), 6);
        Assert.Equal(100d / 450d, fast.GetProperty("cacheEfficiency").GetDouble(), 6);
        Assert.Equal(0.02, fast.GetProperty("quotaPerCall").GetDouble(), 6);
        Assert.Equal(0.01, fast.GetProperty("reportedCostPerCall").GetDouble(), 6);
        Assert.Equal(40, fast.GetProperty("quotaPer1MTokens").GetDouble(), 2);
        Assert.Equal(1, fast.GetProperty("sessionCount").GetInt32());
        Assert.Equal(1.0, fast.GetProperty("callSuccessRate").GetDouble(), 6);
        Assert.Equal(1.0, fast.GetProperty("completedSessionRate").GetDouble(), 6);

        var zero = models["opencode-go/zero-dur"];
        Assert.Equal(JsonValueKind.Null, zero.GetProperty("averageDurationMs").ValueKind);
        Assert.Equal(JsonValueKind.Null, zero.GetProperty("outputTokensPerSec").ValueKind);
    }

    [Fact]
    public async Task ModelAnalyticsIncludesBenchmarkPassRateAndRespectsRealScope()
    {
        await Post(Fixture("mb-1", "sess-mb-real", "model.completed") with { Name = "opencode-go/m1#high", DurationMs = 1000, InputTokens = 100, OutputTokens = 20 });
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TelemetryDb>();
            db.BenchmarkRuns.Add(new BenchmarkRunEntity { Id = "run-ma", Suite = "demo", JudgeModel = "j", Status = "completed", Total = 2, Completed = 2, CreatedAt = DateTime.UtcNow });
            db.BenchmarkResults.AddRange(
                new BenchmarkResultEntity { Id = "res-ma-1", RunId = "run-ma", TestName = "t1", TestType = "code", Model = "opencode-go/m1#high", Status = "completed", VerifyPassed = true, JudgeScore = 4, CompletedAt = DateTime.UtcNow },
                new BenchmarkResultEntity { Id = "res-ma-2", RunId = "run-ma", TestName = "t2", TestType = "code", Model = "opencode-go/m1#high", Status = "completed", VerifyPassed = false, CompletedAt = DateTime.UtcNow });
            await db.SaveChangesAsync();
        }

        using (var allDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/analytics/models")))
        {
            var m1 = allDoc.RootElement.GetProperty("models").EnumerateArray().First(m => m.GetProperty("name").GetString() == "opencode-go/m1#high");
            Assert.Equal(2, m1.GetProperty("benchmarkCases").GetInt32());
            Assert.Equal(0.5, m1.GetProperty("benchmarkPassRate").GetDouble(), 6);
            Assert.Equal(4.0, m1.GetProperty("benchmarkJudgeAvg").GetDouble(), 6);
        }

        using (var realDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/analytics/models?scope=real")))
        {
            var m1 = realDoc.RootElement.GetProperty("models").EnumerateArray().First(m => m.GetProperty("name").GetString() == "opencode-go/m1#high");
            Assert.Equal(0, m1.GetProperty("benchmarkCases").GetInt32());
            Assert.Equal(JsonValueKind.Null, m1.GetProperty("benchmarkPassRate").ValueKind);
        }
    }

    [Fact]
    public async Task OrchestratorSubagentTreeAndRoleBreakdownAreExposedInSessionDetailAndList()
    {
        var now = DateTimeOffset.UtcNow;
        await Post(Fixture("orch-c", "sess-orch", "session.created", now) with { Title = "Plan principal", Agent = "orchestrator" });
        await Post(Fixture("orch-m", "sess-orch", "model.completed", now.AddSeconds(1)) with { Name = "opencode-go/m1", Agent = "orchestrator", DurationMs = 1500, InputTokens = 400, OutputTokens = 100, QuotaCostEstimate = 0.01 });

        await Post(Fixture("sub-c", "sess-sub-rev", "session.created", now.AddSeconds(2)) with { Title = "Revisar PR", ParentSessionId = "sess-orch", Agent = "reviewer" });
        await Post(Fixture("sub-m", "sess-sub-rev", "model.completed", now.AddSeconds(3)) with { Name = "opencode-go/m2", Agent = "reviewer", DurationMs = 2000, InputTokens = 200, OutputTokens = 80, QuotaCostEstimate = 0.02 });
        await Post(Fixture("sub-e", "sess-sub-rev", "session.execution.succeeded", now.AddSeconds(5)));

        using (var listDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions")))
        {
            var items = listDoc.RootElement.GetProperty("items").EnumerateArray().ToDictionary(x => x.GetProperty("id").GetString()!);
            Assert.Equal(1, items["sess-orch"].GetProperty("subagentCount").GetInt32());
            Assert.Equal("orchestrator", items["sess-orch"].GetProperty("agent").GetString());
            Assert.Equal("sess-orch", items["sess-sub-rev"].GetProperty("parentSessionId").GetString());
            Assert.Equal("reviewer", items["sess-sub-rev"].GetProperty("agent").GetString());
        }

        using (var filteredDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions?agent=reviewer")))
        {
            var items = filteredDoc.RootElement.GetProperty("items").EnumerateArray().ToArray();
            Assert.Single(items);
            Assert.Equal("sess-sub-rev", items[0].GetProperty("id").GetString());
        }

        using (var rootsDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions?rootOnly=true")))
        {
            var ids = rootsDoc.RootElement.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetString()).ToArray();
            Assert.Contains("sess-orch", ids);
            Assert.DoesNotContain("sess-sub-rev", ids);
        }

        using (var childrenDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions?parentSessionId=sess-orch")))
        {
            var items = childrenDoc.RootElement.GetProperty("items").EnumerateArray().ToArray();
            Assert.Single(items);
            Assert.Equal("sess-sub-rev", items[0].GetProperty("id").GetString());
        }

        using (var orchDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/sess-orch")))
        {
            Assert.Equal(JsonValueKind.Null, orchDoc.RootElement.GetProperty("parentSession").ValueKind);
            var subagents = orchDoc.RootElement.GetProperty("subagents").EnumerateArray().ToArray();
            Assert.Single(subagents);
            Assert.Equal("sess-sub-rev", subagents[0].GetProperty("id").GetString());
            Assert.Equal("reviewer", subagents[0].GetProperty("agent").GetString());
            Assert.Equal(0.02, subagents[0].GetProperty("quotaCostEstimate").GetDouble(), 6);

            var roles = orchDoc.RootElement.GetProperty("roleBreakdown").EnumerateArray().ToDictionary(r => r.GetProperty("role").GetString()!);
            Assert.Equal(2, roles.Count);
            Assert.Equal(500, roles["orchestrator"].GetProperty("tokens").GetInt64());
            Assert.Equal(280, roles["reviewer"].GetProperty("tokens").GetInt64());
        }

        using (var subDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/sess-sub-rev")))
        {
            var parent = subDoc.RootElement.GetProperty("parentSession");
            Assert.Equal("sess-orch", parent.GetProperty("id").GetString());
            Assert.Equal("orchestrator", parent.GetProperty("agent").GetString());
            Assert.Equal("reviewer", subDoc.RootElement.GetProperty("spans")[0].GetProperty("agent").GetString());
        }

        using (var modelsDoc = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/analytics/models")))
        {
            var roles = modelsDoc.RootElement.GetProperty("roles").EnumerateArray().ToDictionary(r => r.GetProperty("role").GetString()!);
            Assert.True(roles.ContainsKey("orchestrator"));
            Assert.True(roles.ContainsKey("reviewer"));
            Assert.Equal(1, roles["reviewer"].GetProperty("calls").GetInt32());
        }
    }

    private async Task<HttpResponseMessage> Post(TestTelemetryEventDto dto)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/telemetry/events") { Content = JsonContent.Create(dto) };
        return await _client.SendAsync(request);
    }

    private static TestTelemetryEventDto Fixture(string eventId, string sessionId, string type, DateTimeOffset? timestamp = null) => new(
        eventId, "opencode", sessionId, timestamp ?? DateTimeOffset.UtcNow, type, Project: "fixture", Status: "ok");
}

public sealed class ApiFactory : WebApplicationFactory<Program>
{
    private readonly string _database;
    private readonly int? _retentionDays;
    private readonly bool _ownsDatabase;

    public ApiFactory()
    {
        _database = Path.Combine(Path.GetTempPath(), $"agent-observability-{Guid.NewGuid():N}.db");
        _ownsDatabase = true;
    }

    public ApiFactory(string database, int? retentionDays = null)
    {
        _database = database;
        _retentionDays = retentionDays;
        _ownsDatabase = false;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Telemetry"] = $"Data Source={_database};Pooling=False",
            ["Telemetry:ApiKey"] = TestCredentials.ApiKey,
            ["ASPNETCORE_ENVIRONMENT"] = "Development"
        };
        if (_retentionDays.HasValue) settings["Telemetry:RetentionDays"] = _retentionDays.Value.ToString();
        builder.ConfigureAppConfiguration(config => config.AddInMemoryCollection(settings));
        builder.ConfigureLogging(logging => logging.ClearProviders());
    }
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && _ownsDatabase && File.Exists(_database)) File.Delete(_database);
    }
}

public sealed record TestTelemetryEventDto(
    string EventId, string Source, string SessionId, DateTimeOffset Timestamp, string Type,
    string? Project = null, string? Status = null, long? DurationMs = null, string? Model = null,
    int? InputTokens = null, int? OutputTokens = null, string? ParentId = null, string? Name = null,
    Dictionary<string, string>? Attributes = null, double? Cost = null, int? ReasoningTokens = null,
    int? CacheReadTokens = null, int? CacheWriteTokens = null, double? QuotaCostEstimate = null,
    string? QuotaCatalogFetchedAt = null, string? QuotaRateSnapshot = null, string? QuotaMissingReason = null,
    string? Title = null, int? ProtocolVersion = null, string? ParentSessionId = null, string? Agent = null);

internal static class TestCredentials
{
    internal static readonly string ApiKey = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
}
