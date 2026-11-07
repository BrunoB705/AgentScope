using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.Sqlite;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<TelemetryDb>(o => o.UseSqlite(builder.Configuration.GetConnectionString("Telemetry") ?? "Data Source=telemetry.db"));
builder.Services.AddSignalR();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));
var app = builder.Build();
using (var scope = app.Services.CreateScope()) await scope.ServiceProvider.GetRequiredService<TelemetryDb>().Database.EnsureCreatedAsync();
app.UseCors();
app.MapHub<TelemetryHub>("/hubs/telemetry");
app.MapGet("/api/v1/health", () => Results.Ok(new { status = "ok" }));
app.MapPost("/api/v1/telemetry/events", async (HttpRequest request, TelemetryEventDto dto, TelemetryDb db, IConfiguration config, IHubContext<TelemetryHub> hub) => {
    var key = config["Telemetry:ApiKey"] ?? "[development-key-removed]";
    if (!CryptographicEquals(request.Headers["X-Telemetry-Key"].ToString(), key)) return Results.Unauthorized();
    if (string.IsNullOrWhiteSpace(dto.EventId) || dto.EventId.Length > 200 || string.IsNullOrWhiteSpace(dto.Source) || dto.Source.Length > 80 || string.IsNullOrWhiteSpace(dto.SessionId) || dto.SessionId.Length > 200 || string.IsNullOrWhiteSpace(dto.Type) || dto.Type.Length > 120 || dto.Timestamp == default || dto.DurationMs < 0 || dto.InputTokens < 0 || dto.OutputTokens < 0) return Results.BadRequest(new { error = "Required fields are missing or exceed supported limits" });
    var existing = await db.Events.AnyAsync(e => e.Source == dto.Source && e.EventId == dto.EventId);
    if (existing) return Results.Ok(new { accepted = true, duplicate = true });
    var session = await db.Sessions.FindAsync(dto.SessionId);
    if (session is null) { session = new Session { Id = dto.SessionId, Source = dto.Source, Project = Safe(dto.Project, 120), StartedAt = dto.Timestamp.UtcDateTime }; db.Sessions.Add(session); }
    session.UpdatedAt = DateTime.UtcNow;
    if (dto.Timestamp.UtcDateTime < session.StartedAt) session.StartedAt = dto.Timestamp.UtcDateTime;
    if (dto.Type is "session.idle" or "session.error") { session.Status = dto.Type == "session.error" ? "error" : "completed"; session.EndedAt = dto.Timestamp.UtcDateTime; }
    if (!string.IsNullOrWhiteSpace(dto.Model)) session.Model = Safe(dto.Model, 120);
    var attrs = SafeAttributes(dto.Attributes);
    var ev = new TelemetryEvent { EventId = dto.EventId, Source = dto.Source, SessionId = dto.SessionId, Timestamp = dto.Timestamp.UtcDateTime, Type = dto.Type, Status = dto.Status, DurationMs = dto.DurationMs, Model = Safe(dto.Model, 120), InputTokens = dto.InputTokens, OutputTokens = dto.OutputTokens, AttributesJson = JsonSerializer.Serialize(attrs) };
    db.Events.Add(ev);
    if (dto.Type.StartsWith("tool.")) db.Spans.Add(new Span { Id = SpanId(dto.Source, dto.EventId), SessionId = dto.SessionId, ParentId = ParentSpanId(dto.Source, dto.ParentId), Name = Safe(dto.Name ?? "tool", 160) ?? "tool", Kind = "execute_tool", Status = dto.Status ?? "ok", StartedAt = dto.Timestamp.UtcDateTime, DurationMs = dto.DurationMs, AttributesJson = JsonSerializer.Serialize(attrs) });
    else if (dto.Type.StartsWith("model.")) db.Spans.Add(new Span { Id = SpanId(dto.Source, dto.EventId), SessionId = dto.SessionId, ParentId = ParentSpanId(dto.Source, dto.ParentId), Name = Safe(dto.Name ?? dto.Model ?? "model", 160) ?? "model", Kind = "inference", Status = dto.Status ?? "ok", StartedAt = dto.Timestamp.UtcDateTime, DurationMs = dto.DurationMs, InputTokens = dto.InputTokens, OutputTokens = dto.OutputTokens, AttributesJson = JsonSerializer.Serialize(attrs) });
    try { await db.SaveChangesAsync(); }
    catch (DbUpdateException e) when (e.InnerException is SqliteException { SqliteErrorCode: 19, SqliteExtendedErrorCode: 2067 })
    {
        return Results.Ok(new { accepted = true, duplicate = true });
    }
    await hub.Clients.All.SendAsync("telemetry.updated", new { sessionId = dto.SessionId, eventId = dto.EventId, type = dto.Type });
    return Results.Ok(new { accepted = true, duplicate = false });
});
app.MapGet("/api/v1/sessions", async (TelemetryDb db, string? status, string? model, bool? error, DateTimeOffset? from, DateTimeOffset? to, int? page, int? pageSize) => {
    var q = db.Sessions.AsNoTracking().AsQueryable();
    if (!string.IsNullOrWhiteSpace(status)) q = q.Where(s => s.Status == status);
    if (!string.IsNullOrWhiteSpace(model)) q = q.Where(s => s.Model != null && s.Model.Contains(model));
    if (error == true) q = q.Where(s => s.Status == "error");
    var fromUtc = from?.UtcDateTime; var toUtc = to?.UtcDateTime;
    if (fromUtc.HasValue) q = q.Where(s => s.StartedAt >= fromUtc.Value); if (toUtc.HasValue) q = q.Where(s => s.StartedAt <= toUtc.Value);
    var total = await q.CountAsync(); var p = Math.Max(1,page ?? 1); var size = Math.Clamp(pageSize ?? 30,1,100);
    var rows = await q.OrderByDescending(s => s.UpdatedAt).Skip((p-1)*size).Take(size).Select(s => new { s.Id,s.Source,s.Project,s.Status,s.Model,s.StartedAt,s.EndedAt,s.UpdatedAt, SpanCount=db.Spans.Count(x=>x.SessionId==s.Id), ErrorCount=db.Events.Count(x=>x.SessionId==s.Id && x.Status=="error"), InputTokens=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(long?)x.InputTokens)??0, OutputTokens=db.Spans.Where(x=>x.SessionId==s.Id).Sum(x=>(long?)x.OutputTokens)??0 }).ToListAsync();
    return Results.Ok(new { items=rows,total,page=p,pageSize=size });
});
app.MapGet("/api/v1/sessions/{id}", async (string id, TelemetryDb db) => {
    var s=await db.Sessions.AsNoTracking().FirstOrDefaultAsync(x=>x.Id==id); if(s is null)return Results.NotFound();
    var events=await db.Events.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.Timestamp).ToListAsync(); var spans=await db.Spans.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.StartedAt).ToListAsync();
    return Results.Ok(new { session=s, spans, events, metrics=new { spanCount=spans.Count,errorCount=events.Count(x=>x.Status=="error"),inputTokens=spans.Sum(x=>x.InputTokens),outputTokens=spans.Sum(x=>x.OutputTokens),durationMs=s.EndedAt.HasValue?(long?)(s.EndedAt.Value-s.StartedAt).TotalMilliseconds:null } });
});
app.MapGet("/api/v1/traces/{id}", async (string id, TelemetryDb db) => { var s=await db.Sessions.AsNoTracking().FirstOrDefaultAsync(x=>x.Id==id); if(s is null)return Results.NotFound(); var spans=await db.Spans.AsNoTracking().Where(x=>x.SessionId==id).OrderBy(x=>x.StartedAt).ToListAsync(); var events=await db.Events.AsNoTracking().Where(x=>x.SessionId==id && !x.Type.StartsWith("tool.") && !x.Type.StartsWith("model.")).OrderBy(x=>x.Timestamp).ToListAsync(); return Results.Ok(new { traceId=s.Id,session=s,spans,unrelatedEvents=events }); });
app.Run();

