public sealed class BenchmarkCatalogTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"bench-catalog-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private const string ValidSuite = """
    {
      "name": "Demo",
      "description": "Suite de prueba",
      "defaultJudge": "provider/judge",
      "modelTimeoutMs": 300000,
      "tests": [
        {
          "name": "code-test",
          "type": "code",
          "promptFile": "prompts/code.md",
          "fixture": "fixtures/app",
          "verify": { "command": "node --test", "timeoutMs": 120000 },
          "judge": true
        },
        {
          "name": "open-test",
          "type": "open",
          "promptFile": "prompts/open.md",
          "rubric": ["Claridad", "Correctitud"]
        }
      ]
    }
    """;

    private void WriteSuite(string id, string json, params (string Path, string Content)[] files)
    {
        var directory = Path.Combine(_root, id);
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "suite.json"), json);
        var defaults = new[]
        {
            ("prompts/code.md", "Corregí el bug."),
            ("prompts/open.md", "Explicá la caché."),
            ("fixtures/app/app.txt", "app"),
        };
        foreach (var (path, content) in defaults.Concat(files))
        {
            var target = Path.Combine(directory, path);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllText(target, content);
        }
    }

    private void WriteValidSuite(string id = "demo")
    {
        Directory.CreateDirectory(Path.Combine(_root, id, "fixtures", "app"));
        File.WriteAllText(Path.Combine(_root, id, "fixtures", "app", "app.txt"), "app");
        WriteSuite(id, ValidSuite,
            ("prompts/code.md", "Corregí el bug."),
            ("prompts/open.md", "Explicá la caché."));
    }

    private BenchmarkCatalog Catalog() => new(_root);

    [Fact]
    public void List_ReturnsCodeAndOpenTests()
    {
        WriteValidSuite();
        var result = Catalog().List();
        var suite = Assert.Single(result.Suites);
        Assert.Empty(result.Errors);
        Assert.Equal("demo", suite.Id);
        Assert.Equal("Demo", suite.Name);
        Assert.Equal(2, suite.Tests.Length);
        Assert.Equal("code", suite.Tests[0].Type);
        Assert.True(suite.Tests[0].Judge);
        Assert.Equal("open", suite.Tests[1].Type);
        Assert.True(suite.Tests[1].Judge);
    }

    [Fact]
    public void List_IgnoresDirectoriesWithoutSuiteJson()
    {
        Directory.CreateDirectory(Path.Combine(_root, "empty"));
        var result = Catalog().List();
        Assert.Empty(result.Suites);
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void List_ReturnsErrorsForInvalidSuites()
    {
        WriteSuite("bad", ValidSuite.Replace("\"code\"", "\"weird\""));
        var result = Catalog().List();
        Assert.Empty(result.Suites);
        var error = Assert.Single(result.Errors);
        Assert.Equal("bad", error.Id);
        Assert.Contains("tipo", error.Error);
    }

    [Fact]
    public void Load_ReadsPromptFile()
    {
        WriteValidSuite();
        var suite = Catalog().Load("demo");
        Assert.Equal("Corregí el bug.", suite.Tests[0].Prompt);
        Assert.EndsWith("app", suite.Tests[0].FixturePath!);
    }

    [Fact]
    public void Load_RejectsUnknownType()
    {
        WriteSuite("bad", ValidSuite.Replace("\"code\"", "\"weird\""));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Contains("tipo", error.Message);
    }

    [Fact]
    public void Load_RejectsCodeWithoutVerify()
    {
        WriteSuite("bad", """
        {
          "name": "Bad",
          "tests": [
            { "name": "code-test", "type": "code", "promptFile": "prompts/code.md", "fixture": "fixtures/app" }
          ]
        }
        """);
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Contains("verify", error.Message);
    }

    [Fact]
    public void Load_RejectsOpenWithoutRubric()
    {
        WriteSuite("bad", ValidSuite.Replace("[\"Claridad\", \"Correctitud\"]", "[]"));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Contains("rubric", error.Message);
    }

    [Fact]
    public void Load_RejectsJudgeOnOpenTest()
    {
        WriteSuite("bad", ValidSuite.Replace("\"rubric\": [\"Claridad\", \"Correctitud\"]", "\"rubric\": [\"Claridad\"], \"judge\": true"));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Contains("judge", error.Message);
    }

    [Fact]
    public void Load_RejectsPathTraversal()
    {
        WriteSuite("bad", ValidSuite.Replace("prompts/code.md", "../secret.md"));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Contains("sale del directorio", error.Message);
    }

    [Fact]
    public void Load_RejectsDuplicateTestNames()
    {
        WriteSuite("bad", ValidSuite.Replace("\"name\": \"open-test\"", "\"name\": \"code-test\""));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Contains("duplicad", error.Message);
    }

    [Fact]
    public void Load_AppliesDefaultTimeouts()
    {
        var json = ValidSuite.Replace("\"modelTimeoutMs\": 300000,", "").Replace(", \"timeoutMs\": 120000", "");
        WriteSuite("demo", json,
            ("prompts/code.md", "Corregí el bug."),
            ("prompts/open.md", "Explicá la caché."));
        Directory.CreateDirectory(Path.Combine(_root, "demo", "fixtures", "app"));
        var suite = Catalog().Load("demo");
        Assert.Equal(300000, suite.ModelTimeoutMs);
        Assert.Equal(120000, suite.Tests[0].VerifyTimeoutMs);
    }

    [Fact]
    public void Load_RejectsTimeoutOutOfRange()
    {
        WriteSuite("bad", ValidSuite.Replace("\"modelTimeoutMs\": 300000", "\"modelTimeoutMs\": 5"));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Contains("timeout", error.Message);
    }

    [Fact]
    public void Load_UnknownId_Throws()
    {
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("missing"));
        Assert.Contains("no existe", error.Message);
    }
}
