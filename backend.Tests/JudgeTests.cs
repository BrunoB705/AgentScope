public sealed class JudgeTests
{
    [Fact]
    public void Build_IncludesPromptRubricAndArtifact()
    {
        var prompt = JudgePrompt.Build(
            "Corregí el bug.",
            new[] { "Claridad", "Correctitud" },
            "diff de prueba");
        Assert.Contains("Corregí el bug.", prompt);
        Assert.Contains("Claridad", prompt);
        Assert.Contains("Correctitud", prompt);
        Assert.Contains("diff de prueba", prompt);
    }

    [Fact]
    public void Build_AsksForStrictJson()
    {
        var prompt = JudgePrompt.Build("x", new[] { "y" }, "z");
        Assert.Contains("\"score\"", prompt);
        Assert.Contains("\"rationale\"", prompt);
        Assert.Contains("sólo", prompt, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Parse_ReturnsScoreAndRationale()
    {
        var result = JudgeResponse.Parse("""{"score":4,"rationale":"ok"}""");
        Assert.NotNull(result);
        Assert.Equal(4, result!.Score);
        Assert.Equal("ok", result.Rationale);
    }

    [Fact]
    public void Parse_ReturnsNull_OnInvalidJson()
    {
        Assert.Null(JudgeResponse.Parse("no json"));
    }

    [Fact]
    public void Parse_ReturnsNull_OnOutOfRange()
    {
        Assert.Null(JudgeResponse.Parse("""{"score":0,"rationale":"ok"}"""));
        Assert.Null(JudgeResponse.Parse("""{"score":6,"rationale":"ok"}"""));
    }

    [Fact]
    public void Parse_ReturnsNull_OnEmptyRationale()
    {
        Assert.Null(JudgeResponse.Parse("""{"score":4,"rationale":"   "}"""));
    }
}
