using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

internal sealed class BenchmarkWorker : BackgroundService
{
    private readonly BenchmarkQueue _queue;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly BenchmarkCancellationRegistry _cancellation;
    private readonly ILogger<BenchmarkWorker> _logger;

    public BenchmarkWorker(
        BenchmarkQueue queue,
        IServiceScopeFactory scopeFactory,
        BenchmarkCancellationRegistry cancellation,
        ILogger<BenchmarkWorker> logger)
    {
        _queue = queue;
        _scopeFactory = scopeFactory;
        _cancellation = cancellation;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var runId in _queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var executor = scope.ServiceProvider.GetRequiredService<BenchmarkExecutor>();
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, _cancellation.Get(runId));
                await executor.ExecuteAsync(runId, linked.Token);
            }
            catch (OperationCanceledException)
            {
                // El ejecutor registra el estado cancelado antes de propagar.
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Falló la corrida de benchmark {RunId}", runId);
            }
            finally
            {
                _cancellation.Remove(runId);
            }
        }
    }
}
