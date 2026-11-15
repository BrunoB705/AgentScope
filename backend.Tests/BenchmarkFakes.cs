public sealed class FakeProcessRunner : IProcessRunner
{
    public Queue<ProcessResult> Results { get; } = new();
    public List<ProcessRequest> Requests { get; } = new();
    public Func<ProcessRequest, ProcessResult>? Handler { get; set; }
    public Func<ProcessRequest, CancellationToken, Task<ProcessResult>>? AsyncHandler { get; set; }

    public async Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        if (AsyncHandler is not null) return await AsyncHandler(request, cancellationToken);
        var result = Handler is not null
            ? Handler(request)
            : Results.Count > 0
                ? Results.Dequeue()
                : new ProcessResult(0, "", "", false, 0);
        return result;
    }
}

public sealed class FakeSessionReader : IBenchmarkSessionReader
{
    public BenchmarkSessionMetrics? Result { get; set; } = new("ses_model", 100, 50, 7, 20, 5, 0.001, 0.0005);

    public Task<BenchmarkSessionMetrics?> FindByTitleAsync(string title, TimeSpan timeout, CancellationToken cancellationToken) =>
        Task.FromResult(Result);
}

public sealed class FakeNotifier : IBenchmarkNotifier
{
    public List<(string RunId, string Status)> Calls { get; } = new();

    public Task UpdatedAsync(string runId, string status, CancellationToken cancellationToken)
    {
        Calls.Add((runId, status));
        return Task.CompletedTask;
    }
}
