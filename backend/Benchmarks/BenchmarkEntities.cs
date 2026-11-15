public sealed class BenchmarkRunEntity
{
    public string Id { get; set; } = "";
    public string Suite { get; set; } = "";
    public string JudgeModel { get; set; } = "";
    public string Status { get; set; } = "queued";
    public int Total { get; set; }
    public int Completed { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public string? BaselineJson { get; set; }
    public string? Error { get; set; }
}

public sealed class BenchmarkResultEntity
{
    public string Id { get; set; } = "";
    public string RunId { get; set; } = "";
    public string TestName { get; set; } = "";
    public string TestType { get; set; } = "";
    public string Model { get; set; } = "";
    public string Status { get; set; } = "pending";
    public bool? VerifyPassed { get; set; }
    public int? VerifyExitCode { get; set; }
    public string? SessionId { get; set; }
    public string? JudgeSessionId { get; set; }
    public long? DurationMs { get; set; }
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public int CacheReadTokens { get; set; }
    public int CacheWriteTokens { get; set; }
    public double? Cost { get; set; }
    public double? QuotaCostEstimate { get; set; }
    public int? JudgeScore { get; set; }
    public string? JudgeRationale { get; set; }
    public string? MetricsError { get; set; }
    public string? Error { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}
