public sealed class VerdictTests
{
    [Fact]
    public void Extract_DropsTextOutsideMarkers()
    {
        var text = """
            Using using-superpowers to apply the required workflow; the attached benchmark explicitly overrides it.

            ---RECOMENDACION---
            Recomiendo el modelo A.
            ---FIN---

            Nota que no corresponde mostrar.
            """;

        Assert.Equal("Recomiendo el modelo A.", VerdictText.Extract(text));
    }

    [Fact]
    public void Extract_ReturnsWholeText_WhenMarkersAreMissing()
    {
        Assert.Equal("Recomiendo el modelo A.", VerdictText.Extract("  Recomiendo el modelo A.  "));
    }

    [Fact]
    public void Extract_ReturnsWholeText_WhenMarkersAreEmpty()
    {
        var text = "---RECOMENDACION---\n---FIN---";

        Assert.Equal(text, VerdictText.Extract(text));
    }

    [Fact]
    public void Build_AsksForMarkersAndNoNarration()
    {
        var prompt = VerdictPrompt.Build(
            new BenchmarkRunEntity { Id = "r", Suite = "csharp-dotnet", JudgeModel = "juez" },
            Array.Empty<BenchmarkResultEntity>(),
            "es");

        Assert.Contains("---RECOMENDACION---", prompt);
        Assert.Contains("---FIN---", prompt);
        Assert.Contains("No narres", prompt, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Build_AsksForRecommendationInRunLanguage()
    {
        var run = new BenchmarkRunEntity { Id = "r", Suite = "csharp-dotnet", JudgeModel = "juez" };

        Assert.Contains("Escribí la recomendación en inglés.", VerdictPrompt.Build(run, Array.Empty<BenchmarkResultEntity>(), "en"));
        Assert.Contains("Escribí la recomendación en español.", VerdictPrompt.Build(run, Array.Empty<BenchmarkResultEntity>(), "es"));
    }
}
