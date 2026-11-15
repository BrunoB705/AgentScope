using Microsoft.EntityFrameworkCore;

public static class BenchmarkEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/v1/benchmarks/suites", (BenchmarkCatalog catalog) =>
        {
            var list = catalog.List();
            return Results.Ok(new { suites = list.Suites, errors = list.Errors });
        });

        app.MapGet("/api/v1/benchmarks/models", async (ModelCatalog models, CancellationToken cancellationToken) =>
        {
            var result = await models.ListAsync(cancellationToken);
            return Results.Ok(new { models = result.Models, error = result.Error });
        });

        app.MapPost("/api/v1/benchmarks/runs", async (
            CreateBenchmarkRunDto dto,
            BenchmarkCatalog catalog,
            ModelCatalog models,
            BenchmarkQueue queue,
            TelemetryDb db,
            CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(dto.Suite))
                return Results.BadRequest(new { error = "Falta la suite." });

            BenchmarkSuite suite;
            try
            {
                suite = catalog.Load(dto.Suite);
            }
            catch (BenchmarkValidationException ex)
            {
                return ex.Message.Contains("no existe", StringComparison.OrdinalIgnoreCase)
                    ? Results.NotFound(new { error = ex.Message })
                    : Results.BadRequest(new { error = ex.Message });
            }

            var modelList = (dto.Models ?? Array.Empty<string>())
                .Select(model => model!.Trim())
                .Where(model => !string.IsNullOrWhiteSpace(model))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (modelList.Length == 0)
                return Results.BadRequest(new { error = "Elegí al menos un modelo." });

            var judge = dto.Judge?.Trim();
            if (string.IsNullOrWhiteSpace(judge))
                return Results.BadRequest(new { error = "Elegí un juez." });
            if (modelList.Contains(judge, StringComparer.Ordinal))
                return Results.BadRequest(new { error = "El juez no puede ser uno de los modelos evaluados." });

            var available = await models.ListAsync(cancellationToken);
            if (available.Error is not null)
                return Results.Json(new { error = available.Error }, statusCode: StatusCodes.Status409Conflict);

            var run = new BenchmarkRunEntity
            {
                Id = Guid.NewGuid().ToString("N"),
                Suite = suite.Id,
                JudgeModel = judge,
                Status = "queued",
                Total = modelList.Length * suite.Tests.Length,
                CreatedAt = DateTime.UtcNow,
            };
            var results = new List<BenchmarkResultEntity>();
            foreach (var test in suite.Tests)
            {
                foreach (var model in modelList)
                {
                    results.Add(new BenchmarkResultEntity
                    {
                        Id = Guid.NewGuid().ToString("N"),
                        RunId = run.Id,
                        TestName = test.Name,
                        TestType = test.Type,
                        Model = model,
                        Status = "pending",
                    });
                }
            }

            db.BenchmarkRuns.Add(run);
            db.BenchmarkResults.AddRange(results);
            await db.SaveChangesAsync(cancellationToken);
            await queue.EnqueueAsync(run.Id, cancellationToken);
            return Results.Json(ToDto(run, results), statusCode: StatusCodes.Status202Accepted);
        });

        app.MapGet("/api/v1/benchmarks/runs", async (string? suite, TelemetryDb db, CancellationToken cancellationToken) =>
        {
            var query = db.BenchmarkRuns.AsNoTracking().AsQueryable();
            if (!string.IsNullOrWhiteSpace(suite)) query = query.Where(run => run.Suite == suite);
            var runs = await query.OrderByDescending(run => run.CreatedAt).ToListAsync(cancellationToken);
            var ids = runs.Select(run => run.Id).ToArray();
            var results = await db.BenchmarkResults.AsNoTracking()
                .Where(result => ids.Contains(result.RunId))
                .ToListAsync(cancellationToken);
            return Results.Ok(runs.Select(run => ToDto(run, results.Where(result => result.RunId == run.Id))).ToArray());
        });

        app.MapGet("/api/v1/benchmarks/runs/{id}", async (string id, TelemetryDb db, CancellationToken cancellationToken) =>
        {
            var run = await db.BenchmarkRuns.AsNoTracking().FirstOrDefaultAsync(item => item.Id == id, cancellationToken);
            if (run is null) return Results.NotFound(new { error = "La corrida no existe." });
            var results = await db.BenchmarkResults.AsNoTracking().Where(item => item.RunId == id).ToListAsync(cancellationToken);
            return Results.Ok(ToDto(run, results));
        });

        app.MapPost("/api/v1/benchmarks/runs/{id}/cancel", async (
            string id,
            TelemetryDb db,
            BenchmarkCancellationRegistry registry,
            CancellationToken cancellationToken) =>
        {
            var run = await db.BenchmarkRuns.FirstOrDefaultAsync(item => item.Id == id, cancellationToken);
            if (run is null) return Results.NotFound(new { error = "La corrida no existe." });
            if (run.Status is "completed" or "failed" or "cancelled")
                return Results.Conflict(new { error = "La corrida ya terminó." });

            run.Status = "cancelled";
            run.CompletedAt = DateTime.UtcNow;
            var pending = await db.BenchmarkResults.Where(item => item.RunId == id && item.Status == "pending").ToListAsync(cancellationToken);
            foreach (var result in pending) result.Status = "cancelled";
            await db.SaveChangesAsync(cancellationToken);
            registry.Cancel(id);
            return Results.Json(new { status = "cancelled" }, statusCode: StatusCodes.Status202Accepted);
        });
    }

    private static object ToDto(BenchmarkRunEntity run, IEnumerable<BenchmarkResultEntity> results) => new
    {
        id = run.Id,
        suite = run.Suite,
        judgeModel = run.JudgeModel,
        status = run.Status,
        total = run.Total,
        completed = run.Completed,
        createdAt = run.CreatedAt,
        startedAt = run.StartedAt,
        completedAt = run.CompletedAt,
        baselineJson = run.BaselineJson,
        error = run.Error,
        results = results.Select(result => new
        {
            id = result.Id,
            testName = result.TestName,
            testType = result.TestType,
            model = result.Model,
            status = result.Status,
            verifyPassed = result.VerifyPassed,
            verifyExitCode = result.VerifyExitCode,
            sessionId = result.SessionId,
            judgeSessionId = result.JudgeSessionId,
            durationMs = result.DurationMs,
            inputTokens = result.InputTokens,
            outputTokens = result.OutputTokens,
            cacheReadTokens = result.CacheReadTokens,
            cacheWriteTokens = result.CacheWriteTokens,
            cost = result.Cost,
            quotaCostEstimate = result.QuotaCostEstimate,
            judgeScore = result.JudgeScore,
            judgeRationale = result.JudgeRationale,
            metricsError = result.MetricsError,
            error = result.Error,
        }).ToArray(),
    };
}
