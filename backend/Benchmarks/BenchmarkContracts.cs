public sealed record SuiteFile(
    string? Name,
    string? Description,
    string? DefaultJudge,
    int? ModelTimeoutMs,
    SuiteTestFile[]? Tests);

public sealed record SuiteTestFile(
    string? Name,
    string? Type,
    string? PromptFile,
    string? Fixture,
    VerifyFile? Verify,
    string[]? Rubric,
    bool? Judge);

public sealed record VerifyFile(string? Command, int? TimeoutMs);

public sealed record BenchmarkSuiteSummary(string Id, string Name, string? Description, string? DefaultJudge, int ModelTimeoutMs, BenchmarkTestSummary[] Tests);

public sealed record BenchmarkTestSummary(string Name, string Type, string[] Rubric, bool Judge);

public sealed record BenchmarkSuite(string Id, string Name, string? Description, string? DefaultJudge, int ModelTimeoutMs, BenchmarkTest[] Tests);

public sealed record BenchmarkTest(string Name, string Type, string Prompt, string? FixturePath, string? VerifyCommand, int VerifyTimeoutMs, string[] Rubric, bool Judge);

public sealed record BenchmarkCatalogList(BenchmarkSuiteSummary[] Suites, BenchmarkCatalogError[] Errors);

public sealed record BenchmarkCatalogError(string Id, string Error);

public sealed record CreateBenchmarkRunDto(string? Suite, string[]? Models, string? Judge);

public sealed class BenchmarkValidationException : Exception
{
    public BenchmarkValidationException(string message) : base(message) { }
}
