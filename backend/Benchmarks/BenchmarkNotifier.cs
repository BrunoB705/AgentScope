using Microsoft.AspNetCore.SignalR;

public interface IBenchmarkNotifier
{
    Task UpdatedAsync(string runId, string status, CancellationToken cancellationToken);
}

internal sealed class SignalRBenchmarkNotifier : IBenchmarkNotifier
{
    private readonly IHubContext<TelemetryHub> _hub;

    public SignalRBenchmarkNotifier(IHubContext<TelemetryHub> hub) => _hub = hub;

    public Task UpdatedAsync(string runId, string status, CancellationToken cancellationToken) =>
        _hub.Clients.All.SendAsync("benchmark.updated", new { runId, status }, cancellationToken);
}
