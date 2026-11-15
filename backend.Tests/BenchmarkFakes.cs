public sealed class FakeProcessRunner : IProcessRunner
{
    public Queue<ProcessResult> Results { get; } = new();
    public List<ProcessRequest> Requests { get; } = new();
    public Func<ProcessRequest, ProcessResult>? Handler { get; set; }

    public Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        var result = Handler is not null
            ? Handler(request)
            : Results.Count > 0
                ? Results.Dequeue()
                : new ProcessResult(0, "", "", false, 0);
        return Task.FromResult(result);
    }
}
