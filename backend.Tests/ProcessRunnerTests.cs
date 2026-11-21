public sealed class ProcessRunnerTests
{
    private readonly ProcessRunner _runner = new();

    [Fact]
    public async Task RunAsync_CapturesOutputAndExitCode()
    {
        var result = await _runner.RunAsync(
            new ProcessRequest("node", new[] { "-e", "console.log('hola')" }, Path.GetTempPath(), 15000),
            CancellationToken.None);
        Assert.Equal(0, result.ExitCode);
        Assert.Contains("hola", result.StandardOutput);
        Assert.False(result.TimedOut);
    }

    [Fact]
    public async Task RunAsync_ReturnsNonZeroExit()
    {
        var result = await _runner.RunAsync(
            new ProcessRequest("node", new[] { "-e", "process.exit(3)" }, Path.GetTempPath(), 15000),
            CancellationToken.None);
        Assert.Equal(3, result.ExitCode);
        Assert.False(result.TimedOut);
    }

    [Fact]
    public async Task RunAsync_TimesOutAndKillsTree()
    {
        var result = await _runner.RunAsync(
            new ProcessRequest("node", new[] { "-e", "setTimeout(()=>{},60000)" }, Path.GetTempPath(), 300),
            CancellationToken.None);
        Assert.True(result.TimedOut);
        Assert.True(result.DurationMs < 5000);
    }

    [Fact]
    public async Task RunAsync_CancellationKillsProcess()
    {
        using var cancellation = new CancellationTokenSource(100);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _runner.RunAsync(
            new ProcessRequest("node", new[] { "-e", "setTimeout(()=>{},60000)" }, Path.GetTempPath(), 60000),
            cancellation.Token));
    }

    [Fact]
    public async Task RunAsync_DecodesUtf8()
    {
        var result = await _runner.RunAsync(
            new ProcessRequest("node", new[] { "-e", "console.log('caché')" }, Path.GetTempPath(), 15000),
            CancellationToken.None);
        Assert.Contains("caché", result.StandardOutput);
    }

    [Fact]
    public void ShellCommand_UsesCmdOnWindows()
    {
        var (file, arguments) = ShellCommand.For("node --test");
        if (OperatingSystem.IsWindows())
        {
            Assert.Equal("cmd.exe", file);
            Assert.Equal(new[] { "/c", "node --test" }, arguments);
        }
        else
        {
            Assert.Equal("/bin/sh", file);
            Assert.Equal(new[] { "-c", "node --test" }, arguments);
        }
    }

    [Fact]
    public void ShellCommand_OpenCodeUsesCmdAndQuotesSpacesOnWindows()
    {
        var (file, arguments) = ShellCommand.OpenCode("opencode", "run", "--file", @"C:\tmp\a b.md");
        if (OperatingSystem.IsWindows())
        {
            Assert.Equal("cmd.exe", file);
            Assert.Equal(new[] { "/c", "opencode", "run", "--file", "\"C:\\tmp\\a b.md\"" }, arguments);
        }
        else
        {
            Assert.Equal("opencode", file);
            Assert.Equal(new[] { "run", "--file", @"C:\tmp\a b.md" }, arguments);
        }
    }

    [Fact]
    public void ShellCommand_OpenCodeQuotesCmdMetacharacters()
    {
        var (_, arguments) = ShellCommand.OpenCode("opencode", "--model", "a&calc");
        if (OperatingSystem.IsWindows())
            Assert.Contains("\"a&calc\"", arguments);
        else
            Assert.Contains("a&calc", arguments);
    }

    [Fact]
    public async Task RunAsync_ScrubsHostTelemetryKeysAndAppliesExplicitEnvironment()
    {
        var previousHost = Environment.GetEnvironmentVariable("TELEMETRY_API_KEY");
        var previousConfig = Environment.GetEnvironmentVariable("Telemetry__ApiKey");
        try
        {
            Environment.SetEnvironmentVariable("TELEMETRY_API_KEY", "secret-host-key");
            Environment.SetEnvironmentVariable("Telemetry__ApiKey", "secret-host-key-2");

            const string script = "console.log(JSON.stringify({host:process.env.TELEMETRY_API_KEY??null,host2:process.env.Telemetry__ApiKey??null,obs:process.env.OPENCODE_OBSERVABILITY_KEY??null}))";
            var plain = await _runner.RunAsync(
                new ProcessRequest("node", new[] { "-e", script }, Path.GetTempPath(), 15000),
                CancellationToken.None);
            Assert.Equal(0, plain.ExitCode);
            using (var json = System.Text.Json.JsonDocument.Parse(plain.StandardOutput))
            {
                Assert.Equal(System.Text.Json.JsonValueKind.Null, json.RootElement.GetProperty("host").ValueKind);
                Assert.Equal(System.Text.Json.JsonValueKind.Null, json.RootElement.GetProperty("host2").ValueKind);
                Assert.Equal(System.Text.Json.JsonValueKind.Null, json.RootElement.GetProperty("obs").ValueKind);
            }

            var scoped = await _runner.RunAsync(
                new ProcessRequest(
                    "node",
                    new[] { "-e", script },
                    Path.GetTempPath(),
                    15000,
                    new Dictionary<string, string> { ["OPENCODE_OBSERVABILITY_KEY"] = "scoped-key" }),
                CancellationToken.None);
            Assert.Equal(0, scoped.ExitCode);
            using (var json = System.Text.Json.JsonDocument.Parse(scoped.StandardOutput))
            {
                Assert.Equal(System.Text.Json.JsonValueKind.Null, json.RootElement.GetProperty("host").ValueKind);
                Assert.Equal(System.Text.Json.JsonValueKind.Null, json.RootElement.GetProperty("host2").ValueKind);
                Assert.Equal("scoped-key", json.RootElement.GetProperty("obs").GetString());
            }
        }
        finally
        {
            Environment.SetEnvironmentVariable("TELEMETRY_API_KEY", previousHost);
            Environment.SetEnvironmentVariable("Telemetry__ApiKey", previousConfig);
        }
    }
}
