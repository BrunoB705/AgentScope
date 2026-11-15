using Microsoft.EntityFrameworkCore;

public static class BenchmarkStorage
{
    public static async Task EnsureAsync(DbContext db)
    {
        await db.Database.ExecuteSqlRawAsync("""
        CREATE TABLE IF NOT EXISTS BenchmarkRuns (
          Id TEXT NOT NULL PRIMARY KEY,
          Suite TEXT NOT NULL,
          JudgeModel TEXT NOT NULL,
          Status TEXT NOT NULL,
          Total INTEGER NOT NULL,
          Completed INTEGER NOT NULL DEFAULT 0,
          CreatedAt TEXT NOT NULL,
          StartedAt TEXT NULL,
          CompletedAt TEXT NULL,
          BaselineJson TEXT NULL,
          Error TEXT NULL
        );
        """);
        await db.Database.ExecuteSqlRawAsync("""
        CREATE TABLE IF NOT EXISTS BenchmarkResults (
          Id TEXT NOT NULL PRIMARY KEY,
          RunId TEXT NOT NULL,
          TestName TEXT NOT NULL,
          TestType TEXT NOT NULL,
          Model TEXT NOT NULL,
          Status TEXT NOT NULL,
          VerifyPassed INTEGER NULL,
          VerifyExitCode INTEGER NULL,
          SessionId TEXT NULL,
          JudgeSessionId TEXT NULL,
          DurationMs INTEGER NULL,
          InputTokens INTEGER NOT NULL DEFAULT 0,
          OutputTokens INTEGER NOT NULL DEFAULT 0,
          CacheReadTokens INTEGER NOT NULL DEFAULT 0,
          CacheWriteTokens INTEGER NOT NULL DEFAULT 0,
          Cost REAL NULL,
          QuotaCostEstimate REAL NULL,
          JudgeScore INTEGER NULL,
          JudgeRationale TEXT NULL,
          MetricsError TEXT NULL,
          Error TEXT NULL,
          StartedAt TEXT NULL,
          CompletedAt TEXT NULL
        );
        """);
    }

    public static async Task MarkStaleAsync(DbContext db)
    {
        await db.Database.ExecuteSqlRawAsync("UPDATE BenchmarkRuns SET Status='failed', Error='Interrumpida por reinicio', CompletedAt=datetime('now') WHERE Status IN ('queued','running')");
        await db.Database.ExecuteSqlRawAsync("UPDATE BenchmarkResults SET Status='cancelled' WHERE Status IN ('pending','running') AND RunId IN (SELECT Id FROM BenchmarkRuns WHERE Status='failed')");
    }
}
