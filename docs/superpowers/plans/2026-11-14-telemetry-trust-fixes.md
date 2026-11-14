# Arreglos de confiabilidad de telemetría — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corregir la pérdida silenciosa de eventos, el estado incorrecto de las sesiones, la deduplicación incompleta y la exposición del dashboard en la red, sin cambiar la arquitectura ni el esquema.

**Architecture:** Se mantiene el backend Minimal API en un solo archivo, SQLite con `EnsureCreated` y el plugin de un solo módulo. La cola del plugin se encapsula en una clase pequeña y testeable; la deduplicación se resuelve con un semáforo en proceso; el estado de sesión se corrige en el mapeo y en la ingesta; el dashboard se restringe a loopback.

**Tech Stack:** ASP.NET Core Minimal API sobre .NET 10, EF Core/SQLite, React 19 + TypeScript + Vite, plugin TypeScript para OpenCode, xUnit y `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-14-telemetry-trust-fixes.md`

## Global Constraints

- No agregar dependencias ni cambiar versiones existentes.
- No crear tablas, columnas, migraciones ni índices.
- No tocar `agent-context/`, la base real ni la clave real.
- No reducir tests ni relajar gates.
- Mantener el backend en `backend/Program.cs` y el plugin en `opencode-plugin/src/index.ts`.
- Mensajes de commit en español, con prefijo `fix:` y forma impersonal.
- Responder y documentar en español rioplatense.

## Review Focus

- Backend caído más allá de los reintentos: el evento debe seguir en cola, no desaparecer.
- Cola llena durante una caída larga: debe descartar el más viejo y avisar cuántos se perdieron.
- Ráfaga concurrente del mismo evento de sesión: una sola fila y un solo `duplicate: false`.
- Ejecución interrumpida: no debe mostrarse como completada.
- Sesión reanudada después de `idle`: debe volver a `active` y no conservar `EndedAt`.
- `npm run dev`: el puerto 5173 no debe quedar escuchando en `0.0.0.0`.

---

### Task 1: Cola del plugin sin pérdida silenciosa

**Files:**
- Modify: `opencode-plugin/src/index.ts`
- Test: `opencode-plugin/src/index.test.ts`

**Interfaces:**
- Produce: `export type Telemetry = Record<string, unknown>`
- Produce: `export type DeliveryResult = 'ok' | 'retry' | 'permanent'`
- Produce: `export type TelemetryQueueOptions = { max?: number; attempts?: number; attemptDelayMs?: number; retryDelayMs?: number; signal?: AbortSignal; onDrop?: (dropped: number) => void; onPermanent?: (event: Telemetry) => void; onRetry?: (failures: number) => void }`
- Produce: `export class TelemetryQueue`
  - `constructor(send: (event: Telemetry) => Promise<DeliveryResult>, options?: TelemetryQueueOptions)`
  - `enqueue(event: Telemetry): void`
  - `flush(): Promise<void>`
  - `dispose(): void`
  - `peek(): Telemetry | undefined`
  - `get size(): number`
  - `get droppedCount(): number`
  - `get rejectedCount(): number`
- Consume en `setup`: una instancia de `TelemetryQueue` con el `fetch` actual y `controller.signal`.
- `attempts` cuenta los intentos dentro de un mismo `flush`; el timer de `retryDelayMs` es independiente y vuelve a llamar a `flush` después. `attemptDelayMs` sólo se usa entre intentos cuando `attempts > 1`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `opencode-plugin/src/index.test.ts`:

