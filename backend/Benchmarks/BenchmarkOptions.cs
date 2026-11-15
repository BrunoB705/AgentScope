public sealed class BenchmarkOptions
{
    public string Root { get; set; } = "";
    public string OpenCodeCommand { get; set; } = "opencode";
    public int JudgeTimeoutMs { get; set; } = 120_000;
    public int TelemetryWaitMs { get; set; } = 15_000;
    public string TelemetryUrl { get; set; } = "http://127.0.0.1:5080";
    public string? WorkingRoot { get; set; }
}
