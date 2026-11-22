using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);
// La presencia de Telemetry:ApiKey se valida tras builder.Build() para respetar fuentes de configuración en tests.
builder.Services.AddDbContext<TelemetryDb>(o => o.UseSqlite(builder.Configuration.GetConnectionString("Telemetry") ?? "Data Source=telemetry.db"));
builder.Services.AddSignalR();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));
var benchmarkContentRoot = builder.Environment.ContentRootPath;
builder.Services.Configure<BenchmarkOptions>(builder.Configuration.GetSection("Benchmarks"));
builder.Services.AddSingleton<IProcessRunner, ProcessRunner>();
builder.Services.AddSingleton(sp =>
{
    var options = sp.GetRequiredService<IOptions<BenchmarkOptions>>().Value;
    var root = string.IsNullOrWhiteSpace(options.Root) ? Path.Combine(benchmarkContentRoot, "benchmarks") : options.Root;
    return new BenchmarkCatalog(root);
});
builder.Services.AddSingleton(sp =>
{
    var options = sp.GetRequiredService<IOptions<BenchmarkOptions>>().Value;
    return new ModelCatalog(sp.GetRequiredService<IProcessRunner>(), options.OpenCodeCommand);
});
builder.Services.AddSingleton<BenchmarkQueue>();
builder.Services.AddSingleton<BenchmarkCancellationRegistry>();
builder.Services.AddScoped<BenchmarkExecutor>();
builder.Services.AddSingleton<IBenchmarkSessionReader, BenchmarkSessionReader>();
builder.Services.AddSingleton<IBenchmarkNotifier, SignalRBenchmarkNotifier>();
if (builder.Configuration.GetValue("Benchmarks:WorkerEnabled", true))
    builder.Services.AddHostedService<BenchmarkWorker>();
