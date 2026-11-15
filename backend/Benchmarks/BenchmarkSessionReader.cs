using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

public sealed record BenchmarkSessionMetrics(
    string SessionId,
    int InputTokens,
    int OutputTokens,
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
            var session = await db.Sessions.AsNoTracking().FirstOrDefaultAsync(item => item.Title == title, cancellationToken);
            if (session is not null)
            {
                await Task.Delay(500, cancellationToken);
                var spans = await db.Spans.AsNoTracking().Where(span => span.SessionId == session.Id).ToListAsync(cancellationToken);
                var cost = spans.Any(span => span.Cost.HasValue)
                    ? spans.Where(span => span.Cost.HasValue).Sum(span => span.Cost!.Value)
                    : (double?)null;
                var quota = spans.Any(span => span.QuotaCostEstimate.HasValue)
                    ? spans.Where(span => span.QuotaCostEstimate.HasValue).Sum(span => span.QuotaCostEstimate!.Value)
                    : (double?)null;
                return new(
                    session.Id,
                    spans.Sum(span => span.InputTokens),
                    spans.Sum(span => span.OutputTokens),
                    spans.Sum(span => span.CacheReadTokens),
                    spans.Sum(span => span.CacheWriteTokens),
                    cost,
                    quota);
            }
            await Task.Delay(250, cancellationToken);
        }
        return null;
    }
}
