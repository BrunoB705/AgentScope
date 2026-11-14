using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.Sqlite;

var builder = WebApplication.CreateBuilder(args);
if (string.IsNullOrWhiteSpace(builder.Configuration["Telemetry:ApiKey"])) throw new InvalidOperationException("Telemetry:ApiKey must be set through environment configuration.");
builder.Services.AddDbContext<TelemetryDb>(o => o.UseSqlite(builder.Configuration.GetConnectionString("Telemetry") ?? "Data Source=telemetry.db"));
builder.Services.AddSignalR();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));
var app = builder.Build();
using (var scope = app.Services.CreateScope()) {
    var db = scope.ServiceProvider.GetRequiredService<TelemetryDb>();
    await db.Database.EnsureCreatedAsync();
    foreach (var table in new[] { "Events", "Spans" }) {
        await EnsureColumnAsync(db, table, "Cost", "REAL NULL");
        await EnsureColumnAsync(db, table, "ReasoningTokens", "INTEGER NOT NULL DEFAULT 0");
        await EnsureColumnAsync(db, table, "CacheReadTokens", "INTEGER NOT NULL DEFAULT 0");
        await EnsureColumnAsync(db, table, "CacheWriteTokens", "INTEGER NOT NULL DEFAULT 0");
        await EnsureColumnAsync(db, table, "QuotaCostEstimate", "REAL NULL");
    }
    await EnsureSessionTitleColumnAsync(db);
    await EnsureSessionReviewColumnsAsync(db);
    await db.Database.ExecuteSqlRawAsync("CREATE TABLE IF NOT EXISTS Budgets (Project TEXT NOT NULL PRIMARY KEY, MonthlyLimit REAL NOT NULL, Metric TEXT NOT NULL)");
}
app.UseCors();
app.MapHub<TelemetryHub>("/hubs/telemetry");
app.MapGet("/api/v1/health", () => Results.Ok(new { status = "ok" }));
var ingestLock = new SemaphoreSlim(1, 1);
app.MapPut("/api/v1/sessions/{id}/review", async (string id, SessionReviewDto dto, TelemetryDb db, IHubContext<TelemetryHub> hub) => {
    if (dto.Rating is < 1 or > 5 || dto.Note?.Length > 2000 || dto.TaskLabel?.Length > 120) return Results.BadRequest(new { error = "La puntuación debe ser de 1 a 5, la tarea no puede superar 120 caracteres y la nota 2000." });
    IResult response;
    await ingestLock.WaitAsync();
    try {
        var session = await db.Sessions.FindAsync(id);
        if (session is null) return Results.NotFound();
        session.Rating = dto.Rating;
        session.ReviewNote = string.IsNullOrWhiteSpace(dto.Note) ? null : dto.Note.Trim();
        session.ReviewTask = string.IsNullOrWhiteSpace(dto.TaskLabel) ? null : Safe(dto.TaskLabel.Trim(), 120);
        await db.SaveChangesAsync();
        response = Results.Ok(new { rating = session.Rating, note = session.ReviewNote });
    }
    finally { ingestLock.Release(); }
    await hub.Clients.All.SendAsync("telemetry.updated", new { sessionId = id, type = "session.review.updated" });
    return response;
});
app.MapGet("/api/v1/comparisons", async (TelemetryDb db) => {
    var sessions = await db.Sessions.AsNoTracking().Where(s => s.ReviewTask != null && s.ReviewTask != "").OrderByDescending(s => s.UpdatedAt).ToListAsync();
    var ids = sessions.Select(s => s.Id).ToList();
    var spans = await db.Spans.AsNoTracking().Where(s => ids.Contains(s.SessionId)).ToListAsync();
    var runs = sessions.Select(session => {
        var sessionSpans = spans.Where(span => span.SessionId == session.Id).ToList();
        var elapsed = (session.EndedAt ?? session.UpdatedAt) - session.StartedAt;
        return new ComparisonRunDto(session.Id, session.Title, session.Project, session.Model, session.Status, session.Rating, session.ReviewNote, session.ReviewTask!, session.UpdatedAt, Math.Max(0, (long)elapsed.TotalMilliseconds), sessionSpans.Sum(span => span.InputTokens), sessionSpans.Sum(span => span.OutputTokens), sessionSpans.Any(span => span.Cost.HasValue) ? sessionSpans.Where(span => span.Cost.HasValue).Sum(span => span.Cost!.Value) : null, sessionSpans.Any(span => span.QuotaCostEstimate.HasValue) ? sessionSpans.Where(span => span.QuotaCostEstimate.HasValue).Sum(span => span.QuotaCostEstimate!.Value) : null, sessionSpans.Where(span => span.Kind == "execute_tool").Select(span => span.Name).Distinct().Order().ToArray());
    }).ToList();
    var groups = runs.GroupBy(run => run.TaskLabel.Trim(), StringComparer.OrdinalIgnoreCase).OrderBy(group => group.Key).Select(group => new { taskLabel = group.Key, sessions = group.OrderByDescending(run => run.UpdatedAt).ToArray() });
    return Results.Ok(groups);
});
app.MapGet("/api/v1/budgets", async (TelemetryDb db) => {
    var start = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1, 0, 0, 0, DateTimeKind.Utc);
    var budgets = await db.Budgets.AsNoTracking().OrderBy(x => x.Project).ToListAsync();
    var rows = new List<object>();
    foreach (var budget in budgets) {
        var usage = db.Spans.AsNoTracking().Join(db.Sessions.AsNoTracking().Where(s => s.Project == budget.Project), span => span.SessionId, session => session.Id, (span, session) => span).Where(span => span.StartedAt >= start);
        var spent = budget.Metric == "quota"
            ? await usage.SumAsync(s => (double?)s.QuotaCostEstimate)
            : await usage.SumAsync(s => (double?)s.Cost);
        rows.Add(new { project = budget.Project, monthlyLimit = budget.MonthlyLimit, metric = budget.Metric, spent, periodStart = start, percentage = spent.HasValue ? spent.Value / budget.MonthlyLimit * 100 : (double?)null });
    }
    return Results.Ok(rows);
});
app.MapPut("/api/v1/budgets", async (BudgetDto dto, TelemetryDb db) => {
    var project = Safe(dto.Project?.Trim(), 120);
    if (string.IsNullOrWhiteSpace(project) || !double.IsFinite(dto.MonthlyLimit) || dto.MonthlyLimit <= 0 || dto.MonthlyLimit > 1_000_000 || dto.Metric is not ("cost" or "quota")) return Results.BadRequest(new { error = "Indica proyecto, límite mensual válido y métrica cost o quota." });
    var budget = await db.Budgets.FindAsync(project);
    if (budget is null) { budget = new Budget { Project = project }; db.Budgets.Add(budget); }
    budget.MonthlyLimit = dto.MonthlyLimit;
    budget.Metric = dto.Metric;
    await db.SaveChangesAsync();
    return Results.Ok(new { budget.Project, budget.MonthlyLimit, budget.Metric });
});
app.MapDelete("/api/v1/budgets", async (string project, TelemetryDb db) => {
    var budget = await db.Budgets.FindAsync(project);
    if (budget is null) return Results.NotFound();
    db.Budgets.Remove(budget);
    await db.SaveChangesAsync();
    return Results.NoContent();
});
app.MapGet("/api/v1/analytics/tools", async (TelemetryDb db, int? days) => {
    var windowDays = days is 1 or 7 or 30 or 90 ? days : null;
    var cutoff = windowDays.HasValue ? DateTime.UtcNow.AddDays(-windowDays.Value) : (DateTime?)null;
    var query = from span in db.Spans.AsNoTracking()
                join session in db.Sessions.AsNoTracking() on span.SessionId equals session.Id
                where span.Kind == "execute_tool" && (!cutoff.HasValue || span.StartedAt >= cutoff.Value)
                select new { span.Name, span.Status, span.DurationMs, span.StartedAt, SessionId = session.Id, session.Title, session.Project, session.Model };
    var rows = await query.ToListAsync();
    var tools = rows.GroupBy(row => row.Name)
        .OrderByDescending(group => group.Count())
        .ThenBy(group => group.Key)
        .Select(group => {
            var durations = group.Where(row => row.DurationMs.HasValue).Select(row => row.DurationMs!.Value).ToArray();
            var sessions = group.GroupBy(row => row.SessionId)
                .Select(session => session.OrderByDescending(row => row.StartedAt).First())
                .OrderByDescending(row => row.StartedAt).Take(5)
                .Select(row => new { sessionId = row.SessionId, title = row.Title, project = row.Project, model = row.Model });
            var errors = group.Count(row => row.Status == "error" || row.Status == "failed");
            return new { name = group.Key, callCount = group.Count(), errorCount = errors, errorRate = group.Count() == 0 ? 0d : (double)errors / group.Count(), sessionCount = group.Select(row => row.SessionId).Distinct().Count(), averageDurationMs = durations.Length == 0 ? (double?)null : durations.Average(), latestSessions = sessions };
        }).ToArray();
    return Results.Ok(new { windowDays, totalCalls = rows.Count, errorCount = rows.Count(row => row.Status == "error" || row.Status == "failed"), tools });
});
app.MapGet("/api/v1/analytics/models", async (TelemetryDb db, DateTimeOffset? from, DateTimeOffset? to, string? source, string? model, string? bucket) => {
    var bucketType = bucket is "week" or "month" ? bucket : "day";
    var start = from?.UtcDateTime;
    var end = to?.UtcDateTime;
    var query = from span in db.Spans.AsNoTracking()
                join session in db.Sessions.AsNoTracking() on span.SessionId equals session.Id
                where span.Kind == "inference"
                select new { Model = span.Name, Source = session.Source, span.Status, span.StartedAt, span.InputTokens, span.OutputTokens, span.ReasoningTokens, span.CacheReadTokens, span.CacheWriteTokens, span.Cost, span.QuotaCostEstimate };
    if (start.HasValue) query = query.Where(row => row.StartedAt >= start.Value);
    if (end.HasValue) query = query.Where(row => row.StartedAt <= end.Value);
    var allRows = await query.ToListAsync();
    var availableSources = allRows.Select(row => row.Source).Distinct().Order().ToArray();
    var availableModels = allRows.Select(row => row.Model).Distinct().Order().ToArray();
    var rows = allRows.Where(row => (string.IsNullOrWhiteSpace(source) || row.Source == source) && (string.IsNullOrWhiteSpace(model) || row.Model == model)).ToArray();
    long inputTokens = rows.Sum(row => (long)row.InputTokens);
    long outputTokens = rows.Sum(row => (long)row.OutputTokens);
    long cacheReadTokens = rows.Sum(row => (long)row.CacheReadTokens);
    long cacheWriteTokens = rows.Sum(row => (long)row.CacheWriteTokens);
    long reasoningTokens = rows.Sum(row => (long)row.ReasoningTokens);
    long totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    var costRows = rows.Where(row => row.Cost.HasValue).ToArray();
    var quotaRows = rows.Where(row => row.QuotaCostEstimate.HasValue).ToArray();
    DateTime BucketDate(DateTime date) => bucketType switch {
        "week" => date.Date.AddDays(-(((int)date.DayOfWeek + 6) % 7)),
        "month" => new DateTime(date.Year, date.Month, 1, 0, 0, 0, DateTimeKind.Utc),
        _ => date.Date,
    };
    var trend = rows.GroupBy(row => BucketDate(row.StartedAt)).OrderBy(group => group.Key).Select(group => new {
        period = group.Key,
        inputTokens = group.Sum(row => (long)row.InputTokens),
        outputTokens = group.Sum(row => (long)row.OutputTokens),
        cacheReadTokens = group.Sum(row => (long)row.CacheReadTokens),
        cacheWriteTokens = group.Sum(row => (long)row.CacheWriteTokens),
        totalTokens = group.Sum(row => (long)row.InputTokens + row.OutputTokens + row.CacheReadTokens + row.CacheWriteTokens),
    }).ToArray();
    var agents = rows.GroupBy(row => row.Source).OrderByDescending(group => group.Sum(row => (long)row.InputTokens + row.OutputTokens + row.CacheReadTokens + row.CacheWriteTokens)).Select(group => {
        var tokens = group.Sum(row => (long)row.InputTokens + row.OutputTokens + row.CacheReadTokens + row.CacheWriteTokens);
        return new { name = group.Key, calls = group.Count(), tokens, share = totalTokens == 0 ? 0d : (double)tokens / totalTokens };
    }).ToArray();
    var models = rows.GroupBy(row => row.Model).OrderByDescending(group => group.Sum(row => (long)row.InputTokens + row.OutputTokens + row.CacheReadTokens + row.CacheWriteTokens)).Select(group => {
        var tokens = group.Sum(row => (long)row.InputTokens + row.OutputTokens + row.CacheReadTokens + row.CacheWriteTokens);
        var costs = group.Where(row => row.Cost.HasValue).ToArray();
        var quotas = group.Where(row => row.QuotaCostEstimate.HasValue).ToArray();
        return new { name = group.Key, calls = group.Count(), inputTokens = group.Sum(row => (long)row.InputTokens), outputTokens = group.Sum(row => (long)row.OutputTokens), cacheReadTokens = group.Sum(row => (long)row.CacheReadTokens), cacheWriteTokens = group.Sum(row => (long)row.CacheWriteTokens), tokens, share = totalTokens == 0 ? 0d : (double)tokens / totalTokens, reportedCost = costs.Length == 0 ? (double?)null : costs.Sum(row => row.Cost!.Value), quotaEstimate = quotas.Length == 0 ? (double?)null : quotas.Sum(row => row.QuotaCostEstimate!.Value), errorCount = group.Count(row => row.Status == "error" || row.Status == "failed") };
    }).ToArray();
    return Results.Ok(new {
        bucket = bucketType, availableSources, availableModels,
        totals = new { calls = rows.Length, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, cacheEfficiency = inputTokens + cacheReadTokens == 0 ? (double?)null : (double)cacheReadTokens / (inputTokens + cacheReadTokens), reportedCost = costRows.Length == 0 ? (double?)null : costRows.Sum(row => row.Cost!.Value), quotaEstimate = quotaRows.Length == 0 ? (double?)null : quotaRows.Sum(row => row.QuotaCostEstimate!.Value), errorCount = rows.Count(row => row.Status == "error" || row.Status == "failed") },
        trend, agents, models,
    });
});
app.MapGet("/api/v1/behavior", async (TelemetryDb db, int? days) => {
    var windowDays = days is 7 or 30 or 90 ? days : null;
    var cutoff = windowDays.HasValue ? DateTime.UtcNow.AddDays(-windowDays.Value) : (DateTime?)null;
    var sessionsQuery = db.Sessions.AsNoTracking();
    if (cutoff.HasValue) sessionsQuery = sessionsQuery.Where(s => s.StartedAt >= cutoff.Value);
    var sessions = await sessionsQuery.ToListAsync();
    var ids = sessions.Select(s => s.Id).ToList();
    var spans = ids.Count == 0 ? new List<Span>() : await db.Spans.AsNoTracking().Where(s => ids.Contains(s.SessionId)).ToListAsync();
    var bySession = spans.GroupBy(s => s.SessionId).ToDictionary(g => g.Key, g => g.OrderBy(s => s.StartedAt).ToList());
    var rows = new List<BehaviorSessionDto>();
    foreach (var session in sessions) {
        var sessionSpans = bySession.GetValueOrDefault(session.Id) ?? new List<Span>();
        var toolSpans = sessionSpans.Where(s => s.Kind == "execute_tool").ToList();
        var modelSpans = sessionSpans.Where(s => s.Kind == "inference").ToList();
        var signals = new List<BehaviorSignalDto>();
        var currentRuns = new Dictionary<string,int>();
        var maxRuns = new Dictionary<string,int>();
        string? previous = null;
        foreach (var span in toolSpans) {
            currentRuns[span.Name] = previous == span.Name ? currentRuns.GetValueOrDefault(span.Name) + 1 : 1;
            maxRuns[span.Name] = Math.Max(maxRuns.GetValueOrDefault(span.Name), currentRuns[span.Name]);
            previous = span.Name;
        }
        foreach (var group in toolSpans.GroupBy(s => s.Name)) {
            var calls = group.Count();
            var errors = group.Count(s => s.Status is "error" or "failed");
            var maxConsecutive = maxRuns.GetValueOrDefault(group.Key);
            if (calls >= 4 || maxConsecutive >= 3)
                signals.Add(new BehaviorSignalDto("tool_loop", "warning", $"Bucle de herramienta: {group.Key}", $"{group.Key} se llamó {calls} veces; {errors} fallaron y la racha máxima fue {maxConsecutive}.", new { tool = group.Key, calls, maxConsecutive, errors }));
        }
        var toolErrors = toolSpans.Count(s => s.Status is "error" or "failed");
        var modelErrors = modelSpans.Count(s => s.Status is "error" or "failed");
        if (toolErrors >= 3 || modelErrors >= 2)
            signals.Add(new BehaviorSignalDto("error_burst", "alert", "Ráfaga de errores", $"Se registraron {toolErrors} errores de herramientas y {modelErrors} de modelo.", new { toolErrors, modelErrors }));
        if (modelSpans.Count >= 20 || sessionSpans.Count >= 30)
            signals.Add(new BehaviorSignalDto("long_session", "warning", "Sesión larga", $"La sesión tiene {modelSpans.Count} pasos de modelo y {sessionSpans.Count} spans.", new { modelSteps = modelSpans.Count, spans = sessionSpans.Count }));
        if (session.Status == "interrupted")
            signals.Add(new BehaviorSignalDto("interrupted", "alert", "Sesión interrumpida", "La ejecución quedó interrumpida.", new { endedAt = session.EndedAt }));
        if (signals.Count == 0) continue;
        rows.Add(new BehaviorSessionDto(session.Id, session.Title, session.Project, session.Model, session.Status, session.StartedAt, session.UpdatedAt, signals.OrderBy(s => s.Severity == "alert" ? 0 : 1).ThenBy(s => s.Kind).ToArray()));
    }
    var ordered = rows.OrderByDescending(r => r.Signals.Length).ThenByDescending(r => r.UpdatedAt).ToArray();
    return Results.Ok(new { windowDays, totals = new { sessions = sessions.Count, flaggedSessions = ordered.Length, signals = ordered.Sum(r => r.Signals.Length) }, sessions = ordered });
});
app.MapPost("/api/v1/telemetry/events", async (HttpRequest request, TelemetryEventDto dto, TelemetryDb db, IConfiguration config, IHubContext<TelemetryHub> hub) => {
    var key = config["Telemetry:ApiKey"]!;
    if (!CryptographicEquals(request.Headers["X-Telemetry-Key"].ToString(), key)) return Results.Unauthorized();
    if (string.IsNullOrWhiteSpace(dto.EventId) || dto.EventId.Length > 200 || string.IsNullOrWhiteSpace(dto.Source) || dto.Source.Length > 80 || string.IsNullOrWhiteSpace(dto.SessionId) || dto.SessionId.Length > 200 || string.IsNullOrWhiteSpace(dto.Type) || dto.Type.Length > 120 || dto.Timestamp == default || dto.DurationMs < 0 || dto.InputTokens < 0 || dto.OutputTokens < 0 || dto.ReasoningTokens < 0 || dto.CacheReadTokens < 0 || dto.CacheWriteTokens < 0 || dto.Cost is < 0 || dto.Cost is double cost && !double.IsFinite(cost) || dto.QuotaCostEstimate is < 0 || dto.QuotaCostEstimate is double estimate && !double.IsFinite(estimate)) return Results.BadRequest(new { error = "Required fields are missing or exceed supported limits" });
    await ingestLock.WaitAsync();
    try {
        var existing = await db.Events.AnyAsync(e => e.Source == dto.Source && e.EventId == dto.EventId);
        if (existing) return Results.Ok(new { accepted = true, duplicate = true });
        var session = await db.Sessions.FindAsync(dto.SessionId);
        if (session is null) { session = new Session { Id = dto.SessionId, Source = dto.Source, Project = Safe(dto.Project, 120), StartedAt = dto.Timestamp.UtcDateTime }; db.Sessions.Add(session); }
        session.UpdatedAt = DateTime.UtcNow;
        if (dto.Timestamp.UtcDateTime < session.StartedAt) session.StartedAt = dto.Timestamp.UtcDateTime;
        var eventTime = dto.Timestamp.UtcDateTime;
        if (dto.Type is "session.idle" or "session.execution.succeeded" or "session.error") {
            var newerActivity = await db.Events.AnyAsync(e =>
                e.SessionId == dto.SessionId && e.Timestamp > eventTime &&
                (e.Type == "session.execution.started" || e.Type == "session.idle" ||
                 e.Type == "session.execution.succeeded" || e.Type == "session.error"));
            var isCurrent = !session.EndedAt.HasValue || eventTime > session.EndedAt.Value;
            if (!newerActivity && isCurrent) {
                var next = dto.Type == "session.error"
                    ? "error"
                    : dto.Type == "session.idle" && dto.Status == "interrupted" ? "interrupted" : "completed";
                if (dto.Type == "session.idle" && session.Status == "interrupted" && next == "completed") next = "interrupted";
                session.Status = next;
                session.EndedAt = eventTime;
            }
        }
        if (dto.Type == "session.execution.started") {
            var newerTerminal = await db.Events.AnyAsync(e =>
                e.SessionId == dto.SessionId && e.Timestamp > eventTime &&
                (e.Type == "session.idle" || e.Type == "session.execution.succeeded" || e.Type == "session.error"));
            if (!newerTerminal && (!session.EndedAt.HasValue || eventTime > session.EndedAt.Value)) {
                session.Status = "active";
                session.EndedAt = null;
            }
        }
        if (!string.IsNullOrWhiteSpace(dto.Model)) session.Model = Safe(dto.Model, 120);
        if (dto.Type == "session.title.updated" && !string.IsNullOrWhiteSpace(dto.Title)) session.Title = Safe(dto.Title, 200);
        var attrs = SafeAttributes(dto.Attributes);
        var ev = new TelemetryEvent { EventId = dto.EventId, Source = dto.Source, SessionId = dto.SessionId, Timestamp = dto.Timestamp.UtcDateTime, Type = dto.Type, Status = dto.Status, DurationMs = dto.DurationMs, Model = Safe(dto.Model, 120), InputTokens = dto.InputTokens, OutputTokens = dto.OutputTokens, ReasoningTokens = dto.ReasoningTokens, CacheReadTokens = dto.CacheReadTokens, CacheWriteTokens = dto.CacheWriteTokens, Cost = dto.Cost, QuotaCostEstimate = dto.QuotaCostEstimate, AttributesJson = JsonSerializer.Serialize(attrs) };
        db.Events.Add(ev);
        if (dto.Type.StartsWith("tool.")) db.Spans.Add(new Span { Id = SpanId(dto.Source, dto.EventId), SessionId = dto.SessionId, ParentId = ParentSpanId(dto.Source, dto.ParentId), Name = Safe(dto.Name ?? "tool", 160) ?? "tool", Kind = "execute_tool", Status = dto.Status ?? "ok", StartedAt = dto.Timestamp.UtcDateTime, DurationMs = dto.DurationMs, AttributesJson = JsonSerializer.Serialize(attrs) });
        else if (dto.Type.StartsWith("model.")) db.Spans.Add(new Span { Id = SpanId(dto.Source, dto.EventId), SessionId = dto.SessionId, ParentId = ParentSpanId(dto.Source, dto.ParentId), Name = Safe(dto.Name ?? dto.Model ?? "model", 160) ?? "model", Kind = "inference", Status = dto.Status ?? "ok", StartedAt = dto.Timestamp.UtcDateTime, DurationMs = dto.DurationMs, InputTokens = dto.InputTokens, OutputTokens = dto.OutputTokens, ReasoningTokens = dto.ReasoningTokens, CacheReadTokens = dto.CacheReadTokens, CacheWriteTokens = dto.CacheWriteTokens, Cost = dto.Cost, QuotaCostEstimate = dto.QuotaCostEstimate, AttributesJson = JsonSerializer.Serialize(attrs) });
        try { await db.SaveChangesAsync(); }
        catch (DbUpdateException e) when (e.InnerException is SqliteException { SqliteErrorCode: 19, SqliteExtendedErrorCode: 2067 })
        {
            return Results.Ok(new { accepted = true, duplicate = true });
        }
    }
    finally { ingestLock.Release(); }
    await hub.Clients.All.SendAsync("telemetry.updated", new { sessionId = dto.SessionId, eventId = dto.EventId, type = dto.Type });
    return Results.Ok(new { accepted = true, duplicate = false });
});
app.MapGet("/api/v1/sessions", async (TelemetryDb db, string? status, string? model, bool? error, DateTimeOffset? from, DateTimeOffset? to, int? page, int? pageSize) => {
    var q = db.Sessions.AsNoTracking().AsQueryable();
    if (!string.IsNullOrWhiteSpace(status)) q = q.Where(s => s.Status == status);
    if (!string.IsNullOrWhiteSpace(model)) q = q.Where(s => s.Model != null && s.Model.Contains(model));
    if (error == true) q = q.Where(s => s.Status == "error");
    var fromUtc = from?.UtcDateTime; var toUtc = to?.UtcDateTime;
    if (fromUtc.HasValue) q = q.Where(s => s.StartedAt >= fromUtc.Value); if (toUtc.HasValue) q = q.Where(s => s.StartedAt <= toUtc.Value);
    var total = await q.CountAsync(); var p = Math.Max(1,page ?? 1); var size = Math.Clamp(pageSize ?? 30,1,100);
    var rows = await q.OrderByDescending(s => s.UpdatedAt).Skip((p-1)*size).Take(size).Select(s => new { s.Id,s.Source,s.Project,s.Title,s.Status,s.Model,s.StartedAt,s.EndedAt,s.UpdatedAt, SpanCount=db.Spans.Count(x=>x.SessionId==s.Id), ErrorCount=db.Events.Count(x=>x.SessionId==s.Id && x.Status=="error"), InputTokens=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(long?)x.InputTokens)??0, OutputTokens=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(long?)x.OutputTokens)??0, Cost=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(double?)x.Cost), QuotaCostEstimate=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(double?)x.QuotaCostEstimate) }).ToListAsync();
    return Results.Ok(new { items=rows,total,page=p,pageSize=size });
});
app.MapGet("/api/v1/sessions/{id}", async (string id, TelemetryDb db) => {
    var s=await db.Sessions.AsNoTracking().FirstOrDefaultAsync(x=>x.Id==id); if(s is null)return Results.NotFound();
    var events=await db.Events.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.Timestamp).ToListAsync(); var spans=await db.Spans.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.StartedAt).ToListAsync();
    return Results.Ok(new { session=s, spans, events, metrics=new { spanCount=spans.Count,errorCount=events.Count(x=>x.Status=="error"),inputTokens=spans.Sum(x=>x.InputTokens),outputTokens=spans.Sum(x=>x.OutputTokens),reasoningTokens=spans.Sum(x=>x.ReasoningTokens),cacheReadTokens=spans.Sum(x=>x.CacheReadTokens),cacheWriteTokens=spans.Sum(x=>x.CacheWriteTokens),cost=spans.Where(x=>x.Cost.HasValue).Sum(x=>x.Cost),quotaCostEstimate=spans.Where(x=>x.QuotaCostEstimate.HasValue).Sum(x=>x.QuotaCostEstimate),durationMs=s.EndedAt.HasValue?(long?)(s.EndedAt.Value-s.StartedAt).TotalMilliseconds:null } });
});
app.MapGet("/api/v1/traces/{id}", async (string id, TelemetryDb db) => { var s=await db.Sessions.AsNoTracking().FirstOrDefaultAsync(x=>x.Id==id); if(s is null)return Results.NotFound(); var spans=await db.Spans.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.StartedAt).ToListAsync(); var events=await db.Events.AsNoTracking().Where(x=>x.SessionId==id && !x.Type.StartsWith("tool.") && !x.Type.StartsWith("model.")).OrderBy(x=>x.Timestamp).ToListAsync(); return Results.Ok(new { traceId=s.Id,session=s,spans,unrelatedEvents=events }); });
app.Run();