var app = builder.Build();
var surfaceKey = app.Configuration["Telemetry:ApiKey"];
if (string.IsNullOrWhiteSpace(surfaceKey)) throw new InvalidOperationException("Telemetry:ApiKey must be set through environment configuration.");
using (var scope = app.Services.CreateScope()) {
    var db = scope.ServiceProvider.GetRequiredService<TelemetryDb>();
    await SchemaMigrator.ApplyAsync(db);
    await BenchmarkStorage.EnsureAsync(db);
    await BenchmarkStorage.MarkStaleAsync(db);
    var retentionDays = app.Configuration.GetValue<int?>("Telemetry:RetentionDays");
    if (retentionDays is > 0)
        await PurgeSessionsBeforeAsync(db, DateTime.UtcNow.AddDays(-retentionDays.Value), dryRun: false);
}
app.UseCors();
// Toda la superficie de lectura exige la misma clave que la ingesta; sólo el health
// check queda público porque start.ps1 lo usa para saber si la API ya está lista.
// surfaceKey validado arriba al construir la app.
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    var isApiSurface = path.StartsWithSegments("/api") || path.StartsWithSegments("/hubs");
    if (!isApiSurface || path.StartsWithSegments("/api/v1/health"))
    {
        await next();
        return;
    }
    if (!CryptographicEquals(context.Request.Headers["X-Telemetry-Key"].ToString(), surfaceKey))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new { error = "The X-Telemetry-Key header is missing or does not match.", code = "telemetry_key_missing" });
        return;
    }
    await next();
});
app.MapHub<TelemetryHub>("/hubs/telemetry");
const int TelemetryProtocolVersion = 1;
app.MapGet("/api/v1/health", async (TelemetryDb db, IConfiguration config) =>
{
    try
    {
        if (!await db.Database.CanConnectAsync())
            return Results.Json(new { status = "error", database = "unreachable" }, statusCode: StatusCodes.Status503ServiceUnavailable);
        var version = await SchemaMigrator.CurrentVersionAsync(db);
        var migrations = version >= SchemaMigrator.LatestVersion ? "current" : "pending";
        var workerEnabled = config.GetValue("Benchmarks:WorkerEnabled", true);
        return Results.Ok(new
        {
            status = "ok",
            database = "ok",
            schemaVersion = version,
            migrations,
            benchmarkWorker = workerEnabled ? "running" : "disabled",
            protocolVersion = TelemetryProtocolVersion,
        });
    }
    catch (Exception ex)
    {
        return Results.Json(new { status = "error", database = "error", detail = ex.Message }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});
app.MapGet("/api/v1/version", async (TelemetryDb db, IConfiguration config) =>
{
    var schemaVersion = await SchemaMigrator.CurrentVersionAsync(db);
    return Results.Ok(new
    {
        apiVersion = "1.0.0",
        protocolVersion = TelemetryProtocolVersion,
        schemaVersion,
        latestSchemaVersion = SchemaMigrator.LatestVersion,
        benchmarkWorker = config.GetValue("Benchmarks:WorkerEnabled", true) ? "running" : "disabled",
    });
});
var ingestLock = new SemaphoreSlim(1, 1);
app.MapPut("/api/v1/sessions/{id}/review", async (string id, SessionReviewDto dto, TelemetryDb db, IHubContext<TelemetryHub> hub) => {
    if (dto.Rating is < 1 or > 5 || dto.Note?.Length > 2000 || dto.TaskLabel?.Length > 120) return Results.BadRequest(new { error = "The rating must be from 1 to 5, the task cannot exceed 120 characters and the note cannot exceed 2000.", code = "rating_invalid" });
    IResult response;
    await ingestLock.WaitAsync();
    try {
        var session = await db.Sessions.FindAsync(id);
        if (session is null) return Results.NotFound();
        session.Rating = dto.Rating;
        session.ReviewNote = string.IsNullOrWhiteSpace(dto.Note) ? null : dto.Note.Trim();
        session.ReviewTask = NormalizeTaskLabel(dto.TaskLabel);
        await db.SaveChangesAsync();
        response = Results.Ok(new { rating = session.Rating, note = session.ReviewNote, taskLabel = session.ReviewTask });
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
        return new ComparisonRunDto(session.Id, session.Title, session.Project, session.Model, session.Status, session.Rating, session.ReviewNote, session.ReviewTask!, session.UpdatedAt, Math.Max(0, (long)elapsed.TotalMilliseconds), SumOrNull(sessionSpans, span => span.InputTokens), SumOrNull(sessionSpans, span => span.OutputTokens), sessionSpans.Any(span => span.Cost.HasValue) ? sessionSpans.Where(span => span.Cost.HasValue).Sum(span => span.Cost!.Value) : null, sessionSpans.Any(span => span.QuotaCostEstimate.HasValue) ? sessionSpans.Where(span => span.QuotaCostEstimate.HasValue).Sum(span => span.QuotaCostEstimate!.Value) : null, sessionSpans.Where(span => span.Kind == "execute_tool").Select(span => span.Name).Distinct().Order().ToArray());
    }).ToList();
    var groups = runs.GroupBy(run => NormalizeTaskLabel(run.TaskLabel) ?? run.TaskLabel.Trim(), StringComparer.OrdinalIgnoreCase).OrderBy(group => group.Key).Select(group => new { taskLabel = group.Key, sessions = group.OrderByDescending(run => run.UpdatedAt).ToArray() });
    return Results.Ok(groups);
});
app.MapGet("/api/v1/budgets", async (TelemetryDb db) => {
    var start = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1, 0, 0, 0, DateTimeKind.Utc);
    var budgets = await db.Budgets.AsNoTracking().OrderBy(x => x.Project).ToListAsync();
    var rows = new List<object>();
    foreach (var budget in budgets) {
        var usage = db.Spans.AsNoTracking()
            .Join(db.Sessions.AsNoTracking().Where(s => s.Project == budget.Project), span => span.SessionId, session => session.Id, (span, session) => span)
            .Where(span => span.Kind == "inference" && span.StartedAt >= start);
        var totalSpans = await usage.CountAsync();
        var measuredSpans = budget.Metric == "quota"
            ? await usage.CountAsync(s => s.QuotaCostEstimate != null)
            : await usage.CountAsync(s => s.Cost != null);
        var spent = measuredSpans == 0
            ? (double?)null
            : budget.Metric == "quota"
                ? await usage.SumAsync(s => (double?)s.QuotaCostEstimate)
                : await usage.SumAsync(s => (double?)s.Cost);
        var isPartial = totalSpans > 0 && measuredSpans < totalSpans;
        rows.Add(new { project = budget.Project, monthlyLimit = budget.MonthlyLimit, metric = budget.Metric, spent, periodStart = start, percentage = spent.HasValue ? spent.Value / budget.MonthlyLimit * 100 : (double?)null, totalSpans, measuredSpans, isPartial });




    }
    return Results.Ok(rows);
});
app.MapPut("/api/v1/budgets", async (BudgetDto dto, TelemetryDb db) => {
    var project = Safe(dto.Project?.Trim(), 120);
    if (string.IsNullOrWhiteSpace(project) || !double.IsFinite(dto.MonthlyLimit) || dto.MonthlyLimit <= 0 || dto.MonthlyLimit > 1_000_000 || dto.Metric is not ("cost" or "quota")) return Results.BadRequest(new { error = "Provide a project, a valid monthly limit and a metric of cost or quota.", code = "budget_invalid" });
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
app.MapGet("/api/v1/analytics/tools", async (TelemetryDb db, int? days, string? scope) => {
    var windowDays = days is 1 or 7 or 30 or 90 ? days : null;
    var cutoff = windowDays.HasValue ? DateTime.UtcNow.AddDays(-windowDays.Value) : (DateTime?)null;
    var query = from span in db.Spans.AsNoTracking()
                join session in ApplyScope(db.Sessions.AsNoTracking(), scope) on span.SessionId equals session.Id
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
app.MapGet("/api/v1/analytics/models", async (TelemetryDb db, DateTimeOffset? from, DateTimeOffset? to, string? source, string? model, string? bucket, string? scope) => {
    var bucketType = bucket is "week" or "month" ? bucket : "day";
    var start = from?.UtcDateTime;
    var end = to?.UtcDateTime;
    var query = from span in db.Spans.AsNoTracking()
                join session in ApplyScope(db.Sessions.AsNoTracking(), scope) on span.SessionId equals session.Id
                where span.Kind == "inference"
                select new { Model = span.Name, Source = session.Source, span.Status, span.StartedAt, span.DurationMs, span.SessionId, SessionStatus = session.Status, span.InputTokens, span.OutputTokens, span.ReasoningTokens, span.CacheReadTokens, span.CacheWriteTokens, span.Cost, span.QuotaCostEstimate };
    if (start.HasValue) query = query.Where(row => row.StartedAt >= start.Value);
    if (end.HasValue) query = query.Where(row => row.StartedAt <= end.Value);
    var allRows = await query.ToListAsync();
    var availableSources = allRows.Select(row => row.Source).Distinct().Order().ToArray();
    var availableModels = allRows.Select(row => row.Model).Distinct().Order().ToArray();
    var rows = allRows.Where(row => (string.IsNullOrWhiteSpace(source) || row.Source == source) && (string.IsNullOrWhiteSpace(model) || row.Model == model)).ToArray();
    long? inputTokens = SumOrNull(rows, row => row.InputTokens);
    long? outputTokens = SumOrNull(rows, row => row.OutputTokens);
    long? cacheReadTokens = SumOrNull(rows, row => row.CacheReadTokens);
    long? cacheWriteTokens = SumOrNull(rows, row => row.CacheWriteTokens);
    long? reasoningTokens = SumOrNull(rows, row => row.ReasoningTokens);
    long? totalTokens = TotalTokensOf(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
    double? cacheEfficiency = null;
    var cacheBase = (inputTokens ?? 0) + (cacheReadTokens ?? 0);
    if ((inputTokens.HasValue || cacheReadTokens.HasValue) && cacheBase > 0) cacheEfficiency = (double)(cacheReadTokens ?? 0) / cacheBase;
    var costRows = rows.Where(row => row.Cost.HasValue).ToArray();
    var quotaRows = rows.Where(row => row.QuotaCostEstimate.HasValue).ToArray();
    DateTime BucketDate(DateTime date) => bucketType switch {
        "week" => date.Date.AddDays(-(((int)date.DayOfWeek + 6) % 7)),
        "month" => new DateTime(date.Year, date.Month, 1, 0, 0, 0, DateTimeKind.Utc),
        _ => date.Date,
    };
    var trend = rows.GroupBy(row => BucketDate(row.StartedAt)).OrderBy(group => group.Key).Select(group => new {
        period = group.Key,
        inputTokens = SumOrNull(group, row => row.InputTokens),
        outputTokens = SumOrNull(group, row => row.OutputTokens),
        cacheReadTokens = SumOrNull(group, row => row.CacheReadTokens),
        cacheWriteTokens = SumOrNull(group, row => row.CacheWriteTokens),
        totalTokens = TotalTokensOf(SumOrNull(group, row => row.InputTokens), SumOrNull(group, row => row.OutputTokens), SumOrNull(group, row => row.CacheReadTokens), SumOrNull(group, row => row.CacheWriteTokens)),
    }).ToArray();
    var agents = rows.GroupBy(row => row.Source).OrderByDescending(group => TotalTokensOf(SumOrNull(group, row => row.InputTokens), SumOrNull(group, row => row.OutputTokens), SumOrNull(group, row => row.CacheReadTokens), SumOrNull(group, row => row.CacheWriteTokens)) ?? -1).Select(group => {
        var tokens = TotalTokensOf(SumOrNull(group, row => row.InputTokens), SumOrNull(group, row => row.OutputTokens), SumOrNull(group, row => row.CacheReadTokens), SumOrNull(group, row => row.CacheWriteTokens));
        return new { name = group.Key, calls = group.Count(), tokens, share = totalTokens is > 0 && tokens.HasValue ? (double?)tokens.Value / totalTokens.Value : null };
    }).ToArray();
    var benchmarksByModel = new Dictionary<string, (int Cases, double? PassRate, double? JudgeAvg)>(StringComparer.Ordinal);
    if (!string.Equals(scope, "real", StringComparison.OrdinalIgnoreCase))
    {
        var benchQuery = db.BenchmarkResults.AsNoTracking().Where(r => r.Status != "pending" && r.Status != "running");
        if (start.HasValue) benchQuery = benchQuery.Where(r => (r.CompletedAt ?? r.StartedAt) >= start.Value);
        if (end.HasValue) benchQuery = benchQuery.Where(r => (r.CompletedAt ?? r.StartedAt) <= end.Value);
        var benchRows = await benchQuery.Select(r => new { r.Model, r.VerifyPassed, r.JudgeScore }).ToListAsync();
        foreach (var bGroup in benchRows.GroupBy(r => r.Model))
        {
            var passed = bGroup.Where(r => r.VerifyPassed.HasValue).ToArray();
            var judges = bGroup.Where(r => r.JudgeScore.HasValue).ToArray();
            benchmarksByModel[bGroup.Key] = (
                bGroup.Count(),
                passed.Length == 0 ? null : (double)passed.Count(r => r.VerifyPassed!.Value) / passed.Length,
                judges.Length == 0 ? null : judges.Average(r => (double)r.JudgeScore!.Value));
        }
    }
    static double? Per1MTokens<T>(IEnumerable<T> items, Func<T, double?> amountOf, Func<T, long?> tokensOf)
    {
        double totalAmount = 0;
        long totalTok = 0;
        foreach (var item in items)
        {
            var amount = amountOf(item);
            var tok = tokensOf(item);
            if (!amount.HasValue || tok is not > 0) continue;
            totalAmount += amount.Value;
            totalTok += tok.Value;
        }
        return totalTok > 0 ? totalAmount / (totalTok / 1_000_000d) : null;
    }
    var models = rows.GroupBy(row => row.Model).OrderByDescending(group => TotalTokensOf(SumOrNull(group, row => row.InputTokens), SumOrNull(group, row => row.OutputTokens), SumOrNull(group, row => row.CacheReadTokens), SumOrNull(group, row => row.CacheWriteTokens)) ?? -1).Select(group => {
        var mIn = SumOrNull(group, row => row.InputTokens);
        var mOut = SumOrNull(group, row => row.OutputTokens);
        var mCacheR = SumOrNull(group, row => row.CacheReadTokens);
        var mCacheW = SumOrNull(group, row => row.CacheWriteTokens);
        var tokens = TotalTokensOf(mIn, mOut, mCacheR, mCacheW);
        var costs = group.Where(row => row.Cost.HasValue).ToArray();
        var quotas = group.Where(row => row.QuotaCostEstimate.HasValue).ToArray();
        var durations = group.Where(row => row.DurationMs is > 0).ToArray();
        var speedRows = group.Where(row => row.DurationMs is > 0 && row.OutputTokens.HasValue).ToArray();
        var mCacheBase = (mIn ?? 0) + (mCacheR ?? 0);
        var sessions = group.GroupBy(row => row.SessionId).Select(sg => sg.First().SessionStatus).ToArray();
        var errors = group.Count(row => row.Status == "error" || row.Status == "failed");
        var totalCalls = group.Count();
        benchmarksByModel.TryGetValue(group.Key, out var bench);
        return new {
            name = group.Key, calls = totalCalls, inputTokens = mIn, outputTokens = mOut, cacheReadTokens = mCacheR, cacheWriteTokens = mCacheW, tokens,
            share = totalTokens is > 0 && tokens.HasValue ? (double?)tokens.Value / totalTokens.Value : null,
            reportedCost = costs.Length == 0 ? (double?)null : costs.Sum(row => row.Cost!.Value),
            quotaEstimate = quotas.Length == 0 ? (double?)null : quotas.Sum(row => row.QuotaCostEstimate!.Value),
            errorCount = errors,
            averageDurationMs = durations.Length == 0 ? (double?)null : durations.Average(row => (double)row.DurationMs!.Value),
            outputTokensPerSec = speedRows.Length == 0 ? (double?)null : (double)speedRows.Sum(row => (long)row.OutputTokens!.Value) / (speedRows.Sum(row => row.DurationMs!.Value) / 1000d),
            cacheEfficiency = (mIn.HasValue || mCacheR.HasValue) && mCacheBase > 0 ? (double?)(mCacheR ?? 0) / mCacheBase : null,
            reportedCostPerCall = costs.Length == 0 ? (double?)null : costs.Average(row => row.Cost!.Value),
            reportedCostPer1MTokens = Per1MTokens(costs, r => r.Cost, r => TotalTokensOf(r.InputTokens, r.OutputTokens, r.CacheReadTokens, r.CacheWriteTokens)),
            quotaPerCall = quotas.Length == 0 ? (double?)null : quotas.Average(row => row.QuotaCostEstimate!.Value),
            quotaPer1MTokens = Per1MTokens(quotas, r => r.QuotaCostEstimate, r => TotalTokensOf(r.InputTokens, r.OutputTokens, r.CacheReadTokens, r.CacheWriteTokens)),
            sessionCount = sessions.Length,
            callSuccessRate = totalCalls == 0 ? 1d : (double)(totalCalls - errors) / totalCalls,
            completedSessionRate = sessions.Length == 0 ? (double?)null : (double)sessions.Count(st => st == "completed") / sessions.Length,
            benchmarkCases = bench.Cases,
            benchmarkPassRate = bench.PassRate,
            benchmarkJudgeAvg = bench.JudgeAvg,
        };
    }).ToArray();
    return Results.Ok(new {
        bucket = bucketType, availableSources, availableModels,
        totals = new { calls = rows.Length, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, cacheEfficiency, reportedCost = costRows.Length == 0 ? (double?)null : costRows.Sum(row => row.Cost!.Value), quotaEstimate = quotaRows.Length == 0 ? (double?)null : quotaRows.Sum(row => row.QuotaCostEstimate!.Value), errorCount = rows.Count(row => row.Status == "error" || row.Status == "failed") },
        trend, agents, models,
    });
});
app.MapGet("/api/v1/behavior", async (TelemetryDb db, int? days, string? scope) => {
    var windowDays = days is 1 or 7 or 30 or 90 ? days : null;
    var cutoff = windowDays.HasValue ? DateTime.UtcNow.AddDays(-windowDays.Value) : (DateTime?)null;
    var sessionsQuery = ApplyScope(db.Sessions.AsNoTracking(), scope);
    if (cutoff.HasValue) sessionsQuery = sessionsQuery.Where(s => s.StartedAt >= cutoff.Value);
    var sessions = await sessionsQuery.ToListAsync();
    var ids = sessions.Select(s => s.Id).ToList();
    var spans = ids.Count == 0
        ? Array.Empty<BehaviorSpanRow>()
        : await db.Spans.AsNoTracking()
            .Where(s => ids.Contains(s.SessionId))
            .Select(s => new BehaviorSpanRow(s.SessionId, s.Name, s.Kind, s.Status, s.StartedAt))
            .ToArrayAsync();
    var bySession = spans.GroupBy(s => s.SessionId).ToDictionary(g => g.Key, g => g.OrderBy(s => s.StartedAt).ToList());
    var rows = new List<BehaviorSessionDto>();
    foreach (var session in sessions) {
        var sessionSpans = bySession.GetValueOrDefault(session.Id) ?? new List<BehaviorSpanRow>();
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
app.MapGet("/api/v1/overview", async (TelemetryDb db, int? days, string? scope) => {
    var windowDays = days is 1 or 7 or 30 or 90 ? days : null;
    var cutoff = windowDays.HasValue ? DateTime.UtcNow.AddDays(-windowDays.Value) : (DateTime?)null;
    var sessionsQuery = ApplyScope(db.Sessions.AsNoTracking(), scope);
    if (cutoff.HasValue) sessionsQuery = sessionsQuery.Where(s => s.StartedAt >= cutoff.Value);
    var sessions = await sessionsQuery.ToListAsync();
    var ids = sessions.Select(s => s.Id).ToList();
    var spans = ids.Count == 0
        ? Array.Empty<OverviewSpanRow>()
        : await db.Spans.AsNoTracking()
            .Where(s => ids.Contains(s.SessionId))
            .Select(s => new OverviewSpanRow(s.SessionId, s.Name, s.Kind, s.Status, s.InputTokens, s.OutputTokens, s.ReasoningTokens, s.CacheReadTokens, s.CacheWriteTokens, s.Cost, s.QuotaCostEstimate))
            .ToArrayAsync();
    var active = sessions.Count(s => s.Status == "active");
    var completed = sessions.Count(s => s.Status == "completed");
    var error = sessions.Count(s => s.Status == "error");
    var interrupted = sessions.Count(s => s.Status == "interrupted");
    var finished = completed + error + interrupted;
    var finishedWithEnd = sessions.Where(s => s.EndedAt.HasValue && s.Status is "completed" or "error" or "interrupted").ToArray();
    var inference = spans.Where(s => s.Kind == "inference").ToArray();
    var toolSpans = spans.Where(s => s.Kind == "execute_tool").ToArray();
    long? inputTokens = SumOrNull(inference, s => s.InputTokens);
    long? outputTokens = SumOrNull(inference, s => s.OutputTokens);
    long? reasoningTokens = SumOrNull(inference, s => s.ReasoningTokens);
    long? cacheReadTokens = SumOrNull(inference, s => s.CacheReadTokens);
    long? cacheWriteTokens = SumOrNull(inference, s => s.CacheWriteTokens);
    var costRows = inference.Where(s => s.Cost.HasValue).ToArray();
    var quotaRows = inference.Where(s => s.QuotaCostEstimate.HasValue).ToArray();
    var totals = new OverviewTotalsDto(
        sessions.Count, active, completed, error, interrupted, finished,
        finished == 0 ? null : (double)completed / finished,
        finished == 0 ? null : (double)error / finished,
        finishedWithEnd.Length == 0 ? null : finishedWithEnd.Average(s => (s.EndedAt!.Value - s.StartedAt).TotalMilliseconds),
        inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens,
        TotalTokensOf(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
        costRows.Length == 0 ? null : costRows.Sum(s => s.Cost!.Value),
        quotaRows.Length == 0 ? null : quotaRows.Sum(s => s.QuotaCostEstimate!.Value));
    var topTools = toolSpans.GroupBy(s => s.Name)
        .Select(group => {
            var errors = group.Count(s => s.Status is "error" or "failed");
            var calls = group.Count();
            return new OverviewToolDto(group.Key, calls, errors, calls == 0 ? 0d : (double)errors / calls, group.Select(s => s.SessionId).Distinct().Count());
        })
        .OrderByDescending(tool => tool.Calls)
        .ThenBy(tool => tool.Name)
        .Take(5)
        .ToArray();
    var topModels = inference.GroupBy(s => s.Name)
        .Select(group => {
            var tokens = TotalTokensOf(SumOrNull(group, s => s.InputTokens), SumOrNull(group, s => s.OutputTokens), SumOrNull(group, s => s.CacheReadTokens), SumOrNull(group, s => s.CacheWriteTokens));
            var costs = group.Where(s => s.Cost.HasValue).ToArray();
            var quotas = group.Where(s => s.QuotaCostEstimate.HasValue).ToArray();
            return new OverviewModelDto(
                group.Key,
                group.Count(),
                tokens,
                costs.Length == 0 ? null : costs.Sum(s => s.Cost!.Value),
                quotas.Length == 0 ? null : quotas.Sum(s => s.QuotaCostEstimate!.Value),
                group.Count(s => s.Status is "error" or "failed"));
        })
        .OrderByDescending(model => model.TotalTokens)
        .ThenBy(model => model.Name)
        .Take(5)
        .ToArray();
    var recentSessions = sessions
        .OrderByDescending(s => s.UpdatedAt)
        .ThenByDescending(s => s.StartedAt)
        .Take(5)
        .Select(s => new OverviewSessionDto(s.Id, s.Title, s.Project, s.Model, s.Status, s.StartedAt, s.UpdatedAt))
        .ToArray();
    return Results.Ok(new { windowDays, totals, topTools, topModels, recentSessions });
});
app.MapPost("/api/v1/telemetry/events", async (HttpRequest request, TelemetryEventDto dto, TelemetryDb db, IConfiguration config, IHubContext<TelemetryHub> hub, ILoggerFactory loggerFactory) => {
    var key = config["Telemetry:ApiKey"]!;
    if (!CryptographicEquals(request.Headers["X-Telemetry-Key"].ToString(), key)) return Results.Unauthorized();
    request.HttpContext.Response.Headers["X-Telemetry-Protocol"] = TelemetryProtocolVersion.ToString();
    if ((request.Headers.TryGetValue("X-Telemetry-Protocol", out var rawHeader) && (!int.TryParse(rawHeader.ToString(), out var headerVersion) || headerVersion != TelemetryProtocolVersion))
        || (dto.ProtocolVersion.HasValue && dto.ProtocolVersion.Value != TelemetryProtocolVersion))
        return Results.Json(new { error = $"Unsupported protocol version. Expected {TelemetryProtocolVersion}.", code = "protocol_unsupported", expectedProtocolVersion = TelemetryProtocolVersion }, statusCode: StatusCodes.Status426UpgradeRequired);
    if (string.IsNullOrWhiteSpace(dto.EventId) || dto.EventId.Length > 200 || string.IsNullOrWhiteSpace(dto.Source) || dto.Source.Length > 80 || string.IsNullOrWhiteSpace(dto.SessionId) || dto.SessionId.Length > 200 || string.IsNullOrWhiteSpace(dto.Type) || dto.Type.Length > 120 || dto.Timestamp == default || dto.DurationMs < 0 || dto.InputTokens < 0 || dto.OutputTokens < 0 || dto.ReasoningTokens < 0 || dto.CacheReadTokens < 0 || dto.CacheWriteTokens < 0 || dto.Cost is < 0 || dto.Cost is double cost && !double.IsFinite(cost) || dto.QuotaCostEstimate is < 0 || dto.QuotaCostEstimate is double estimate && !double.IsFinite(estimate) || dto.QuotaCatalogFetchedAt?.Length > 40 || dto.QuotaRateSnapshot?.Length > 500 || dto.QuotaMissingReason?.Length > 40) return Results.BadRequest(new { error = "Required fields are missing or exceed supported limits", code = "ingest_invalid" });
    await ingestLock.WaitAsync();
    try {
        var existing = await db.Events.AnyAsync(e => e.Source == dto.Source && e.EventId == dto.EventId);
        if (existing) return Results.Ok(new { accepted = true, duplicate = true });
        var session = await db.Sessions.FindAsync(dto.SessionId);
        if (session is null) { session = new Session { Id = dto.SessionId, Source = dto.Source, Project = Safe(dto.Project, 120), StartedAt = dto.Timestamp.UtcDateTime }; db.Sessions.Add(session); }
        else if (!string.Equals(session.Source, dto.Source, StringComparison.Ordinal))
            // La sesión conserva el origen del primer evento; el evento guarda el suyo y el conflicto queda en el log y en quality.sourceConflictEvents.
            loggerFactory.CreateLogger("Telemetry").LogWarning("La sesión {SessionId} recibió un evento de origen {EventSource}, distinto del origen registrado {SessionSource}.", dto.SessionId, dto.Source, session.Source);
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
        if (!string.IsNullOrWhiteSpace(dto.Model) && (!session.ModelAt.HasValue || eventTime >= session.ModelAt.Value))
        {
            session.Model = Safe(dto.Model, 120);
            session.ModelAt = eventTime;
        }
        if (dto.Type == "session.title.updated" && !string.IsNullOrWhiteSpace(dto.Title) && (!session.TitleAt.HasValue || eventTime >= session.TitleAt.Value))
        {
            session.Title = Safe(dto.Title, 200);
            session.TitleAt = eventTime;
        }
        var attrs = SafeAttributes(dto.Attributes);
        var ev = new TelemetryEvent { EventId = dto.EventId, Source = dto.Source, SessionId = dto.SessionId, Timestamp = dto.Timestamp.UtcDateTime, Type = dto.Type, Status = dto.Status, DurationMs = dto.DurationMs, Model = Safe(dto.Model, 120), InputTokens = dto.InputTokens, OutputTokens = dto.OutputTokens, ReasoningTokens = dto.ReasoningTokens, CacheReadTokens = dto.CacheReadTokens, CacheWriteTokens = dto.CacheWriteTokens, Cost = dto.Cost, QuotaCostEstimate = dto.QuotaCostEstimate, QuotaCatalogFetchedAt = dto.QuotaCatalogFetchedAt, QuotaRateSnapshot = dto.QuotaRateSnapshot, QuotaMissingReason = dto.QuotaMissingReason, AttributesJson = JsonSerializer.Serialize(attrs) };
        db.Events.Add(ev);
        if (dto.Type.StartsWith("tool.")) db.Spans.Add(new Span { Id = SpanId(dto.Source, dto.EventId), SessionId = dto.SessionId, ParentId = ParentSpanId(dto.Source, dto.ParentId), Name = Safe(dto.Name ?? "tool", 160) ?? "tool", Kind = "execute_tool", Status = dto.Status ?? "ok", StartedAt = dto.Timestamp.UtcDateTime, DurationMs = dto.DurationMs, AttributesJson = JsonSerializer.Serialize(attrs) });
        else if (dto.Type.StartsWith("model.")) db.Spans.Add(new Span { Id = SpanId(dto.Source, dto.EventId), SessionId = dto.SessionId, ParentId = ParentSpanId(dto.Source, dto.ParentId), Name = Safe(dto.Name ?? dto.Model ?? "model", 160) ?? "model", Kind = "inference", Status = dto.Status ?? "ok", StartedAt = dto.Timestamp.UtcDateTime, DurationMs = dto.DurationMs, InputTokens = dto.InputTokens, OutputTokens = dto.OutputTokens, ReasoningTokens = dto.ReasoningTokens, CacheReadTokens = dto.CacheReadTokens, CacheWriteTokens = dto.CacheWriteTokens, Cost = dto.Cost, QuotaCostEstimate = dto.QuotaCostEstimate, QuotaCatalogFetchedAt = dto.QuotaCatalogFetchedAt, QuotaRateSnapshot = dto.QuotaRateSnapshot, QuotaMissingReason = dto.QuotaMissingReason, AttributesJson = JsonSerializer.Serialize(attrs) });
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
app.MapGet("/api/v1/sessions", async (TelemetryDb db, string? status, string? model, string? project, string? tool, string? search, bool? error, DateTimeOffset? from, DateTimeOffset? to, int? page, int? pageSize, string? scope) => {
    var q = ApplyScope(db.Sessions.AsNoTracking(), scope);
    if (!string.IsNullOrWhiteSpace(status)) q = q.Where(s => s.Status == status);
    if (!string.IsNullOrWhiteSpace(model)) q = q.Where(s => s.Model != null && s.Model.Contains(model));
    if (!string.IsNullOrWhiteSpace(project)) { var pFilter = project.Trim(); q = q.Where(s => s.Project != null && s.Project.Contains(pFilter)); }
    if (!string.IsNullOrWhiteSpace(tool)) { var tFilter = tool.Trim(); q = q.Where(s => db.Spans.Any(x => x.SessionId == s.Id && x.Kind == "execute_tool" && x.Name.Contains(tFilter))); }
    if (!string.IsNullOrWhiteSpace(search)) { var term = search.Trim(); q = q.Where(s => (s.Title != null && s.Title.Contains(term)) || (s.Project != null && s.Project.Contains(term))); }
    if (error == true) q = q.Where(s => s.Status == "error" || db.Events.Any(x => x.SessionId == s.Id && (x.Status == "error" || x.Status == "failed")) || db.Spans.Any(x => x.SessionId == s.Id && (x.Status == "error" || x.Status == "failed")));
    var fromUtc = from?.UtcDateTime; var toUtc = to?.UtcDateTime;
    if (fromUtc.HasValue) q = q.Where(s => s.StartedAt >= fromUtc.Value); if (toUtc.HasValue) q = q.Where(s => s.StartedAt <= toUtc.Value);
    var total = await q.CountAsync(); var p = Math.Max(1,page ?? 1); var size = Math.Clamp(pageSize ?? 30,1,100);
    var rows = await q.OrderByDescending(s => s.UpdatedAt).Skip((p-1)*size).Take(size).Select(s => new { s.Id,s.Source,s.Project,s.Title,s.Status,s.Model,s.StartedAt,s.EndedAt,s.UpdatedAt, SpanCount=db.Spans.Count(x=>x.SessionId==s.Id), ErrorCount=db.Events.Count(x=>x.SessionId==s.Id && x.Status=="error"), InputTokens=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(long?)x.InputTokens), OutputTokens=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(long?)x.OutputTokens), Cost=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(double?)x.Cost), QuotaCostEstimate=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(double?)x.QuotaCostEstimate) }).ToListAsync();
    return Results.Ok(new { items=rows,total,page=p,pageSize=size });
});
app.MapGet("/api/v1/sessions/{id}", async (string id, TelemetryDb db) => {
    var s=await db.Sessions.AsNoTracking().FirstOrDefaultAsync(x=>x.Id==id); if(s is null)return Results.NotFound();
    var events=await db.Events.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.Timestamp).ToListAsync(); var spans=await db.Spans.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.StartedAt).ToListAsync();
    var unrelatedEvents = events.Where(x => !x.Type.StartsWith("tool.", StringComparison.Ordinal) && !x.Type.StartsWith("model.", StringComparison.Ordinal)).ToArray();
    var inferenceIds = spans.Where(x => x.Kind == "inference").Select(x => x.Id).ToHashSet(StringComparer.Ordinal);
    var orphanToolSpans = spans.Count(x => x.Kind == "execute_tool" && (string.IsNullOrWhiteSpace(x.ParentId) || !inferenceIds.Contains(x.ParentId)));
    var missingDurationSpans = spans.Count(x => !x.DurationMs.HasValue);
    var missingTokenSpans = spans.Count(x => x.Kind == "inference" && !x.InputTokens.HasValue && !x.OutputTokens.HasValue);
    var unknownModelSpans = spans.Count(x => x.Kind == "inference" && x.Name == "model");
    var hasSessionCreated = events.Any(x => x.Type == "session.created");
    var sourceConflictEvents = events.Count(x => !string.Equals(x.Source, s.Source, StringComparison.Ordinal));
    var isComplete = hasSessionCreated && orphanToolSpans == 0 && missingDurationSpans == 0 && missingTokenSpans == 0 && unknownModelSpans == 0 && sourceConflictEvents == 0;
    return Results.Ok(new { session=s, spans, events, unrelatedEvents, quality=new { status=isComplete?"complete":"partial", hasSessionCreated, orphanToolSpans, missingDurationSpans, missingTokenSpans, unknownModelSpans, unrelatedEventCount=unrelatedEvents.Length, sourceConflictEvents }, metrics=new { spanCount=spans.Count,errorCount=events.Count(x=>x.Status=="error"),inputTokens=SumOrNull(spans, x => x.InputTokens),outputTokens=SumOrNull(spans, x => x.OutputTokens),reasoningTokens=SumOrNull(spans, x => x.ReasoningTokens),cacheReadTokens=SumOrNull(spans, x => x.CacheReadTokens),cacheWriteTokens=SumOrNull(spans, x => x.CacheWriteTokens),cost=spans.Where(x=>x.Cost.HasValue).Sum(x=>x.Cost),quotaCostEstimate=spans.Where(x=>x.QuotaCostEstimate.HasValue).Sum(x=>x.QuotaCostEstimate),durationMs=s.EndedAt.HasValue?(long?)(s.EndedAt.Value-s.StartedAt).TotalMilliseconds:null } });
});
app.MapGet("/api/v1/traces/{id}", async (string id, TelemetryDb db) => { var s=await db.Sessions.AsNoTracking().FirstOrDefaultAsync(x=>x.Id==id); if(s is null)return Results.NotFound(); var spans=await db.Spans.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.StartedAt).ToListAsync(); var events=await db.Events.AsNoTracking().Where(x=>x.SessionId==id && !x.Type.StartsWith("tool.") && !x.Type.StartsWith("model.")).OrderBy(x=>x.Timestamp).ToListAsync(); return Results.Ok(new { traceId=s.Id,session=s,spans,unrelatedEvents=events }); });
app.MapDelete("/api/v1/sessions/{id}", async (string id, TelemetryDb db, IHubContext<TelemetryHub> hub) => {
    await ingestLock.WaitAsync();
    try {
        if (!await db.Sessions.AsNoTracking().AnyAsync(s => s.Id == id))
            return Results.NotFound(new { error = "The session does not exist.", code = "session_not_found" });
        await using var transaction = await db.Database.BeginTransactionAsync();
        await db.Events.Where(e => e.SessionId == id).ExecuteDeleteAsync();
        await db.Spans.Where(s => s.SessionId == id).ExecuteDeleteAsync();
        await db.BenchmarkResults.Where(r => r.SessionId == id).ExecuteUpdateAsync(s => s.SetProperty(r => r.SessionId, (string?)null));
        await db.BenchmarkResults.Where(r => r.JudgeSessionId == id).ExecuteUpdateAsync(s => s.SetProperty(r => r.JudgeSessionId, (string?)null));
        await db.Sessions.Where(s => s.Id == id).ExecuteDeleteAsync();
        await transaction.CommitAsync();
    }
    finally { ingestLock.Release(); }
    await hub.Clients.All.SendAsync("telemetry.updated", new { sessionId = id, type = "session.deleted" });
    return Results.NoContent();
});
app.MapDelete("/api/v1/data", async (DateTimeOffset? before, bool? dryRun, TelemetryDb db, IHubContext<TelemetryHub> hub) => {
    if (!before.HasValue) return Results.BadRequest(new { error = "Provide the 'before' parameter with a valid ISO date.", code = "before_invalid" });
    PurgeResult result;
    await ingestLock.WaitAsync();
    try {
        result = await PurgeSessionsBeforeAsync(db, before.Value.UtcDateTime, dryRun ?? false);
    }
    finally { ingestLock.Release(); }
    if (!result.DryRun && result.Sessions > 0)
        await hub.Clients.All.SendAsync("telemetry.updated", new { type = "data.purged", sessions = result.Sessions });
    return Results.Ok(result);
});
var exportJsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
app.MapGet("/api/v1/export", async (TelemetryDb db, DateTimeOffset? from, DateTimeOffset? to, string? scope) => {
    var query = ApplyScope(db.Sessions.AsNoTracking(), scope);
    var fromUtc = from?.UtcDateTime;
    var toUtc = to?.UtcDateTime;
    if (fromUtc.HasValue) query = query.Where(s => s.StartedAt >= fromUtc.Value);
    if (toUtc.HasValue) query = query.Where(s => s.StartedAt <= toUtc.Value);
    var sessions = await query.OrderBy(s => s.StartedAt).ToListAsync();
    var ids = sessions.Select(s => s.Id).ToList();
    var spans = new List<Span>();
    var events = new List<TelemetryEvent>();
    foreach (var chunk in ids.Chunk(500))
    {
        spans.AddRange(await db.Spans.AsNoTracking().Where(s => chunk.Contains(s.SessionId)).OrderBy(s => s.StartedAt).ToListAsync());
        events.AddRange(await db.Events.AsNoTracking().Where(e => chunk.Contains(e.SessionId)).OrderBy(e => e.Timestamp).ToListAsync());
    }
    var spansBySession = spans.GroupBy(s => s.SessionId).ToDictionary(g => g.Key, g => g.Select(SanitizeSpanForExport).ToArray());
    var eventsBySession = events.GroupBy(e => e.SessionId).ToDictionary(g => g.Key, g => g.Select(SanitizeEventForExport).ToArray());
    var lines = sessions.Select(session => JsonSerializer.Serialize(new
    {
        session,
        spans = spansBySession.GetValueOrDefault(session.Id) ?? Array.Empty<Span>(),
        events = eventsBySession.GetValueOrDefault(session.Id) ?? Array.Empty<TelemetryEvent>(),
    }, exportJsonOptions)).ToArray();
    var ndjson = lines.Length == 0 ? "" : string.Join('\n', lines) + '\n';
    return Results.Text(ndjson, "application/x-ndjson");
});
BenchmarkEndpoints.Map(app);
app.Run();

static bool CryptographicEquals(string a,string b) { var x=System.Text.Encoding.UTF8.GetBytes(a);var y=System.Text.Encoding.UTF8.GetBytes(b);return x.Length==y.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(x,y); }
static IQueryable<Session> ApplyScope(IQueryable<Session> query, string? scope) => scope switch
{
    "real" => query.Where(s =>
        (s.Project == null || (s.Project != "benchmark" && s.Project != "benchmark-judge")) &&
        (s.Title == null || (!s.Title.StartsWith("bench/") && !s.Title.StartsWith("bench-judge/") && !s.Title.StartsWith("bench-verdict/")))),
    "benchmarks" => query.Where(s =>
        s.Project == "benchmark" || s.Project == "benchmark-judge" ||
        (s.Title != null && (s.Title.StartsWith("bench/") || s.Title.StartsWith("bench-judge/") || s.Title.StartsWith("bench-verdict/")))),
    _ => query,
};
static async Task<PurgeResult> PurgeSessionsBeforeAsync(TelemetryDb db, DateTime cutoffUtc, bool dryRun)
{
    var sessionIds = await db.Sessions.AsNoTracking()
        .Where(s => s.UpdatedAt < cutoffUtc)
        .Select(s => s.Id)
        .ToListAsync();
    if (sessionIds.Count == 0)
        return new(dryRun, cutoffUtc, 0, 0, 0);
    var spanCount = 0;
    var eventCount = 0;
    foreach (var chunk in sessionIds.Chunk(500))
    {
        spanCount += await db.Spans.AsNoTracking().CountAsync(s => chunk.Contains(s.SessionId));
        eventCount += await db.Events.AsNoTracking().CountAsync(e => chunk.Contains(e.SessionId));
    }
    if (!dryRun)
    {
        await using var transaction = await db.Database.BeginTransactionAsync();
        foreach (var chunk in sessionIds.Chunk(500))
        {
            await db.Events.Where(e => chunk.Contains(e.SessionId)).ExecuteDeleteAsync();
            await db.Spans.Where(s => chunk.Contains(s.SessionId)).ExecuteDeleteAsync();
            await db.BenchmarkResults.Where(r => r.SessionId != null && chunk.Contains(r.SessionId)).ExecuteUpdateAsync(s => s.SetProperty(r => r.SessionId, (string?)null));
            await db.BenchmarkResults.Where(r => r.JudgeSessionId != null && chunk.Contains(r.JudgeSessionId)).ExecuteUpdateAsync(s => s.SetProperty(r => r.JudgeSessionId, (string?)null));
            await db.Sessions.Where(s => chunk.Contains(s.Id)).ExecuteDeleteAsync();
        }
        await transaction.CommitAsync();
    }
    return new(dryRun, cutoffUtc, sessionIds.Count, spanCount, eventCount);
}
static string SanitizeAttributesJson(string raw)
{
    if (string.IsNullOrWhiteSpace(raw)) return "{}";
    try
    {
        var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(raw);
        return JsonSerializer.Serialize(SafeAttributes(parsed));
    }
    catch
    {
        return "{}";
    }
}
static Span SanitizeSpanForExport(Span s) => new()
{
    Id = s.Id, SessionId = s.SessionId, ParentId = s.ParentId, Name = s.Name, Kind = s.Kind, Status = s.Status,
    StartedAt = s.StartedAt, DurationMs = s.DurationMs, InputTokens = s.InputTokens, OutputTokens = s.OutputTokens,
    ReasoningTokens = s.ReasoningTokens, CacheReadTokens = s.CacheReadTokens, CacheWriteTokens = s.CacheWriteTokens,
    Cost = s.Cost, QuotaCostEstimate = s.QuotaCostEstimate, QuotaCatalogFetchedAt = s.QuotaCatalogFetchedAt,
    QuotaRateSnapshot = s.QuotaRateSnapshot, QuotaMissingReason = s.QuotaMissingReason,
    AttributesJson = SanitizeAttributesJson(s.AttributesJson),
};
static TelemetryEvent SanitizeEventForExport(TelemetryEvent e) => new()
{
    Id = e.Id, EventId = e.EventId, Source = e.Source, SessionId = e.SessionId, Timestamp = e.Timestamp,
    Type = e.Type, Status = e.Status, DurationMs = e.DurationMs, Model = e.Model,
    InputTokens = e.InputTokens, OutputTokens = e.OutputTokens, ReasoningTokens = e.ReasoningTokens,
    CacheReadTokens = e.CacheReadTokens, CacheWriteTokens = e.CacheWriteTokens,
    Cost = e.Cost, QuotaCostEstimate = e.QuotaCostEstimate, QuotaCatalogFetchedAt = e.QuotaCatalogFetchedAt,
    QuotaRateSnapshot = e.QuotaRateSnapshot, QuotaMissingReason = e.QuotaMissingReason,
    AttributesJson = SanitizeAttributesJson(e.AttributesJson),
};
static long? SumOrNull<T>(IEnumerable<T> rows, Func<T, int?> selector) =>
    rows.Any(row => selector(row).HasValue)
        ? rows.Sum(row => (long?)selector(row))
        : null;
static long? TotalTokensOf(long? input, long? output, long? cacheRead, long? cacheWrite) =>
    input is null && output is null && cacheRead is null && cacheWrite is null
        ? null
        : (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
static string SpanId(string source,string eventId) => $"{source}:{eventId}";
static string? ParentSpanId(string source,string? parentId) => string.IsNullOrWhiteSpace(parentId) ? null : SpanId(source,parentId);
static string? Safe(string? s,int max) => string.IsNullOrWhiteSpace(s)?null:s[..Math.Min(s.Length,max)];
static string? NormalizeTaskLabel(string? s)
{
    if (string.IsNullOrWhiteSpace(s)) return null;
    var collapsed = string.Join(' ', s.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    return Safe(collapsed, 120);
}
static Dictionary<string,string> SafeAttributes(Dictionary<string,string>? input) => AttributePolicy.Sanitize(input);
record TelemetryEventDto(string EventId,string Source,string SessionId,DateTimeOffset Timestamp,string Type,string? Project=null,string? Status=null,long? DurationMs=null,string? Model=null,int? InputTokens=null,int? OutputTokens=null,string? ParentId=null,string? Name=null,Dictionary<string,string>? Attributes=null,double? Cost=null,int? ReasoningTokens=null,int? CacheReadTokens=null,int? CacheWriteTokens=null,double? QuotaCostEstimate=null,string? Title=null,string? QuotaCatalogFetchedAt=null,string? QuotaRateSnapshot=null,string? QuotaMissingReason=null,int? ProtocolVersion=null);
record BehaviorSpanRow(string SessionId, string Name, string Kind, string Status, DateTime StartedAt);
record OverviewSpanRow(string SessionId, string Name, string Kind, string Status, int? InputTokens, int? OutputTokens, int? ReasoningTokens, int? CacheReadTokens, int? CacheWriteTokens, double? Cost, double? QuotaCostEstimate);
record SessionReviewDto(int? Rating, string? Note, string? TaskLabel);
record ComparisonRunDto(string Id, string? Title, string? Project, string? Model, string Status, int? Rating, string? Note, string TaskLabel, DateTime UpdatedAt, long DurationMs, long? InputTokens, long? OutputTokens, double? Cost, double? QuotaCostEstimate, string[] Tools);
record BudgetDto(string? Project, double MonthlyLimit, string Metric);
record PurgeResult(bool DryRun, DateTime Before, int Sessions, int Spans, int Events);
record OverviewTotalsDto(int Sessions, int Active, int Completed, int Error, int Interrupted, int Finished, double? SuccessRate, double? ErrorRate, double? AverageDurationMs, long? InputTokens, long? OutputTokens, long? ReasoningTokens, long? CacheReadTokens, long? CacheWriteTokens, long? TotalTokens, double? ReportedCost, double? QuotaEstimate);
record OverviewToolDto(string Name, int Calls, int Errors, double ErrorRate, int Sessions);
record OverviewModelDto(string Name, int Calls, long? TotalTokens, double? ReportedCost, double? QuotaEstimate, int Errors);
record OverviewSessionDto(string Id, string? Title, string? Project, string? Model, string Status, DateTime StartedAt, DateTime UpdatedAt);
record BehaviorSignalDto(string Kind, string Severity, string Title, string Explanation, object Evidence);
record BehaviorSessionDto(string Id, string? Title, string? Project, string? Model, string Status, DateTime StartedAt, DateTime UpdatedAt, BehaviorSignalDto[] Signals);
class TelemetryDb(DbContextOptions<TelemetryDb> options):DbContext(options) { public DbSet<Session> Sessions=>Set<Session>();public DbSet<TelemetryEvent> Events=>Set<TelemetryEvent>();public DbSet<Span> Spans=>Set<Span>();public DbSet<Budget> Budgets=>Set<Budget>();public DbSet<BenchmarkRunEntity> BenchmarkRuns=>Set<BenchmarkRunEntity>();public DbSet<BenchmarkResultEntity> BenchmarkResults=>Set<BenchmarkResultEntity>(); protected override void OnModelCreating(ModelBuilder b){var utc=new ValueConverter<DateTime,DateTime>(v=>DateTime.SpecifyKind(v,DateTimeKind.Utc),v=>DateTime.SpecifyKind(v,DateTimeKind.Utc));var utcNullable=new ValueConverter<DateTime?,DateTime?>(v=>v.HasValue?DateTime.SpecifyKind(v.Value,DateTimeKind.Utc):null,v=>v.HasValue?DateTime.SpecifyKind(v.Value,DateTimeKind.Utc):null);b.Entity<TelemetryEvent>().HasIndex(x=>new{x.Source,x.EventId});b.Entity<TelemetryEvent>().Property(x=>x.Timestamp).HasConversion(utc);b.Entity<Session>().HasKey(x=>x.Id);b.Entity<Session>().Property(x=>x.StartedAt).HasConversion(utc);b.Entity<Session>().Property(x=>x.EndedAt).HasConversion(utcNullable);b.Entity<Session>().Property(x=>x.TitleAt).HasConversion(utcNullable);b.Entity<Session>().Property(x=>x.ModelAt).HasConversion(utcNullable);b.Entity<Session>().Property(x=>x.UpdatedAt).HasConversion(utc);b.Entity<Span>().HasKey(x=>x.Id);b.Entity<Span>().Property(x=>x.StartedAt).HasConversion(utc);b.Entity<Budget>().HasKey(x=>x.Project);b.Entity<BenchmarkRunEntity>().HasKey(x=>x.Id);b.Entity<BenchmarkResultEntity>().HasKey(x=>x.Id);b.Entity<BenchmarkRunEntity>().Property(x=>x.Status).IsConcurrencyToken();b.Entity<BenchmarkRunEntity>().Property(x=>x.CreatedAt).HasConversion(utc);b.Entity<BenchmarkRunEntity>().Property(x=>x.StartedAt).HasConversion(utcNullable);b.Entity<BenchmarkRunEntity>().Property(x=>x.CompletedAt).HasConversion(utcNullable);b.Entity<BenchmarkResultEntity>().Property(x=>x.StartedAt).HasConversion(utcNullable);b.Entity<BenchmarkResultEntity>().Property(x=>x.CompletedAt).HasConversion(utcNullable);} }
class Session { public string Id{get;set;}="";public string Source{get;set;}="";public string? Project{get;set;} public string? Title{get;set;} public DateTime? TitleAt{get;set;} public DateTime? ModelAt{get;set;} public int? Rating{get;set;} public string? ReviewNote{get;set;} public string? ReviewTask{get;set;} public string Status{get;set;}="active";public string? Model{get;set;}public DateTime StartedAt{get;set;}public DateTime? EndedAt{get;set;}public DateTime UpdatedAt{get;set;} }
class Budget { public string Project{get;set;}="";public double MonthlyLimit{get;set;}public string Metric{get;set;}="cost"; }
class TelemetryEvent { public long Id{get;set;}public string EventId{get;set;}="";public string Source{get;set;}="";public string SessionId{get;set;}="";public DateTime Timestamp{get;set;}public string Type{get;set;}="";public string? Status{get;set;}public long? DurationMs{get;set;}public string? Model{get;set;}public int? InputTokens{get;set;}public int? OutputTokens{get;set;}public int? ReasoningTokens{get;set;}public int? CacheReadTokens{get;set;}public int? CacheWriteTokens{get;set;}public double? Cost{get;set;}public double? QuotaCostEstimate{get;set;}public string? QuotaCatalogFetchedAt{get;set;}public string? QuotaRateSnapshot{get;set;}public string? QuotaMissingReason{get;set;}public string AttributesJson{get;set;}="{}"; }
class Span { public string Id{get;set;}="";public string SessionId{get;set;}="";public string? ParentId{get;set;}public string Name{get;set;}="";public string Kind{get;set;}="";public string Status{get;set;}="ok";public DateTime StartedAt{get;set;}public long? DurationMs{get;set;}public int? InputTokens{get;set;}public int? OutputTokens{get;set;}public int? ReasoningTokens{get;set;}public int? CacheReadTokens{get;set;}public int? CacheWriteTokens{get;set;}public double? Cost{get;set;}public double? QuotaCostEstimate{get;set;}public string? QuotaCatalogFetchedAt{get;set;}public string? QuotaRateSnapshot{get;set;}public string? QuotaMissingReason{get;set;}public string AttributesJson{get;set;}="{}"; }
class TelemetryHub:Hub { }
public partial class Program { }
