using System.Collections.Concurrent;
using System.Threading.Channels;

public sealed class BenchmarkQueue
{
    private readonly Channel<string> _channel = Channel.CreateUnbounded<string>();

    public ValueTask EnqueueAsync(string runId, CancellationToken cancellationToken = default) =>
        _channel.Writer.WriteAsync(runId, cancellationToken);

    public IAsyncEnumerable<string> ReadAllAsync(CancellationToken cancellationToken) =>
        _channel.Reader.ReadAllAsync(cancellationToken);
}

public sealed class BenchmarkCancellationRegistry
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _sources = new();

    public CancellationToken Get(string runId) =>
        _sources.GetOrAdd(runId, _ => new CancellationTokenSource()).Token;

    public void Cancel(string runId)
    {
        var source = _sources.GetOrAdd(runId, _ => new CancellationTokenSource());
        try
        {
            source.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // La corrida ya terminó y el token se liberó.
        }
    }

    public void Remove(string runId) => _sources.TryRemove(runId, out _);
}