```ts
import { TelemetryQueue } from './index.ts';

test('conserva el evento pendiente cuando el envío falla', async () => {
  let attempts = 0;
  const queue = new TelemetryQueue(async () => { attempts++; return 'retry'; }, { attempts: 1, retryDelayMs: 1000 });
  queue.enqueue({ eventId: 'e1' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(queue.size, 1);
  assert.equal(queue.droppedCount, 0);
  assert.equal(attempts, 1);
  queue.dispose();
});

test('reintenta y drena cuando el colector vuelve', async () => {
  let result: 'retry' | 'ok' = 'retry';
  const queue = new TelemetryQueue(async () => result, { attempts: 1, retryDelayMs: 5 });
  queue.enqueue({ eventId: 'e2' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(queue.size, 1);
  result = 'ok';
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(queue.size, 0);
  queue.dispose();
});

test('descarta el más viejo y lo informa cuando la cola se llena', () => {
  const queue = new TelemetryQueue(() => new Promise<'ok'>(() => undefined), { max: 2 });
  queue.enqueue({ eventId: 'a' });
  queue.enqueue({ eventId: 'b' });
  queue.enqueue({ eventId: 'c' });
  assert.equal(queue.size, 2);
  assert.equal(queue.droppedCount, 1);
  assert.equal(queue.peek()?.eventId, 'b');
  queue.dispose();
});

test('descarta un rechazo permanente sin bloquear los eventos siguientes', async () => {
  const sent: unknown[] = [];
  const queue = new TelemetryQueue(async event => {
    sent.push(event.eventId);
    return event.eventId === 'bad' ? 'permanent' : 'ok';
  }, { attempts: 1 });
  queue.enqueue({ eventId: 'bad' });
  queue.enqueue({ eventId: 'good' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, ['bad', 'good']);
  assert.equal(queue.size, 0);
  assert.equal(queue.rejectedCount, 1);
  queue.dispose();
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cd opencode-plugin; npm test`

Expected: FAIL porque `TelemetryQueue` todavía no existe.

- [ ] **Step 3: Implementar `TelemetryQueue` y usarla en `setup`**

En `opencode-plugin/src/index.ts`:

- Exportar `Telemetry`, `DeliveryResult` y `TelemetryQueueOptions`.
- Implementar la cola con estas reglas: `enqueue` agrega y dispara `flush`; si `size >= max`, quita el primero, incrementa `droppedCount` y llama `onDrop`; `flush` no quita el evento si los intentos devuelven `'retry'`, programa un reintento con `retryDelayMs` y llama `onRetry` una vez por racha; si devuelve `'ok'`, quita el evento y sigue; si devuelve `'permanent'`, quita el evento, incrementa `rejectedCount`, llama `onPermanent` y sigue con el próximo; `dispose` cancela el timer.
- Reemplazar `const queue: Telemetry[]`, `flushing`, `enqueue` y `flush` de `setup` por una instancia de `TelemetryQueue`.
- El `send` de la instancia debe hacer el `fetch` actual a `/api/v1/telemetry/events` con `x-telemetry-key`, `AbortSignal.any` y timeout de 1800 ms. Devolver `'ok'` si `response.ok`; `'permanent'` si el status es 400-499 salvo 408 y 429; `'retry'` en cualquier otro caso.
- Pasar `signal: controller.signal`, `onDrop` con un `console.warn` que informe el total, `onPermanent` con un aviso que incluya el `eventId` descartado, y `onRetry` con un aviso sólo en el primer fallo de la racha.
- En el cleanup, llamar `queue.dispose()` antes de `controller.abort()`.

- [ ] **Step 4: Correr typecheck y tests**

Run: `cd opencode-plugin; npm run typecheck; npm test`

Expected: typecheck sin errores y 8 tests pasando.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/index.ts opencode-plugin/src/index.test.ts
git commit -m "fix: se evita perder eventos del plugin sin aviso"
```

---

### Task 2: Estado de sesión correcto

**Files:**
- Modify: `opencode-plugin/src/index.ts`
- Test: `opencode-plugin/src/index.test.ts`
- Modify: `backend/Program.cs`
- Test: `backend.Tests/TelemetryApiTests.cs`
- Modify: `dashboard/src/main.tsx`
- Modify: `dashboard/src/style.css`

**Interfaces:**
- `session.execution.interrupted` se mapea a `type: 'session.idle'` con `status: 'interrupted'`.
- `session.execution.succeeded` conserva su tipo y usa `status: 'completed'`.
- El backend acepta como terminales `session.idle`, `session.execution.succeeded` y `session.error`.
- `session.execution.started` deja la sesión en `active` y `EndedAt = null`.
- El dashboard agrega el filtro `interrupted` y el badge correspondiente.

- [ ] **Step 1: Escribir los tests que fallan**

En `opencode-plugin/src/index.test.ts`:

```ts
test('distingue una ejecución interrumpida de una completada', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e4', created: 5000, type: 'session.execution.interrupted', data: { sessionID: 's1' } });
  assert.equal(mapped.type, 'session.idle');
  assert.equal(mapped.status, 'interrupted');
});