static bool CryptographicEquals(string a,string b) { var x=System.Text.Encoding.UTF8.GetBytes(a);var y=System.Text.Encoding.UTF8.GetBytes(b);return x.Length==y.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(x,y); }
static async Task EnsureSessionTitleColumnAsync(TelemetryDb db) { var exists=false; await db.Database.OpenConnectionAsync(); try { await using var command=db.Database.GetDbConnection().CreateCommand(); command.CommandText="PRAGMA table_info('Sessions')"; await using var reader=await command.ExecuteReaderAsync(); while(await reader.ReadAsync()) if(reader.GetString(1)=="Title") exists=true; } finally { await db.Database.CloseConnectionAsync(); } if(!exists) await db.Database.ExecuteSqlRawAsync("ALTER TABLE Sessions ADD COLUMN Title TEXT NULL"); }
static async Task EnsureSessionReviewColumnsAsync(TelemetryDb db) { foreach (var (name, sql) in new[] { ("Rating", "ALTER TABLE Sessions ADD COLUMN Rating INTEGER NULL"), ("ReviewNote", "ALTER TABLE Sessions ADD COLUMN ReviewNote TEXT NULL"), ("ReviewTask", "ALTER TABLE Sessions ADD COLUMN ReviewTask TEXT NULL") }) { var exists=false; await db.Database.OpenConnectionAsync(); try { await using var command=db.Database.GetDbConnection().CreateCommand(); command.CommandText="PRAGMA table_info('Sessions')"; await using var reader=await command.ExecuteReaderAsync(); while(await reader.ReadAsync()) if(reader.GetString(1)==name) exists=true; } finally { await db.Database.CloseConnectionAsync(); } if(!exists) await db.Database.ExecuteSqlRawAsync(sql); } }
static async Task EnsureColumnAsync(TelemetryDb db, string table, string column, string definition) { var tableName=table switch { "Events"=>"Events", "Spans"=>"Spans", _=>throw new ArgumentOutOfRangeException(nameof(table)) }; var columnName=column switch { "Cost"=>"Cost", "ReasoningTokens"=>"ReasoningTokens", "CacheReadTokens"=>"CacheReadTokens", "CacheWriteTokens"=>"CacheWriteTokens", "QuotaCostEstimate"=>"QuotaCostEstimate", _=>throw new ArgumentOutOfRangeException(nameof(column)) }; var alterQuery=(tableName,columnName,definition) switch { ("Events","Cost","REAL NULL")=>"ALTER TABLE Events ADD COLUMN Cost REAL NULL", ("Spans","Cost","REAL NULL")=>"ALTER TABLE Spans ADD COLUMN Cost REAL NULL", ("Events","ReasoningTokens","INTEGER NOT NULL DEFAULT 0")=>"ALTER TABLE Events ADD COLUMN ReasoningTokens INTEGER NOT NULL DEFAULT 0", ("Spans","ReasoningTokens","INTEGER NOT NULL DEFAULT 0")=>"ALTER TABLE Spans ADD COLUMN ReasoningTokens INTEGER NOT NULL DEFAULT 0", ("Events","CacheReadTokens","INTEGER NOT NULL DEFAULT 0")=>"ALTER TABLE Events ADD COLUMN CacheReadTokens INTEGER NOT NULL DEFAULT 0", ("Spans","CacheReadTokens","INTEGER NOT NULL DEFAULT 0")=>"ALTER TABLE Spans ADD COLUMN CacheReadTokens INTEGER NOT NULL DEFAULT 0", ("Events","CacheWriteTokens","INTEGER NOT NULL DEFAULT 0")=>"ALTER TABLE Events ADD COLUMN CacheWriteTokens INTEGER NOT NULL DEFAULT 0", ("Spans","CacheWriteTokens","INTEGER NOT NULL DEFAULT 0")=>"ALTER TABLE Spans ADD COLUMN CacheWriteTokens INTEGER NOT NULL DEFAULT 0", ("Events","QuotaCostEstimate","REAL NULL")=>"ALTER TABLE Events ADD COLUMN QuotaCostEstimate REAL NULL", ("Spans","QuotaCostEstimate","REAL NULL")=>"ALTER TABLE Spans ADD COLUMN QuotaCostEstimate REAL NULL", _=>throw new ArgumentOutOfRangeException(nameof(column)) }; var exists=false; await db.Database.OpenConnectionAsync(); try { await using var command=db.Database.GetDbConnection().CreateCommand(); command.CommandText=$"PRAGMA table_info('{tableName}')"; await using var reader=await command.ExecuteReaderAsync(); while(await reader.ReadAsync()) if(reader.GetString(1)==columnName) exists=true; } finally { await db.Database.CloseConnectionAsync(); } if(!exists) await db.Database.ExecuteSqlRawAsync(alterQuery); }
static string SpanId(string source,string eventId) => $"{source}:{eventId}";
static string? ParentSpanId(string source,string? parentId) => string.IsNullOrWhiteSpace(parentId) ? null : SpanId(source,parentId);
static string? Safe(string? s,int max) => string.IsNullOrWhiteSpace(s)?null:s[..Math.Min(s.Length,max)];
static Dictionary<string,string> SafeAttributes(Dictionary<string,string>? input) { var result=new Dictionary<string,string>(); if(input is null)return result; var blocked=new[]{"prompt","response","content","output","arguments","args","command","file","path","body","secret","token","api_key","key"}; foreach(var kv in input.Take(32)) { var k=kv.Key.ToLowerInvariant(); if(blocked.Any(k.Contains)) continue; result[Safe(kv.Key,100)!]=Safe(kv.Value,500)??""; } return result; }
record TelemetryEventDto(string EventId,string Source,string SessionId,DateTimeOffset Timestamp,string Type,string? Project=null,string? Status=null,long? DurationMs=null,string? Model=null,int InputTokens=0,int OutputTokens=0,string? ParentId=null,string? Name=null,Dictionary<string,string>? Attributes=null,double? Cost=null,int ReasoningTokens=0,int CacheReadTokens=0,int CacheWriteTokens=0,double? QuotaCostEstimate=null,string? Title=null);
record SessionReviewDto(int? Rating, string? Note, string? TaskLabel);
record ComparisonRunDto(string Id, string? Title, string? Project, string? Model, string Status, int? Rating, string? Note, string TaskLabel, DateTime UpdatedAt, long DurationMs, int InputTokens, int OutputTokens, double? Cost, double? QuotaCostEstimate, string[] Tools);
record BudgetDto(string? Project, double MonthlyLimit, string Metric);
record BehaviorSignalDto(string Kind, string Severity, string Title, string Explanation, object Evidence);
record BehaviorSessionDto(string Id, string? Title, string? Project, string? Model, string Status, DateTime StartedAt, DateTime UpdatedAt, BehaviorSignalDto[] Signals);
class TelemetryDb(DbContextOptions<TelemetryDb> options):DbContext(options) { public DbSet<Session> Sessions=>Set<Session>();public DbSet<TelemetryEvent> Events=>Set<TelemetryEvent>();public DbSet<Span> Spans=>Set<Span>();public DbSet<Budget> Budgets=>Set<Budget>(); protected override void OnModelCreating(ModelBuilder b){var utc=new ValueConverter<DateTime,DateTime>(v=>DateTime.SpecifyKind(v,DateTimeKind.Utc),v=>DateTime.SpecifyKind(v,DateTimeKind.Utc));var utcNullable=new ValueConverter<DateTime?,DateTime?>(v=>v.HasValue?DateTime.SpecifyKind(v.Value,DateTimeKind.Utc):null,v=>v.HasValue?DateTime.SpecifyKind(v.Value,DateTimeKind.Utc):null);b.Entity<TelemetryEvent>().HasIndex(x=>new{x.Source,x.EventId});b.Entity<TelemetryEvent>().Property(x=>x.Timestamp).HasConversion(utc);b.Entity<Session>().HasKey(x=>x.Id);b.Entity<Session>().Property(x=>x.StartedAt).HasConversion(utc);b.Entity<Session>().Property(x=>x.EndedAt).HasConversion(utcNullable);b.Entity<Session>().Property(x=>x.UpdatedAt).HasConversion(utc);b.Entity<Span>().HasKey(x=>x.Id);b.Entity<Span>().Property(x=>x.StartedAt).HasConversion(utc);b.Entity<Budget>().HasKey(x=>x.Project);} }
class Session { public string Id{get;set;}="";public string Source{get;set;}="";public string? Project{get;set;} public string? Title{get;set;} public int? Rating{get;set;} public string? ReviewNote{get;set;} public string? ReviewTask{get;set;} public string Status{get;set;}="active";public string? Model{get;set;}public DateTime StartedAt{get;set;}public DateTime? EndedAt{get;set;}public DateTime UpdatedAt{get;set;} }
class Budget { public string Project{get;set;}="";public double MonthlyLimit{get;set;}public string Metric{get;set;}="cost"; }
class TelemetryEvent { public long Id{get;set;}public string EventId{get;set;}="";public string Source{get;set;}="";public string SessionId{get;set;}="";public DateTime Timestamp{get;set;}public string Type{get;set;}="";public string? Status{get;set;}public long? DurationMs{get;set;}public string? Model{get;set;}public int InputTokens{get;set;}public int OutputTokens{get;set;}public int ReasoningTokens{get;set;}public int CacheReadTokens{get;set;}public int CacheWriteTokens{get;set;}public double? Cost{get;set;}public double? QuotaCostEstimate{get;set;}public string AttributesJson{get;set;}="{}"; }
class Span { public string Id{get;set;}="";public string SessionId{get;set;}="";public string? ParentId{get;set;}public string Name{get;set;}="";public string Kind{get;set;}="";public string Status{get;set;}="ok";public DateTime StartedAt{get;set;}public long? DurationMs{get;set;}public int InputTokens{get;set;}public int OutputTokens{get;set;}public int ReasoningTokens{get;set;}public int CacheReadTokens{get;set;}public int CacheWriteTokens{get;set;}public double? Cost{get;set;}public double? QuotaCostEstimate{get;set;}public string AttributesJson{get;set;}="{}"; }
class TelemetryHub:Hub { }
public partial class Program { }
