public class BenchmarkRealSuitesTests
{
    [Fact]
    public void RealSuites_LoadWithoutCatalogErrors()
    {
        var catalog = new BenchmarkCatalog(FindBenchmarksRoot());
        var list = catalog.List();

        Assert.Empty(list.Errors);
        Assert.Contains(list.Suites, suite => suite.Id == "refactor-pequeno");

        var csharpSuite = list.Suites.Single(item => item.Id == "csharp-dotnet");
        Assert.Equal("opencode-go/minimax-m3", csharpSuite.DefaultJudge);
        Assert.DoesNotContain(csharpSuite.Tests, test => test.Type == "code" && test.Judge);
    }

    private static string FindBenchmarksRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "benchmarks");
            if (Directory.Exists(Path.Combine(candidate, "refactor-pequeno"))) return candidate;
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("No se encontró el directorio benchmarks/.");
    }
}
