public sealed class OpenCodeOutputTests
{
    private static string Captured() =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "opencode-run.ndjson"));

    [Fact]
    public void ExtractFinalText_FromCapturedRun_ReturnsOk()
    {
        Assert.Equal("OK", OpenCodeOutput.ExtractFinalText(Captured()));
    }

    [Fact]
    public void ExtractSessionId_FromCapturedRun_ReturnsSessionId()
    {
        Assert.Equal("ses_test", OpenCodeOutput.ExtractSessionId(Captured()));
    }

    [Fact]
    public void ExtractFinalText_FromSingleJsonObject_ReturnsText()
    {
        Assert.Equal("hola", OpenCodeOutput.ExtractFinalText("""{"type":"text","part":{"type":"text","text":"hola"}}"""));
    }

    [Fact]
    public void ExtractFinalText_WithNoText_ReturnsNull()
    {
        var stdout = """
        {"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}
        {"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish"}}
        """;
        Assert.Null(OpenCodeOutput.ExtractFinalText(stdout));
    }

    [Fact]
    public void ExtractFinalText_IgnoresInvalidLines()
    {
        var stdout = """
        not json
        {"type":"text","part":{"type":"text","text":"después"}}
        """;
        Assert.Equal("después", OpenCodeOutput.ExtractFinalText(stdout));
    }

    [Fact]
    public void ExtractSessionId_FromSingleObject_ReturnsSessionId()
    {
        Assert.Equal("ses_1", OpenCodeOutput.ExtractSessionId("""{"sessionID":"ses_1","type":"step_finish"}"""));
    }
}
