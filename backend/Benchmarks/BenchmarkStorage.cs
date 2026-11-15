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
          RequestVerdict INTEGER NOT NULL DEFAULT 1,
          Verdict TEXT NULL,
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
        await EnsureColumnAsync(db, "RequestVerdict", "INTEGER NOT NULL DEFAULT 1");
        await EnsureColumnAsync(db, "Verdict", "TEXT NULL");
    }

    private static async Task EnsureColumnAsync(DbContext db, string column, string definition)
    {
        var exists = false;
        await db.Database.OpenConnectionAsync();
        try
        {
            await using var command = db.Database.GetDbConnection().CreateCommand();
            command.CommandText = "PRAGMA table_info('BenchmarkRuns')";
            await using var reader = await command.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                if (reader.GetString(1) == column) exists = true;
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
        if (!exists)
        {
            var sql = (column, definition) switch
            {
                ("RequestVerdict", "INTEGER NOT NULL DEFAULT 1") => "ALTER TABLE BenchmarkRuns ADD COLUMN RequestVerdict INTEGER NOT NULL DEFAULT 1",
                ("Verdict", "TEXT NULL") => "ALTER TABLE BenchmarkRuns ADD COLUMN Verdict TEXT NULL",
                _ => throw new ArgumentOutOfRangeException(nameof(column)),
            };
            await db.Database.ExecuteSqlRawAsync(sql);
        }
    }

    public static async Task MarkStaleAsync(DbContext db)
    {
        await db.Database.ExecuteSqlRawAsync("UPDATE BenchmarkRuns SET Status='failed', Error='Interrumpida por reinicio', CompletedAt=datetime('now') WHERE Status IN ('queued','running')");
        await db.Database.ExecuteSqlRawAsync("UPDATE BenchmarkResults SET Status='cancelled' WHERE Status IN ('pending','running') AND RunId IN (SELECT Id FROM BenchmarkRuns WHERE Status='failed')");
    }
}