test('marca la ejecución exitosa como completada', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e5', created: 6000, type: 'session.execution.succeeded', data: { sessionID: 's1' } });
  assert.equal(mapped.type, 'session.execution.succeeded');
  assert.equal(mapped.status, 'completed');
});
```

En `backend.Tests/TelemetryApiTests.cs`:

```csharp
[Fact]
public async Task SuccessfulExecutionClosesTheSession()
{
    await Post(Fixture("success", "session-success", "session.execution.succeeded") with { Status = "completed" });
    using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-success"));
    var session = detail.RootElement.GetProperty("session");
    Assert.Equal("completed", session.GetProperty("status").GetString());
    Assert.NotEqual(JsonValueKind.Null, session.GetProperty("endedAt").ValueKind);
}

[Fact]
public async Task InterruptedExecutionKeepsItsOwnStatus()
{
    await Post(Fixture("interrupted", "session-interrupted", "session.idle") with { Status = "interrupted" });
    using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-interrupted"));
    Assert.Equal("interrupted", detail.RootElement.GetProperty("session").GetProperty("status").GetString());
}

[Fact]
public async Task StartedExecutionReopensAClosedSession()
{
    await Post(Fixture("idle", "session-reopen", "session.idle", DateTimeOffset.UtcNow.AddMinutes(-1)) with { Status = "completed" });
    await Post(Fixture("start", "session-reopen", "session.execution.started", DateTimeOffset.UtcNow) with { Status = "active" });
    using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-reopen"));
    var session = detail.RootElement.GetProperty("session");
    Assert.Equal("active", session.GetProperty("status").GetString());
    Assert.Equal(JsonValueKind.Null, session.GetProperty("endedAt").ValueKind);
}
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cd opencode-plugin; npm test` y `$env:Telemetry__ApiKey='test-key'; dotnet test backend.Tests/AgentObservability.Api.Tests.csproj --filter "FullyQualifiedName~Session"`

Expected: fallan los tres tests de backend y el de interrupción del plugin.

- [ ] **Step 3: Implementar el mapeo y la ingesta**

En el plugin: cambiar el caso `session.execution.interrupted` para que devuelva `payload('session.idle', { status: 'interrupted' })`. Dejar `session.execution.succeeded` con `status: 'completed'`.

En el backend, dentro del handler de ingesta:

```csharp
if (dto.Type is "session.idle" or "session.execution.succeeded" or "session.error")
{
    session.Status = dto.Type == "session.error"
        ? "error"
        : dto.Status == "interrupted" ? "interrupted" : "completed";
    session.EndedAt = dto.Timestamp.UtcDateTime;
}
if (dto.Type == "session.execution.started")
{
    session.Status = "active";
    session.EndedAt = null;
}
```

En el dashboard, agregar la opción `interrupted` al selector de estado y el estilo `.badge.interrupted` en `dashboard/src/style.css` con color ámbar.

- [ ] **Step 4: Correr tests y build**

Run: `cd opencode-plugin; npm run typecheck; npm test`

Run: `$env:Telemetry__ApiKey='test-key'; dotnet test backend.Tests/AgentObservability.Api.Tests.csproj`

Run: `cd dashboard; npm run build`

Expected: todos los tests pasan y el build termina sin errores.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/index.ts opencode-plugin/src/index.test.ts backend/Program.cs backend.Tests/TelemetryApiTests.cs dashboard/src/main.tsx dashboard/src/style.css
git commit -m "fix: se cierra y reabre la sesión con el estado correcto"
```

---

### Task 3: Deduplicación atómica en proceso

**Files:**
- Modify: `backend/Program.cs`
- Test: `backend.Tests/TelemetryApiTests.cs`

**Interfaces:**
- Produce: `SemaphoreSlim ingestLock` local de la API, capturado por el handler de ingesta.
- La sección crítica incluye la consulta de duplicado, el alta/actualización de sesión, el alta de evento/span y `SaveChangesAsync`.
- No hay cambios de esquema.

- [ ] **Step 1: Escribir el test que falla**