static bool CryptographicEquals(string a,string b) { var x=System.Text.Encoding.UTF8.GetBytes(a);var y=System.Text.Encoding.UTF8.GetBytes(b);return x.Length==y.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(x,y); }
static string SpanId(string source,string eventId) => $"{source}:{eventId}";
static string? ParentSpanId(string source,string? parentId) => string.IsNullOrWhiteSpace(parentId) ? null : SpanId(source,parentId);
static string? Safe(string? s,int max) => string.IsNullOrWhiteSpace(s)?null:s[..Math.Min(s.Length,max)];
static Dictionary<string,string> SafeAttributes(Dictionary<string,string>? input) { var result=new Dictionary<string,string>(); if(input is null)return result; var blocked=new[]{"prompt","response","content","output","arguments","args","command","file","path","body","secret","token","api_key","key"}; foreach(var kv in input.Take(32)) { var k=kv.Key.ToLowerInvariant(); if(blocked.Any(k.Contains)) continue; result[Safe(kv.Key,100)!]=Safe(kv.Value,500)??""; } return result; }
record TelemetryEventDto(string EventId,string Source,string SessionId,DateTimeOffset Timestamp,string Type,string? Project=null,string? Status=null,long? DurationMs=null,string? Model=null,int InputTokens=0,int OutputTokens=0,string? ParentId=null,string? Name=null,Dictionary<string,string>? Attributes=null);
class TelemetryDb(DbContextOptions<TelemetryDb> options):DbContext(options) { public DbSet<Session> Sessions=>Set<Session>();public DbSet<TelemetryEvent> Events=>Set<TelemetryEvent>();public DbSet<Span> Spans=>Set<Span>(); protected override void OnModelCreating(ModelBuilder b){var utc=new ValueConverter<DateTime,DateTime>(v=>DateTime.SpecifyKind(v,DateTimeKind.Utc),v=>DateTime.SpecifyKind(v,DateTimeKind.Utc));var utcNullable=new ValueConverter<DateTime?,DateTime?>(v=>v.HasValue?DateTime.SpecifyKind(v.Value,DateTimeKind.Utc):null,v=>v.HasValue?DateTime.SpecifyKind(v.Value,DateTimeKind.Utc):null);b.Entity<TelemetryEvent>().HasIndex(x=>new{x.Source,x.EventId});b.Entity<TelemetryEvent>().Property(x=>x.Timestamp).HasConversion(utc);b.Entity<Session>().HasKey(x=>x.Id);b.Entity<Session>().Property(x=>x.StartedAt).HasConversion(utc);b.Entity<Session>().Property(x=>x.EndedAt).HasConversion(utcNullable);b.Entity<Session>().Property(x=>x.UpdatedAt).HasConversion(utc);b.Entity<Span>().HasKey(x=>x.Id);b.Entity<Span>().Property(x=>x.StartedAt).HasConversion(utc);} }
class Session { public string Id{get;set;}="";public string Source{get;set;}="";public string? Project{get;set;} public string Status{get;set;}="active";public string? Model{get;set;}public DateTime StartedAt{get;set;}public DateTime? EndedAt{get;set;}public DateTime UpdatedAt{get;set;} }
class TelemetryEvent { public long Id{get;set;}public string EventId{get;set;}="";public string Source{get;set;}="";public string SessionId{get;set;}="";public DateTime Timestamp{get;set;}public string Type{get;set;}="";public string? Status{get;set;}public long? DurationMs{get;set;}public string? Model{get;set;}public int InputTokens{get;set;}public int OutputTokens{get;set;}public string AttributesJson{get;set;}="{}"; }
class Span { public string Id{get;set;}="";public string SessionId{get;set;}="";public string? ParentId{get;set;}public string Name{get;set;}="";public string Kind{get;set;}="";public string Status{get;set;}="ok";public DateTime StartedAt{get;set;}public long? DurationMs{get;set;}public int InputTokens{get;set;}public int OutputTokens{get;set;}public string AttributesJson{get;set;}="{}"; }
class TelemetryHub:Hub { }
public partial class Program { }
