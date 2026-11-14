# Agent Behaviour — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar una vista de comportamiento que marque sesiones con bucles de herramientas, ráfagas de errores, sesiones largas o interrumpidas, con evidencia y link a la sesión.

**Architecture:** Un endpoint nuevo calcula las señales al leer desde `Sessions` y `Spans`. El dashboard agrega una vista que consume ese endpoint; no se toca el plugin ni el esquema.

**Tech Stack:** ASP.NET Core Minimal API sobre .NET 10, EF Core/SQLite, React 19 + TypeScript + Vite, xUnit.

**Spec:** `docs/superpowers/specs/2026-11-14-agent-behaviour-design.md`

## Global Constraints

- No agregar dependencias ni cambiar versiones.
- No crear tablas, columnas, migraciones ni índices.
- No tocar `agent-context/`, la base real ni la clave real.
- No modificar el contrato existente de sesiones, spans o ingesta.
- Mantener el backend en `backend/Program.cs` y el dashboard en `dashboard/src/main.tsx` + `style.css`.
- No tocar el plugin.
- Tests existentes siguen pasando; no se reduce cobertura.
- Mensajes de commit en español, con prefijo `feature:` y forma impersonal.

## Review Focus

- Una sesión sana no debe aparecer marcada.
- Una tool repetida 4 veces debe marcar `tool_loop` con evidencia correcta.
- 3 errores de tool o 2 de modelo deben marcar `error_burst`.
- 20 pasos de modelo deben marcar `long_session`.
- Una sesión `interrupted` debe marcar `interrupted`.
- La ventana de 30 días debe excluir sesiones con `StartedAt` viejo.
- “Ver sesión” debe abrir la sesión correcta en la vista existente.

---

### Task 1: Endpoint de comportamiento y señales

**Files:**
- Modify: `backend/Program.cs`
- Test: `backend.Tests/TelemetryApiTests.cs`

**Interfaces:**
- Produce: `GET /api/v1/behavior?days=7|30|90`.
- Produce: records `BehaviorSignalDto(string Kind, string Severity, string Title, string Explanation, object Evidence)` y `BehaviorSessionDto(string Id, string? Title, string? Project, string? Model, string Status, DateTime StartedAt, DateTime UpdatedAt, BehaviorSignalDto[] Signals)`.
- La respuesta tiene `windowDays`, `totals { sessions, flaggedSessions, signals }` y `sessions`.
- Sólo se devuelven sesiones con al menos una señal.
- La ventana filtra por `Session.StartedAt`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `backend.Tests/TelemetryApiTests.cs`:

