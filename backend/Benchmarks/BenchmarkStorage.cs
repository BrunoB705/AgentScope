using Microsoft.EntityFrameworkCore;

public static class BenchmarkStorage
{
    public static Task EnsureAsync(DbContext db) => SchemaMigrator.EnsureBenchmarkTablesAsync(db);

    public static async Task MarkStaleAsync(DbContext db)
    {
        await db.Database.ExecuteSqlRawAsync("UPDATE BenchmarkRuns SET Status='failed', Error='Interrumpida por reinicio', CompletedAt=datetime('now') WHERE Status IN ('queued','running')");
        await db.Database.ExecuteSqlRawAsync("UPDATE BenchmarkResults SET Status='cancelled' WHERE Status IN ('pending','running') AND RunId IN (SELECT Id FROM BenchmarkRuns WHERE Status='failed')");
    }
}
