using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// La migración tiene que poder llevar una base creada por versiones anteriores al
/// esquema actual sin perder filas. Se construye una base "legacy" a mano y se
/// verifica el resultado, que es lo que ninguna prueba cubría.
/// </summary>
public sealed class SchemaMigratorTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"migrator-{Guid.NewGuid():N}.db");

    public void Dispose()
    {
        // Sin ClearAllPools(): vaciar el pool global afecta a las demás factorías de
        // prueba que corren en paralelo. Las conexiones usan Pooling=False.
        if (File.Exists(_path)) File.Delete(_path);
    }

    private TelemetryDb Context() =>
        new(new DbContextOptionsBuilder<TelemetryDb>().UseSqlite($"Data Source={_path};Pooling=False").Options);

    private void CreateLegacyDatabase()
    {
        using var connection = new SqliteConnection($"Data Source={_path};Pooling=False");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE "Sessions" (
              "Id" TEXT NOT NULL PRIMARY KEY, "Source" TEXT NOT NULL, "Project" TEXT NULL, "Title" TEXT NULL,
              "Status" TEXT NOT NULL, "Model" TEXT NULL, "StartedAt" TEXT NOT NULL, "EndedAt" TEXT NULL, "UpdatedAt" TEXT NOT NULL
            );
            CREATE TABLE "Events" (
              "Id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "EventId" TEXT NOT NULL, "Source" TEXT NOT NULL,
              "SessionId" TEXT NOT NULL, "Timestamp" TEXT NOT NULL, "Type" TEXT NOT NULL, "Status" TEXT NULL,
              "DurationMs" INTEGER NULL, "Model" TEXT NULL,
              "InputTokens" INTEGER NOT NULL DEFAULT 0, "OutputTokens" INTEGER NOT NULL DEFAULT 0,
              "AttributesJson" TEXT NOT NULL
            );
            CREATE TABLE "Spans" (
              "Id" TEXT NOT NULL PRIMARY KEY, "SessionId" TEXT NOT NULL, "ParentId" TEXT NULL, "Name" TEXT NOT NULL,
              "Kind" TEXT NOT NULL, "Status" TEXT NOT NULL, "StartedAt" TEXT NOT NULL, "DurationMs" INTEGER NULL,
              "InputTokens" INTEGER NOT NULL DEFAULT 0, "OutputTokens" INTEGER NOT NULL DEFAULT 0,
              "AttributesJson" TEXT NOT NULL
            );
            CREATE TABLE "Budgets" ("Project" TEXT NOT NULL PRIMARY KEY, "MonthlyLimit" REAL NOT NULL, "Metric" TEXT NOT NULL);
            INSERT INTO "Sessions" ("Id","Source","Status","StartedAt","UpdatedAt")
              VALUES ('legacy-session','opencode','completed','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z');
            INSERT INTO "Events" ("EventId","Source","SessionId","Timestamp","Type","Status","Model","InputTokens","OutputTokens","AttributesJson")
              VALUES ('legacy:model:1','opencode','legacy-session','2026-11-01T00:00:00Z','model.completed','ok','opencode-go/x',7,3,'{}');
            INSERT INTO "Spans" ("Id","SessionId","Name","Kind","Status","StartedAt","InputTokens","OutputTokens","AttributesJson")
              VALUES ('opencode:legacy:model:1','legacy-session','opencode-go/x','inference','ok','2026-11-01T00:00:00Z',7,3,'{}');
            """;
        command.ExecuteNonQuery();
    }

    private int ColumnNotNull(string table, string column)
    {
        using var connection = new SqliteConnection($"Data Source={_path};Pooling=False");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info('{table}')";
        using var reader = command.ExecuteReader();
        while (reader.Read())
            if (reader.GetString(1) == column) return reader.GetInt32(3);
        return -1;
    }

    [Fact]
    public async Task UpgradesLegacyDatabaseWithoutLosingRows()
    {
        CreateLegacyDatabase();
        await using var db = Context();
        await SchemaMigrator.ApplyAsync(db);

        Assert.Equal(SchemaMigrator.LatestVersion, await SchemaMigrator.CurrentVersionAsync(db));
        Assert.Equal(0, ColumnNotNull("Events", "InputTokens"));
        Assert.Equal(0, ColumnNotNull("Spans", "OutputTokens"));

        var span = await db.Spans.AsNoTracking().SingleAsync();
        Assert.Equal(7, span.InputTokens);
        Assert.Equal(3, span.OutputTokens);

        var events = await db.Events.AsNoTracking().CountAsync();
        Assert.Equal(1, events);
    }

    [Fact]
    public async Task UpgradedSchemaAcceptsNullCounters()
    {
        CreateLegacyDatabase();
        await using var db = Context();
        await SchemaMigrator.ApplyAsync(db);

        db.Spans.Add(new Span
        {
            Id = "opencode:new", SessionId = "legacy-session", Name = "opencode-go/x",
            Kind = "inference", Status = "ok", StartedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();

        var span = await db.Spans.AsNoTracking().SingleAsync(x => x.Id == "opencode:new");
        Assert.Null(span.InputTokens);
        Assert.Null(span.OutputTokens);
    }

    [Fact]
    public async Task MigrationIsIdempotent()
    {
        CreateLegacyDatabase();
        await using var db = Context();
        await SchemaMigrator.ApplyAsync(db);
        await SchemaMigrator.ApplyAsync(db);
        Assert.Equal(SchemaMigrator.LatestVersion, await SchemaMigrator.CurrentVersionAsync(db));
        Assert.Equal(1, await db.Spans.AsNoTracking().CountAsync());
    }

    [Fact]
    public async Task CreatesBenchmarkTablesAndPerformanceIndexes()
    {
        CreateLegacyDatabase();
        await using var db = Context();
        await SchemaMigrator.ApplyAsync(db);

        using var connection = new SqliteConnection($"Data Source={_path};Pooling=False");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT type, name FROM sqlite_master WHERE type IN ('table','index')";
        var objects = new HashSet<(string Type, string Name)>();
        using var reader = command.ExecuteReader();
        while (reader.Read()) objects.Add((reader.GetString(0), reader.GetString(1)));

        Assert.Contains(("table", "BenchmarkRuns"), objects);
        Assert.Contains(("table", "BenchmarkResults"), objects);
        Assert.Contains(("index", "IX_Events_Source_EventId"), objects);
        Assert.Contains(("index", "IX_Events_SessionId_Timestamp"), objects);
        Assert.Contains(("index", "IX_Spans_SessionId_StartedAt"), objects);
    }
}
