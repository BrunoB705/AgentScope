using System.Text.RegularExpressions;
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
            return Results.Ok(new { models = result.Models, error = result.Error, code = result.Code });
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
                return Results.BadRequest(new { error = "The suite is missing.", code = "suite_missing" });

            BenchmarkSuite suite;
            try
            {
                suite = catalog.Load(dto.Suite);
            }
            catch (BenchmarkValidationException ex)
            {
                return ex.Code == "suite_not_found"
                    ? Results.NotFound(new { error = ex.Message, code = ex.Code })
                    : Results.BadRequest(new { error = ex.Message, code = ex.Code });
            }

            var modelList = (dto.Models ?? Array.Empty<string>())
                .Select(model => model!.Trim())
                .Where(model => !string.IsNullOrWhiteSpace(model))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (modelList.Length == 0)
                return Results.BadRequest(new { error = "Choose at least one model.", code = "models_missing" });

            var judge = dto.Judge?.Trim();
            if (string.IsNullOrWhiteSpace(judge))
                return Results.BadRequest(new { error = "Choose a judge.", code = "judge_missing" });

            // El idioma de salida se fija al crear la corrida: el worker la ejecuta
            // después y no ve la pantalla. Sólo se aceptan los idiomas soportados.
            if (dto.Language is not (null or "es" or "en"))
                return Results.BadRequest(new { error = "Language must be 'es' or 'en'.", code = "invalid_language" });

            var specs = modelList.Select(model =>
            {
                var parts = model.Split('#', 2);
                return (Full: model, Base: parts[0], Variant: parts.Length == 2 ? parts[1] : null);
            }).ToArray();
            if (specs.Any(spec => string.IsNullOrWhiteSpace(spec.Base)
                || (spec.Variant is not null && !Regex.IsMatch(spec.Variant, "^[A-Za-z0-9][A-Za-z0-9-]*$"))))
                return Results.BadRequest(new { error = "Some model variant is invalid.", code = "variant_invalid" });
            if (specs.Any(spec => spec.Base == judge))
                return Results.BadRequest(new { error = "The judge cannot be one of the evaluated models.", code = "judge_is_model" });

            var available = await models.ListAsync(cancellationToken);
            if (available.Error is not null)
                return Results.Json(new { error = available.Error, code = available.Code ?? "model_catalog_unavailable" }, statusCode: StatusCodes.Status409Conflict);
            var catalogModels = new HashSet<string>(available.Models, StringComparer.Ordinal);
            if (!specs.All(spec => catalogModels.Contains(spec.Base)))
                return Results.BadRequest(new { error = "One of the models is not in the opencode catalog.", code = "model_not_in_catalog" });
            if (!catalogModels.Contains(judge))
                return Results.BadRequest(new { error = "The judge is not in the opencode catalog.", code = "judge_not_in_catalog" });

            var run = new BenchmarkRunEntity
            {
                Id = Guid.NewGuid().ToString("N"),
                Suite = suite.Id,
                JudgeModel = judge,
                Status = "queued",
                Total = modelList.Length * suite.Tests.Length,
                CreatedAt = DateTime.UtcNow,
                RequestVerdict = dto.RequestVerdict ?? true,
                OutputLanguage = dto.Language ?? "es",
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

        app.MapGet("/api/v1/benchmarks/runs", async (string? suite, int? page, int? pageSize, TelemetryDb db, CancellationToken cancellationToken) =>
        {
            var pageNumber = Math.Max(1, page ?? 1);
            var size = Math.Clamp(pageSize ?? 20, 1, 100);
            var query = db.BenchmarkRuns.AsNoTracking().AsQueryable();
            if (!string.IsNullOrWhiteSpace(suite)) query = query.Where(run => run.Suite == suite);
            var total = await query.CountAsync(cancellationToken);
            var runs = await query.OrderByDescending(run => run.CreatedAt)
                .Skip((pageNumber - 1) * size)
                .Take(size)
                .ToListAsync(cancellationToken);
            var ids = runs.Select(run => run.Id).ToArray();
            var results = await db.BenchmarkResults.AsNoTracking()
                .Where(result => ids.Contains(result.RunId))
                .ToListAsync(cancellationToken);
            return Results.Ok(new
            {
                items = runs.Select(run => ToDto(run, results.Where(result => result.RunId == run.Id))).ToArray(),
                total,
                page = pageNumber,
                pageSize = size,
            });
        });

        app.MapGet("/api/v1/benchmarks/runs/{id}", async (string id, TelemetryDb db, CancellationToken cancellationToken) =>
        {
            var run = await db.BenchmarkRuns.AsNoTracking().FirstOrDefaultAsync(item => item.Id == id, cancellationToken);
            if (run is null) return Results.NotFound(new { error = "The run does not exist.", code = "run_not_found" });
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
            if (run is null) return Results.NotFound(new { error = "The run does not exist.", code = "run_not_found" });
            if (run.Status is "completed" or "failed" or "cancelled")
                return Results.Conflict(new { error = "The run has already finished.", code = "run_finished" });

            run.Status = "cancelled";
            run.CompletedAt = DateTime.UtcNow;
            var pending = await db.BenchmarkResults.Where(item => item.RunId == id && item.Status == "pending").ToListAsync(cancellationToken);
            foreach (var result in pending) result.Status = "cancelled";
            try
            {
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateConcurrencyException)
            {
                return Results.Conflict(new { error = "The run finished while it was being cancelled.", code = "run_finished_while_cancelling" });
            }
            registry.Cancel(id);
            return Results.Json(new { status = "cancelled" }, statusCode: StatusCodes.Status202Accepted);
        });

        app.MapDelete("/api/v1/benchmarks/runs/{id}", async (string id, TelemetryDb db, CancellationToken cancellationToken) =>
        {
            var run = await db.BenchmarkRuns.AsNoTracking().FirstOrDefaultAsync(item => item.Id == id, cancellationToken);
            if (run is null) return Results.NotFound(new { error = "The run does not exist.", code = "run_not_found" });
            if (run.Status is "queued" or "running")
                return Results.Conflict(new { error = "Cancel the run before deleting it.", code = "cancel_before_delete" });

            var results = await db.BenchmarkResults.AsNoTracking()
                .Where(item => item.RunId == id)
                .ToListAsync(cancellationToken);
            var sessionIds = results
                .SelectMany(result => new[] { result.SessionId, result.JudgeSessionId })
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value!)
                .Distinct(StringComparer.Ordinal)
                .ToArray();

            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            if (sessionIds.Length > 0)
            {
                await db.Events.Where(item => sessionIds.Contains(item.SessionId)).ExecuteDeleteAsync(cancellationToken);
                await db.Spans.Where(item => sessionIds.Contains(item.SessionId)).ExecuteDeleteAsync(cancellationToken);
                await db.Sessions.Where(item => sessionIds.Contains(item.Id)).ExecuteDeleteAsync(cancellationToken);
            }
            await db.BenchmarkResults.Where(item => item.RunId == id).ExecuteDeleteAsync(cancellationToken);
            await db.BenchmarkRuns.Where(item => item.Id == id).ExecuteDeleteAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return Results.NoContent();
        });
    }

    private static object ToDto(BenchmarkRunEntity run, IEnumerable<BenchmarkResultEntity> results)
    {
        var error = BenchmarkErrorText.Read(run.Error);
        var verdict = BenchmarkErrorText.Read(run.Verdict);
        return new
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
            requestVerdict = run.RequestVerdict,
            language = run.OutputLanguage ?? "es",
            verdict = verdict.Error,
            verdictCode = verdict.Code,
            verdictParams = verdict.Parameters,
            error = error.Error,
            errorCode = error.Code,
            errorParams = error.Parameters,
            results = results.Select(result =>
            {
                var resultError = BenchmarkErrorText.Read(result.Error);
                var metricsError = BenchmarkErrorText.Read(result.MetricsError);
                return new
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
                    reasoningTokens = result.ReasoningTokens,
                    cacheReadTokens = result.CacheReadTokens,
                    cacheWriteTokens = result.CacheWriteTokens,
                    cost = result.Cost,
                    quotaCostEstimate = result.QuotaCostEstimate,
                    judgeScore = result.JudgeScore,
                    judgeRationale = result.JudgeRationale,
                    metricsError = metricsError.Error,
                    metricsErrorCode = metricsError.Code,
                    metricsErrorParams = metricsError.Parameters,
                    error = resultError.Error,
                    errorCode = resultError.Code,
                    errorParams = resultError.Parameters,
                };
            }).ToArray(),
        };
    }
}