```csharp
[Fact]
public async Task BehaviorFlagsRepeatedToolCalls()
{
    await Post(Fixture("created", "behavior-loop", "session.created"));
    for (var i = 0; i < 4; i++)
        await Post(Fixture($"tool-{i}", "behavior-loop", "tool.completed") with { Name = "bash", Status = "ok" });

    using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
    var session = json.RootElement.GetProperty("sessions").EnumerateArray().Single();
    var signal = session.GetProperty("signals").EnumerateArray().Single(item => item.GetProperty("kind").GetString() == "tool_loop");
    Assert.Equal(4, signal.GetProperty("evidence").GetProperty("calls").GetInt32());
    Assert.Equal(4, signal.GetProperty("evidence").GetProperty("maxConsecutive").GetInt32());
}

[Fact]
public async Task BehaviorFlagsErrorBurst()
{
    await Post(Fixture("created", "behavior-errors", "session.created"));
    for (var i = 0; i < 3; i++)
        await Post(Fixture($"error-{i}", "behavior-errors", "tool.completed") with { Name = "bash", Status = "error" });

    using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
    var signals = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals");
    Assert.Contains(signals.EnumerateArray(), item => item.GetProperty("kind").GetString() == "error_burst");
}

[Fact]
public async Task BehaviorFlagsLongSession()
{
    await Post(Fixture("created", "behavior-long", "session.created"));
    for (var i = 0; i < 20; i++)
        await Post(Fixture($"model-{i}", "behavior-long", "model.completed") with { Name = "model-a", Model = "model-a", Status = "ok" });

    using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
    var signals = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals");
    Assert.Contains(signals.EnumerateArray(), item => item.GetProperty("kind").GetString() == "long_session");
}

[Fact]
public async Task BehaviorFlagsInterruptedSession()
{
    await Post(Fixture("interrupted", "behavior-interrupted", "session.idle") with { Status = "interrupted" });

    using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
    var signals = json.RootElement.GetProperty("sessions").EnumerateArray().Single().GetProperty("signals");
    Assert.Contains(signals.EnumerateArray(), item => item.GetProperty("kind").GetString() == "interrupted");
}

[Fact]
public async Task BehaviorIgnoresHealthySession()
{
    await Post(Fixture("created", "behavior-healthy", "session.created"));
    await Post(Fixture("model", "behavior-healthy", "model.completed") with { Name = "model-a", Model = "model-a", Status = "ok" });
    await Post(Fixture("tool", "behavior-healthy", "tool.completed") with { Name = "read", Status = "ok" });

    using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior"));
    Assert.Equal(0, json.RootElement.GetProperty("totals").GetProperty("flaggedSessions").GetInt32());
    Assert.Empty(json.RootElement.GetProperty("sessions").EnumerateArray());
}

[Fact]
public async Task BehaviorFiltersByWindow()
{
    var old = DateTimeOffset.UtcNow.AddDays(-40);
    await Post(Fixture("old", "behavior-old", "session.created", old));
    await Post(Fixture("recent", "behavior-recent", "session.created"));

    using var json = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/behavior?days=30"));
    var sessions = json.RootElement.GetProperty("sessions").EnumerateArray().ToArray();
    Assert.DoesNotContain(sessions, session => session.GetProperty("id").GetString() == "behavior-old");
    Assert.Contains(sessions, session => session.GetProperty("id").GetString() == "behavior-recent");
}
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `$env:Telemetry__ApiKey='test-key'; dotnet test backend.Tests/AgentObservability.Api.Tests.csproj --filter "FullyQualifiedName~Behavior"`

Expected: FAIL con 404 en `/api/v1/behavior`.

- [ ] **Step 3: Implementar el endpoint y los records**

En `backend/Program.cs`, agregar `GET /api/v1/behavior` antes del handler de ingesta:

- Calcular `windowDays = days is 7 or 30 or 90 ? days : null` y `cutoff`.
- Consultar sesiones con `StartedAt >= cutoff` si hay ventana; ordenar por `UpdatedAt`.
- Traer los spans de esas sesiones y agruparlos por `SessionId` en memoria.
- Por sesión, separar `execute_tool` e `inference`, y calcular:
  - `tool_loop`: por nombre, `calls`, `errors` y `maxConsecutive` (racha sobre la secuencia de tools); marcar si `calls >= 4 || maxConsecutive >= 3`.
  - `error_burst`: `toolErrors >= 3 || modelErrors >= 2`.
  - `long_session`: `modelSpans.Count >= 20 || sessionSpans.Count >= 30`.
  - `interrupted`: `session.Status == "interrupted"`.
- Cada señal usa `Severity` `alert` para errores/interrupción y `warning` para bucle/sesión larga.
- Armar `BehaviorSessionDto` sólo si tiene señales; ordenar señales por severidad y tipo, y sesiones por cantidad de señales y `UpdatedAt`.
- Totales: sesiones analizadas, sesiones marcadas y suma de señales.
- Agregar los records `BehaviorSignalDto` y `BehaviorSessionDto` junto a los otros records del archivo.

- [ ] **Step 4: Correr la suite del backend**

Run: `$env:Telemetry__ApiKey='test-key'; dotnet test backend.Tests/AgentObservability.Api.Tests.csproj`

Expected: 21/21.

- [ ] **Step 5: Commit**

```bash
git add backend/Program.cs backend.Tests/TelemetryApiTests.cs
git commit -m "feature: se agrega detección de comportamiento"
```

---

### Task 2: Vista Comportamiento en el dashboard

**Files:**
- Modify: `dashboard/src/main.tsx`
- Modify: `dashboard/src/style.css`

**Interfaces:**
- Consume `GET /api/v1/behavior?days=...`.
- Tipos: `BehaviorSignal`, `BehaviorSession`, `BehaviorReport`.
- `BehaviorPage` recibe `data`, `error`, `window`, `setWindow`, `onRefresh`, `onOpenSession`.
- `onOpenSession(id)` cambia `view` a `sessions` y setea `selected`.

- [ ] **Step 1: Agregar tipos, estado y carga**

En `main.tsx`:

- Agregar los tipos del reporte.
- Estado `behavior`, `behaviorWindow` (default `'30'`), `behaviorError`.
- `loadBehavior` con `fetch('/api/v1/behavior' + (window === 'all' ? '' : '?days=' + window))`.
- `useEffect` cuando `view === 'behavior'` o cambia la ventana.
- Incluir `behavior` en el recargado de SignalR y en el intervalo de 10 segundos.
- Agregar `'behavior'` al tipo `SectionIcon` y al SVG del `SectionHeader`.

- [ ] **Step 2: Crear `BehaviorPage`**

Renderizar:

- `SectionHeader` con eyebrow “DIAGNÓSTICO”, título “Comportamiento” y descripción “Sesiones que merecen una mirada”.
- Selector 7/30/90/todo y botón Actualizar.
- Tarjetas de totales con `analytics-summary`.
- Lista de sesiones con `tool-analytics-list` y `tool-analytics-card`; cada tarjeta muestra título, proyecto, modelo, badge de estado, señales y botón **Ver sesión**.
- Cada señal muestra título y explicación; clase `signal alert` o `signal warning`.
- Estado vacío cuando no hay sesiones marcadas.

- [ ] **Step 3: Navegación y estilos**

- Agregar el botón **Comportamiento** al nav entre Herramientas y Modelos.
- En el render principal, agregar la rama `view === 'behavior'` con `BehaviorPage`.
- `onOpenSession` hace `setSelected(id); setView('sessions')`.
- Agregar estilos `.behavior-actions`, `.signal-list`, `.signal`, `.signal.alert`, `.signal.warning` sin tocar los existentes.

- [ ] **Step 4: Verificar el build**

Run: `cd dashboard; npm run build`

Expected: build correcto.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/main.tsx dashboard/src/style.css
git commit -m "feature: se agrega vista de comportamiento"
```

