using Microsoft.EntityFrameworkCore;

/// <summary>
/// Migrador versionado. No usa EF Migrations porque el proyecto no depende de la
/// herramienta `dotnet-ef` y porque una base existente necesita un baseline sin
/// recrear tablas. La versión aplicada queda registrada en `SchemaVersion`, de modo
/// que el arranque sea idempotente y el estado sea legible sin abrir el esquema.
/// </summary>
internal static class SchemaMigrator
{
    internal const int LatestVersion = 2;

    internal static async Task ApplyAsync(TelemetryDb db)
    {
        var fresh = !await TableExistsAsync(db, "Sessions");
        await db.Database.EnsureCreatedAsync();
        await db.Database.ExecuteSqlRawAsync(
            "CREATE TABLE IF NOT EXISTS SchemaVersion (Version INTEGER NOT NULL PRIMARY KEY, AppliedAt TEXT NOT NULL)");

        if (fresh)
        {
            await RecordAsync(db, LatestVersion);
            return;
        }

        // Una base anterior a este migrador ya trae el esquema legacy; se completan
        // las columnas que versiones previas agregaban a mano para que la migración
        // 2 pueda copiar sin suponer nada.
        await EnsureLegacyColumnsAsync(db);
        if (await CurrentVersionAsync(db) < LatestVersion) await UpgradeToNullableTokensAsync(db);
        await RecordAsync(db, LatestVersion);
    }

