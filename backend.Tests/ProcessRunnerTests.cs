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
}