---

### Task 3: Verificación integral

**Files:**
- No modifica archivos.

- [ ] **Step 1: Correr todo**

```powershell
$env:Telemetry__ApiKey='test-key'
dotnet test backend.Tests/AgentObservability.Api.Tests.csproj
cd opencode-plugin; npm run typecheck; npm test
cd ../dashboard; npm run build
cd ..
git diff --check
git status --short
```

Expected: backend 21/21, plugin 11/11, build correcto, `git diff --check` limpio.

- [ ] **Step 2: Probar el endpoint con datos reales locales**

Con la API levantada y el dashboard abierto, verificar que la pestaña Comportamiento muestra las sesiones marcadas y que “Ver sesión” abre el detalle correcto. No hace falta automatizar el render.

---

## Self-Review

- **Cobertura:** las cuatro señales, la ventana, la sesión sana y el link a la sesión tienen test o verificación.
- **Esquema:** no se crean tablas, columnas ni índices; sólo se leen `Sessions` y `Spans`.
- **Contratos:** el endpoint es nuevo; no se modifica el detalle de sesión ni la ingesta.
- **Interfaces:** los nombres de campos de la respuesta coinciden entre backend, tests y dashboard.
- **Proporción:** el plan fija umbrales, nombres y aserciones; no transcribe el cuerpo completo del endpoint.
