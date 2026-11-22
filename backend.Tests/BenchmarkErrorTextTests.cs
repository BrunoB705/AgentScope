public sealed class BenchmarkErrorTextTests
{
    [Fact]
    public void Read_UnknownCodeWithFallback_ReturnsFallbackMessage()
    {
        var stored = BenchmarkErrorText.Encode(
            "suite_unreadable",
            new Dictionary<string, string> { ["detail"] = "boom" },
            "Could not read the suite: boom");

        var error = BenchmarkErrorText.Read(stored);

        Assert.Equal("Could not read the suite: boom", error.Error);
        Assert.Equal("suite_unreadable", error.Code);
        Assert.Equal("boom", error.Parameters!["detail"]);
    }

    [Fact]
    public void Read_KnownCodeWithFallback_PrefersTemplate()
    {
        var stored = BenchmarkErrorText.Encode("model_timeout", null, "Texto de reemplazo.");
        Assert.Contains("Texto de reemplazo.", stored);

        var error = BenchmarkErrorText.Read(stored);

        Assert.Equal("The model timed out.", error.Error);
        Assert.Equal("model_timeout", error.Code);
    }

    [Fact]
    public void Read_UnknownCodeWithoutFallback_ReturnsCode()
    {
        var error = BenchmarkErrorText.Read(BenchmarkErrorText.Encode("suite_unreadable"));

        Assert.Equal("suite_unreadable", error.Error);
        Assert.Equal("suite_unreadable", error.Code);
    }
}
