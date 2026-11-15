public sealed class ModelCatalogTests
{
    [Fact]
    public void Parse_TrimsSortsAndDeduplicates()
    {
        Assert.Equal(new[] { "a", "b" }, ModelCatalog.Parse("b\n a \nb\n"));
    }

    [Fact]
    public void Parse_IgnoresEmptyLines()
    {
        Assert.Equal(new[] { "provider/model" }, ModelCatalog.Parse("\n\nprovider/model\n"));
    }

    [Fact]
    public async Task ListAsync_ReturnsErrorWhenProcessFails()
    {
        var fake = new FakeProcessRunner();
        fake.Results.Enqueue(new ProcessResult(1, "", "boom", false, 10));
        var result = await new ModelCatalog(fake).ListAsync();
        Assert.Empty(result.Models);
        Assert.Contains("boom", result.Error);
    }

    [Fact]
    public async Task ListAsync_ReturnsErrorWhenTimedOut()
    {
        var fake = new FakeProcessRunner();
        fake.Results.Enqueue(new ProcessResult(-1, "", "", true, 15000));
        var result = await new ModelCatalog(fake).ListAsync();
        Assert.Empty(result.Models);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public async Task ListAsync_ParsesModels()
    {
        var fake = new FakeProcessRunner();
        fake.Results.Enqueue(new ProcessResult(0, "provider/b\nprovider/a\n", "", false, 10));
        var result = await new ModelCatalog(fake).ListAsync();
        Assert.Equal(new[] { "provider/a", "provider/b" }, result.Models);
        Assert.Null(result.Error);
    }

    [Fact]
    public async Task ListAsync_FiltersNvidiaAndLmstudio()
    {
        var fake = new FakeProcessRunner();
        fake.Results.Enqueue(new ProcessResult(0, "opencode-go/a\nnvidia/b\nlmstudio/c\nopencode-go/d\n", "", false, 10));
        var result = await new ModelCatalog(fake).ListAsync();
        Assert.Equal(new[] { "opencode-go/a", "opencode-go/d" }, result.Models);
    }

    [Fact]
    public async Task ListAsync_UsesOpenCodeModelsCommand()
    {
        var fake = new FakeProcessRunner();
        fake.Results.Enqueue(new ProcessResult(0, "provider/a\n", "", false, 10));
        await new ModelCatalog(fake).ListAsync();
        var request = Assert.Single(fake.Requests);
        if (OperatingSystem.IsWindows())
        {
            Assert.Equal("cmd.exe", request.FileName);
            Assert.Equal(new[] { "/c", "opencode", "models" }, request.Arguments);
        }
        else
        {
            Assert.Equal("opencode", request.FileName);
            Assert.Equal(new[] { "models" }, request.Arguments);
        }
        Assert.Equal(15000, request.TimeoutMs);
    }
}
