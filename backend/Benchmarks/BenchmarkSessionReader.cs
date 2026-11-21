using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

public sealed record BenchmarkSessionMetrics(
    string SessionId,
    int InputTokens,
    int OutputTokens,
    int ReasoningTokens,
    int CacheReadTokens,
    int CacheWriteTokens,
    double? Cost,
    double? QuotaCostEstimate);

public interface IBenchmarkSessionReader
{
    Task<BenchmarkSessionMetrics?> FindByTitleAsync(string title, TimeSpan timeout, CancellationToken cancellationToken);
}

public sealed class BenchmarkSessionReader : IBenchmarkSessionReader
{
    private readonly IServiceScopeFactory _scopeFactory;

    public BenchmarkSessionReader(IServiceScopeFactory scopeFactory) => _scopeFactory = scopeFactory;

    public async Task<BenchmarkSessionMetrics?> FindByTitleAsync(string title, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<TelemetryDb>();
            var session = await db.Sessions.AsNoTracking()
                .Where(item => item.Title == title)
                .OrderByDescending(item => item.Project == "benchmark")
                .FirstOrDefaultAsync(cancellationToken);
            if (session is not null)
            {
                var spans = await db.Spans.AsNoTracking()
                    .Where(span => span.SessionId == session.Id)
                    .ToListAsync(cancellationToken);
                var hasInference = spans.Any(span => span.Kind == "inference");
                var remaining = deadline - DateTime.UtcNow;
                if (!hasInference && remaining > TimeSpan.FromMilliseconds(250))
                {
                    await Task.Delay(250, cancellationToken);
                    continue;
                }

                if (remaining > TimeSpan.FromMilliseconds(150))
                {
                    await Task.Delay(150, cancellationToken);
                    spans = await db.Spans.AsNoTracking()
                        .Where(span => span.SessionId == session.Id)
                        .ToListAsync(cancellationToken);
                }

                var cost = spans.Any(span => span.Cost.HasValue)
                    ? spans.Where(span => span.Cost.HasValue).Sum(span => span.Cost!.Value)
                    : (double?)null;
                var quota = spans.Any(span => span.QuotaCostEstimate.HasValue)
                    ? spans.Where(span => span.QuotaCostEstimate.HasValue).Sum(span => span.QuotaCostEstimate!.Value)
                    : (double?)null;
                return new(
                    session.Id,
                    spans.Sum(span => span.InputTokens) ?? 0,
                    spans.Sum(span => span.OutputTokens) ?? 0,
                    spans.Sum(span => span.ReasoningTokens) ?? 0,
                    spans.Sum(span => span.CacheReadTokens) ?? 0,
                    spans.Sum(span => span.CacheWriteTokens) ?? 0,
                    cost,
                    quota);
            }
            await Task.Delay(250, cancellationToken);
        }
        return null;
    }
}