    internal static async Task<int> CurrentVersionAsync(TelemetryDb db)
    {
        await db.Database.OpenConnectionAsync();
        try
        {
            await using var command = db.Database.GetDbConnection().CreateCommand();
            command.CommandText = "SELECT MAX(Version) FROM SchemaVersion";
            var value = await command.ExecuteScalarAsync();
            return value is null or DBNull ? 0 : Convert.ToInt32(value);
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    /// <summary>
    /// F-04: los contadores de tokens pasan a NULL para distinguir «no reportado» de
    /// «cero». SQLite no cambia la nulabilidad de una columna, así que hay que
    /// reconstruir la tabla copiando los datos.
    /// </summary>
    private static async Task UpgradeToNullableTokensAsync(TelemetryDb db)
    {
        await using var transaction = await db.Database.BeginTransactionAsync();
        await RebuildEventsAsync(db);
        await RebuildSpansAsync(db);
        await AddColumnIfMissingAsync(db, "Sessions", "TitleAt", "TEXT NULL");
        await AddColumnIfMissingAsync(db, "Sessions", "ModelAt", "TEXT NULL");
        await transaction.CommitAsync();
    }

    private static async Task RebuildEventsAsync(TelemetryDb db)
    {
        await db.Database.ExecuteSqlRawAsync("DROP TABLE IF EXISTS \"Events_v2\"");
        await db.Database.ExecuteSqlRawAsync("""
            CREATE TABLE "Events_v2" (
              "Id" INTEGER NOT NULL CONSTRAINT "PK_Events" PRIMARY KEY AUTOINCREMENT,
              "EventId" TEXT NOT NULL, "Source" TEXT NOT NULL, "SessionId" TEXT NOT NULL,
              "Timestamp" TEXT NOT NULL, "Type" TEXT NOT NULL, "Status" TEXT NULL,
              "DurationMs" INTEGER NULL, "Model" TEXT NULL,
              "InputTokens" INTEGER NULL, "OutputTokens" INTEGER NULL, "ReasoningTokens" INTEGER NULL,
              "CacheReadTokens" INTEGER NULL, "CacheWriteTokens" INTEGER NULL,
              "Cost" REAL NULL, "QuotaCostEstimate" REAL NULL,
              "QuotaCatalogFetchedAt" TEXT NULL, "QuotaRateSnapshot" TEXT NULL, "QuotaMissingReason" TEXT NULL,
              "AttributesJson" TEXT NOT NULL
            )
            """);
        await db.Database.ExecuteSqlRawAsync("""
            INSERT INTO "Events_v2" ("Id","EventId","Source","SessionId","Timestamp","Type","Status","DurationMs","Model",
              "InputTokens","OutputTokens","ReasoningTokens","CacheReadTokens","CacheWriteTokens","Cost","QuotaCostEstimate",
              "QuotaCatalogFetchedAt","QuotaRateSnapshot","QuotaMissingReason","AttributesJson")
            SELECT "Id","EventId","Source","SessionId","Timestamp","Type","Status","DurationMs","Model",
              "InputTokens","OutputTokens","ReasoningTokens","CacheReadTokens","CacheWriteTokens","Cost","QuotaCostEstimate",
              "QuotaCatalogFetchedAt","QuotaRateSnapshot","QuotaMissingReason","AttributesJson" FROM "Events"
            """);
        await db.Database.ExecuteSqlRawAsync("DROP TABLE \"Events\"");
        await db.Database.ExecuteSqlRawAsync("ALTER TABLE \"Events_v2\" RENAME TO \"Events\"");
        await db.Database.ExecuteSqlRawAsync("CREATE INDEX IF NOT EXISTS \"IX_Events_Source_EventId\" ON \"Events\" (\"Source\", \"EventId\")");
    }

    private static async Task RebuildSpansAsync(TelemetryDb db)
    {
        await db.Database.ExecuteSqlRawAsync("DROP TABLE IF EXISTS \"Spans_v2\"");
        await db.Database.ExecuteSqlRawAsync("""
            CREATE TABLE "Spans_v2" (
              "Id" TEXT NOT NULL CONSTRAINT "PK_Spans" PRIMARY KEY,
              "SessionId" TEXT NOT NULL, "ParentId" TEXT NULL, "Name" TEXT NOT NULL,
              "Kind" TEXT NOT NULL, "Status" TEXT NOT NULL, "StartedAt" TEXT NOT NULL, "DurationMs" INTEGER NULL,
              "InputTokens" INTEGER NULL, "OutputTokens" INTEGER NULL, "ReasoningTokens" INTEGER NULL,
              "CacheReadTokens" INTEGER NULL, "CacheWriteTokens" INTEGER NULL,
              "Cost" REAL NULL, "QuotaCostEstimate" REAL NULL,
              "QuotaCatalogFetchedAt" TEXT NULL, "QuotaRateSnapshot" TEXT NULL, "QuotaMissingReason" TEXT NULL,
              "AttributesJson" TEXT NOT NULL
            )
            """);
        await db.Database.ExecuteSqlRawAsync("""
            INSERT INTO "Spans_v2" ("Id","SessionId","ParentId","Name","Kind","Status","StartedAt","DurationMs",
              "InputTokens","OutputTokens","ReasoningTokens","CacheReadTokens","CacheWriteTokens","Cost","QuotaCostEstimate",
              "QuotaCatalogFetchedAt","QuotaRateSnapshot","QuotaMissingReason","AttributesJson")
            SELECT "Id","SessionId","ParentId","Name","Kind","Status","StartedAt","DurationMs",
              "InputTokens","OutputTokens","ReasoningTokens","CacheReadTokens","CacheWriteTokens","Cost","QuotaCostEstimate",
              "QuotaCatalogFetchedAt","QuotaRateSnapshot","QuotaMissingReason","AttributesJson" FROM "Spans"
            """);
        await db.Database.ExecuteSqlRawAsync("DROP TABLE \"Spans\"");
        await db.Database.ExecuteSqlRawAsync("ALTER TABLE \"Spans_v2\" RENAME TO \"Spans\"");
    }

    private static async Task EnsureLegacyColumnsAsync(TelemetryDb db)
    {
        foreach (var table in new[] { "Events", "Spans" })
        {
            await AddColumnIfMissingAsync(db, table, "Cost", "REAL NULL");
            await AddColumnIfMissingAsync(db, table, "ReasoningTokens", "INTEGER NOT NULL DEFAULT 0");
            await AddColumnIfMissingAsync(db, table, "CacheReadTokens", "INTEGER NOT NULL DEFAULT 0");
            await AddColumnIfMissingAsync(db, table, "CacheWriteTokens", "INTEGER NOT NULL DEFAULT 0");
            await AddColumnIfMissingAsync(db, table, "QuotaCostEstimate", "REAL NULL");
            await AddColumnIfMissingAsync(db, table, "QuotaCatalogFetchedAt", "TEXT NULL");
            await AddColumnIfMissingAsync(db, table, "QuotaRateSnapshot", "TEXT NULL");
            await AddColumnIfMissingAsync(db, table, "QuotaMissingReason", "TEXT NULL");
        }
        await AddColumnIfMissingAsync(db, "Sessions", "Title", "TEXT NULL");
        await AddColumnIfMissingAsync(db, "Sessions", "Rating", "INTEGER NULL");
        await AddColumnIfMissingAsync(db, "Sessions", "ReviewNote", "TEXT NULL");
        await AddColumnIfMissingAsync(db, "Sessions", "ReviewTask", "TEXT NULL");
    }

    private static async Task RecordAsync(TelemetryDb db, int version)
    {
        await db.Database.ExecuteSqlRawAsync(
            "INSERT INTO SchemaVersion (Version, AppliedAt) VALUES ({0}, {1}) ON CONFLICT(Version) DO NOTHING",
            version, DateTime.UtcNow.ToString("O"));
    }

    private static async Task<bool> TableExistsAsync(TelemetryDb db, string table)
    {
        await db.Database.OpenConnectionAsync();
        try
        {
            await using var command = db.Database.GetDbConnection().CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = @name";
            var parameter = command.CreateParameter();
            parameter.ParameterName = "name";
            parameter.Value = table;
            command.Parameters.Add(parameter);
            var value = await command.ExecuteScalarAsync();
            return Convert.ToInt32(value) > 0;
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    private static readonly HashSet<string> KnownTables = new(StringComparer.Ordinal) { "Events", "Spans", "Sessions" };
    private static readonly HashSet<string> KnownColumns = new(StringComparer.Ordinal)
    {
        "Cost", "ReasoningTokens", "CacheReadTokens", "CacheWriteTokens", "QuotaCostEstimate",
        "QuotaCatalogFetchedAt", "QuotaRateSnapshot", "QuotaMissingReason",
        "Title", "Rating", "ReviewNote", "ReviewTask", "TitleAt", "ModelAt",
    };

#pragma warning disable EF1002 // identificadores validados contra KnownTables/KnownColumns
    private static async Task AddColumnIfMissingAsync(TelemetryDb db, string table, string column, string definition)
    {
        if (!KnownTables.Contains(table)) throw new ArgumentOutOfRangeException(nameof(table));
        if (!KnownColumns.Contains(column)) throw new ArgumentOutOfRangeException(nameof(column));
        if (await ColumnExistsAsync(db, table, column)) return;
        var definitionSql = definition switch
        {
            "TEXT NULL" => "TEXT NULL",
            "REAL NULL" => "REAL NULL",
            "INTEGER NULL" => "INTEGER NULL",
            "INTEGER NOT NULL DEFAULT 0" => "INTEGER NOT NULL DEFAULT 0",
            _ => throw new ArgumentOutOfRangeException(nameof(definition)),
        };
        await db.Database.ExecuteSqlRawAsync($"ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {definitionSql}");
    }

#pragma warning restore EF1002

    private static async Task<bool> ColumnExistsAsync(TelemetryDb db, string table, string column)
    {
        await db.Database.OpenConnectionAsync();
        try
        {
            await using var command = db.Database.GetDbConnection().CreateCommand();
            command.CommandText = $"PRAGMA table_info('{table}')";
            await using var reader = await command.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                if (reader.GetString(1) == column) return true;
            return false;
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }
}
