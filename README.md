# Agent Observability Platform

MVP local para observar sesiones de OpenCode. API ASP.NET Core + SQLite + SignalR, dashboard React y plugin de OpenCode. Sólo guarda metadatos seleccionados; el adaptador nunca envía prompts, respuestas, argumentos de herramientas ni salidas.

## Iniciar

Requiere .NET 10, Node 22+ y PowerShell 7 para desarrollo. Para contenedores, instala Docker Compose.

En Windows, inicia ambos servicios y abre el dashboard automáticamente:

```powershell
.\start.ps1
```

Detén sólo los procesos que inició el script con `.\stop.ps1`. La base de datos se guarda en `%LOCALAPPDATA%\AgentObservabilityPlatform\telemetry.db`; los registros están en la misma carpeta, dentro de `logs`. Si el backend no puede restaurar NuGet o npm no puede instalar, el script muestra el error en la terminal.

```sh
docker compose up --build
```

Abre <http://127.0.0.1:5173>. API: <http://127.0.0.1:5080/api/v1/health>. Cambia `TELEMETRY_API_KEY` en el entorno antes de iniciar si quieres usar una clave distinta; configura la misma clave en `OPENCODE_OBSERVABILITY_KEY`.

Para ejecutar manualmente: `dotnet run --project backend --no-launch-profile --urls http://127.0.0.1:5080` y, en `dashboard`, `npm ci && npm run dev -- --host 127.0.0.1 --port 5173`.

## Plugin OpenCode

El puente de proyecto está en `.opencode/plugins/agent-observability.ts` y carga el adaptador tipado de `opencode-plugin/src/index.ts` cuando OpenCode se inicia desde este repositorio. Para usarlo globalmente, copia el adaptador a `~/.config/opencode/plugins/`. Configura estas variables en el proceso OpenCode si quieres cambiar los valores predeterminados:

```text
OPENCODE_OBSERVABILITY_URL=http://127.0.0.1:5080
OPENCODE_OBSERVABILITY_KEY=[development-key-removed]
OPENCODE_OBSERVABILITY_PROJECT=mi-proyecto
```

El plugin observa creación/fin de sesión, turnos de modelo completados y partes de herramienta completadas o fallidas. Genera IDs idempotentes y correlaciona llamadas de herramienta con el turno del modelo. Sólo serializa nombres, estados, códigos de error, tiempos y tokens; no lee ni envía el contenido de prompts, respuestas, argumentos ni salidas.

## Validación

```sh
dotnet test backend.Tests/AgentObservability.Api.Tests.csproj
cd opencode-plugin && npm ci && npm run typecheck && npm test
cd dashboard && npm ci && npm run build
```

## API

- `POST /api/v1/telemetry/events` (cabecera `X-Telemetry-Key`)
- `GET /api/v1/sessions?status=&model=&error=&from=&to=&page=&pageSize=`
- `GET /api/v1/sessions/{id}` y `GET /api/v1/traces/{id}`
- SignalR `/hubs/telemetry`, evento `telemetry.updated`

La deduplicación usa `source + eventId`. Las vistas permiten inspeccionar spans de modelo/herramienta y eventos no correlacionados. La política de atributos usa lista de exclusión para claves sensibles.