```csharp
[Fact]
public async Task ConcurrentDuplicateEventsAreIdempotent()
{
    var payload = Fixture("race-1", "session-race", "session.created");
    var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => Post(payload)));
    Assert.All(responses, response => Assert.Equal(HttpStatusCode.OK, response.StatusCode));

    var duplicates = new List<bool>();
    foreach (var response in responses)
    {
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        duplicates.Add(json.RootElement.GetProperty("duplicate").GetBoolean());
    }
    Assert.Equal(1, duplicates.Count(value => !value));
    Assert.Equal(19, duplicates.Count(value => value));

    using var detail = JsonDocument.Parse(await _client.GetStringAsync("/api/v1/sessions/session-race"));
    Assert.Equal(1, detail.RootElement.GetProperty("events").GetArrayLength());
}
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `$env:Telemetry__ApiKey='test-key'; dotnet test backend.Tests/AgentObservability.Api.Tests.csproj --filter "FullyQualifiedName~ConcurrentDuplicate"`

Expected: FAIL con más de un `duplicate: false` o más de un evento. Si el `TestServer` serializa las solicitudes y pasa, el test queda como regresión y el semáforo se justifica por la carrera entre la consulta y la inserción.

- [ ] **Step 3: Implementar el semáforo**

En `backend/Program.cs`:

- Agregar `var ingestLock = new SemaphoreSlim(1, 1);` antes del mapeo del endpoint.
- Envolver desde la consulta `AnyAsync` hasta el `SaveChangesAsync` en `await ingestLock.WaitAsync(); try { ... } finally { ingestLock.Release(); }`.
- Dejar el `SendAsync` de SignalR fuera de la sección crítica.
- Mantener el `catch` de `DbUpdateException` para el caso de una PK de span duplicada.

- [ ] **Step 4: Correr los tests**

Run: `$env:Telemetry__ApiKey='test-key'; dotnet test backend.Tests/AgentObservability.Api.Tests.csproj`

Expected: todos los tests pasan, incluido el concurrente.

- [ ] **Step 5: Commit**

```bash
git add backend/Program.cs backend.Tests/TelemetryApiTests.cs
git commit -m "fix: se serializa la deduplicación de ingesta"
```

---

### Task 4: Dashboard sólo en loopback

**Files:**
- Modify: `dashboard/package.json`

**Interfaces:**
- `scripts.dev` pasa de `vite --host 0.0.0.0` a `vite --host 127.0.0.1`.
- No cambia ningún contrato de la API.

- [ ] **Step 1: Cambiar el script**

En `dashboard/package.json`, dejar:

```json
"dev": "vite --host 127.0.0.1"
```

- [ ] **Step 2: Verificar el valor y el build**

Run:

```powershell
$script = (Get-Content dashboard/package.json -Raw | ConvertFrom-Json).scripts.dev
if ($script -notmatch '127\.0\.0\.1' -or $script -match '0\.0\.0\.0') { throw "El dev server no está en loopback: $script" }
cd dashboard; npm run build
```

Expected: sin excepción y build correcto.

- [ ] **Step 3: Commit**

```bash
git add dashboard/package.json
git commit -m "fix: se restringe el dashboard a loopback"
```

---

### Task 5: Verificación integral

**Files:**
- No modifica archivos.

- [ ] **Step 1: Correr la suite completa**

```powershell
$env:Telemetry__ApiKey='test-key'
dotnet test backend.Tests/AgentObservability.Api.Tests.csproj
cd opencode-plugin; npm run typecheck; npm test
cd ../dashboard; npm run build
cd ..
git diff --check
git status --short
```

Expected: backend y plugin verdes, build del dashboard correcto, `git diff --check` sin salida y sólo los archivos previstos modificados.

- [ ] **Step 2: Reportar evidencia**

Registrar en la respuesta los comandos ejecutados y el conteo de tests. No declarar terminado sin esa salida.

---

## Self-Review

- **Cobertura:** las cuatro fallas tienen tarea y test/verificación propia.
- **Esquema:** no se agregan tablas, columnas, índices ni migraciones; la deduplicación es en proceso.
- **Interfaces:** `TelemetryQueue` se define en la tarea 1 y se usa en la tarea 1; el estado `interrupted` se define en la tarea 2 y lo consume el dashboard en la misma tarea.
- **Review Focus:** cada línea tiene un test o una verificación ejecutable en la tarea correspondiente.
- **Proporción:** el plan no transcribe los cuerpos completos; fija nombres, firmas y aserciones.
