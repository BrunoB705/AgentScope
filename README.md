# Agent Observability Platform

MVP local para observar sesiones de OpenCode. API ASP.NET Core + SQLite + SignalR, dashboard React y plugin de OpenCode. Sólo guarda metadatos seleccionados; el adaptador nunca envía prompts, respuestas, argumentos de herramientas ni salidas.

## Iniciar

Requiere .NET 10 y Node 22+ para desarrollo. Para contenedores, instala Docker Compose.

```sh
docker compose up --build
```

Abre <http://localhost:5173>. API: <http://localhost:5080/api/v1/health>. Cambia `TELEMETRY_API_KEY` en el entorno antes de iniciar si quieres usar una clave distinta.

Para ejecutar localmente sin Docker: `dotnet run --project backend` y, en `dashboard`, `npm install && npm run dev`.

## Instalar plugin

Copia `opencode-plugin/src/index.ts` a `.opencode/plugins/agent-observability.ts` (o a `~/.config/opencode/plugins/`) y configura las variables de entorno del proceso OpenCode:

```text
OPENCODE_OBSERVABILITY_URL=http://127.0.0.1:5080
OPENCODE_OBSERVABILITY_KEY=[development-key-removed]
OPENCODE_OBSERVABILITY_PROJECT=mi-proyecto
```

El plugin observa eventos `session.created`, `session.idle`, `session.error`, finalizaciones de mensajes assistant y hooks de herramientas. Los hooks de herramientas de la API de plugins actual pueden variar por versión; las formas asumidas están aisladas en el adaptador.

## API

- `POST /api/v1/telemetry/events` (cabecera `X-Telemetry-Key`)
- `GET /api/v1/sessions?status=&model=&error=&from=&to=&page=&pageSize=`
- `GET /api/v1/sessions/{id}` y `GET /api/v1/traces/{id}`
- SignalR `/hubs/telemetry`, evento `telemetry.updated`

La deduplicación usa `source + eventId`. Las vistas permiten inspeccionar spans de modelo/herramienta y eventos no correlacionados. La política de atributos usa lista de exclusión para claves sensibles.
