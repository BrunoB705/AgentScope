using Microsoft.EntityFrameworkCore;

public sealed class BenchmarkStorageTests : IDisposable
{
    private readonly string _database = Path.Combine(Path.GetTempPath(), $"bench-store-{Guid.NewGuid():N}.db");

    public void Dispose()
    {
        if (File.Exists(_database)) File.Delete(_database);
    }

    private TelemetryDb CreateDb()
    {
        var db = new TelemetryDb(new DbContextOptionsBuilder<TelemetryDb>()
            .UseSqlite($"Data Source={_database};Pooling=False")
            .Options);
        db.Database.EnsureCreated();
        BenchmarkStorage.EnsureAsync(db).GetAwaiter().GetResult();
        return db;
    }

    [Fact]
    public async Task MarkStaleAsync_FailsRunsAndCancelsRunningResults()
    {
        await using var db = CreateDb();
        db.BenchmarkRuns.Add(new BenchmarkRunEntity
        {
            Id = "run1",
            Suite = "demo",
            JudgeModel = "judge/model",
            Status = "running",
            Total = 1,
            CreatedAt = DateTime.UtcNow,
        });
        db.BenchmarkResults.Add(new BenchmarkResultEntity
        {
            Id = "result1",
            RunId = "run1",
            TestName = "code-test",
            TestType = "code",
            Model = "provider/model-a",
            Status = "running",
        });
        await db.SaveChangesAsync();

        await BenchmarkStorage.MarkStaleAsync(db);
        db.ChangeTracker.Clear();

        Assert.Equal("failed", (await db.BenchmarkRuns.SingleAsync()).Status);
        Assert.Equal("cancelled", (await db.BenchmarkResults.SingleAsync()).Status);
    }

    [Fact]
    public async Task ConcurrentStatusUpdate_IsDetected()
    {
        await using var first = CreateDb();
        first.BenchmarkRuns.Add(new BenchmarkRunEntity
        {
            Id = "run1",
            Suite = "demo",
            JudgeModel = "judge/model",
            Status = "running",
            Total = 1,
            CreatedAt = DateTime.UtcNow,
        });
        await first.SaveChangesAsync();

        await using var second = CreateDb();
        var secondRun = await second.BenchmarkRuns.SingleAsync();
        secondRun.Status = "cancelled";
        await second.SaveChangesAsync();

        var firstRun = await first.BenchmarkRuns.SingleAsync();
        firstRun.Status = "completed";
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() => first.SaveChangesAsync());
    }

    [Fact]
    public void Cancel_AfterRemove_DoesNotThrow()
    {
        var registry = new BenchmarkCancellationRegistry();
        registry.Get("run1");
        registry.Remove("run1");
        var exception = Record.Exception(() => registry.Cancel("run1"));
        Assert.Null(exception);
    }
}
