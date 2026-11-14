# Agent Observability Platform

MVP local para observar sesiones de OpenCode. API ASP.NET Core + SQLite + SignalR, dashboard React y plugin de OpenCode. Sólo guarda metadatos seleccionados; el adaptador nunca envía prompts, respuestas, argumentos de herramientas ni salidas.

## Iniciar

Requiere .NET 10, Node 22+ y PowerShell 7 para desarrollo. Para contenedores, instala Docker Compose.

En Windows, inicia ambos servicios y abre el dashboard. El script genera una clave aleatoria una sola vez y la guarda fuera del repositorio, en `%LOCALAPPDATA%\AgentObservabilityPlatform\telemetry.key`.

```powershell
.\start.ps1
opencode
```

Detén los servicios con `.\stop.ps1` desde PowerShell o `.\stop.cmd` desde CMD. La base de datos se guarda en `%LOCALAPPDATA%\AgentObservabilityPlatform\telemetry.db`; los registros están en la misma carpeta, dentro de `logs`. Si el backend no puede restaurar NuGet o npm no puede instalar, el script muestra el error en la terminal.

```powershell
$key = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:TELEMETRY_API_KEY = $key
$env:OPENCODE_OBSERVABILITY_KEY = $key
docker compose up --build
```

Abre <http://127.0.0.1:5173>. API: <http://127.0.0.1:5080/api/v1/health>. No hay claves predeterminadas; para ejecutar manualmente configura `Telemetry__ApiKey` y `OPENCODE_OBSERVABILITY_KEY` con el mismo valor.

## Instalar como aplicación

AgentScope se puede instalar como una aplicación web progresiva (PWA) desde Microsoft Edge o Chrome en Windows. Primero ejecuta `.\start.ps1`, abre `http://127.0.0.1:5173` y pulsa **Instalar aplicación**. Si el navegador no muestra el diálogo, usa su menú **Aplicaciones → Instalar AgentScope**. La aplicación instalada sigue necesitando que AgentScope esté iniciado localmente para conectarse a la API y recibir telemetría.

El acceso directo **AgentScope** del escritorio inicia `start.ps1` en segundo plano y abre la PWA instalada con su icono. Cuando se cierra la ventana de AgentScope, el lanzador detiene API y dashboard. Si movés la carpeta del proyecto, hay que actualizar el destino del acceso directo. Si no puede identificar la ventana, mantiene los servicios activos y muestra cómo detenerlos manualmente.

Para ejecutar manualmente: `dotnet run --project backend --no-launch-profile --urls http://127.0.0.1:5080` y, en `dashboard`, `npm ci && npm run dev -- --host 127.0.0.1 --port 5173`.

## Pestañas del dashboard

- **Inicio:** es la vista por defecto; resume la actividad del período con sesiones por estado, tasa de éxito, duración promedio, tokens, costos, las herramientas y los modelos más usados, y las últimas sesiones.
- **Observabilidad:** lista las sesiones con filtros y muestra el detalle del trace, las herramientas, los tokens, los errores y la evaluación manual.
- **Herramientas:** resume el uso, la duración promedio y los fallos de cada herramienta en el período elegido.
- **Comportamiento:** es un detector de sesiones que merecen una mirada: no mide “el comportamiento del agente” en abstracto, sino que marca sesiones guardadas cuando encuentra bucles de herramientas, ráfagas de errores, sesiones largas o interrumpidas, con un enlace al detalle.
- **Modelos:** muestra el consumo de tokens, la eficiencia de caché, el costo reportado por OpenCode y la cuota Go estimada por origen y modelo.
- **Comparar:** agrupa sesiones por etiqueta de tarea y compara modelo, calificación, costo, duración, tokens y herramientas usadas.

## Plugin OpenCode

El adaptador usa la API de plugins v2 de OpenCode. El puente de proyecto está en `.opencode/plugins/agent-observability.ts`; para que funcione desde otros directorios, copia `opencode-plugin/src/index.ts` a `~/.config/opencode/plugins/agent-observability.ts`. Al cargarlo en una instancia ya abierta, OpenCode puede recargar el archivo; los eventos anteriores a la carga no se reconstruyen, así que una sesión activa debe generar un evento nuevo para aparecer.

El plugin usa `OPENCODE_OBSERVABILITY_KEY` si está definida; si no, lee la clave local desde `%LOCALAPPDATA%\AgentObservabilityPlatform\telemetry.key`. Así puede capturar sesiones aunque OpenCode se haya iniciado desde otra terminal. Los eventos anteriores a la carga del plugin no se reconstruyen; una sesión ya abierta debe generar actividad nueva para aparecer.

El plugin registra sesiones, el proveedor y modelo informados por OpenCode al iniciar cada paso, y las herramientas completadas o fallidas. Correlaciona herramientas con el paso del modelo y sólo transmite metadatos seleccionados: nombres, estados, códigos de error y tokens. No serializa prompts, respuestas ni contenido/argumentos de herramientas.

El detalle distingue el costo reportado por OpenCode de la cuota Go estimada. La cuota se calcula por paso con el desglose de entrada, salida y caché y las tarifas del catálogo de modelos que OpenCode sirve localmente; si falta una tarifa, no se inventa una estimación. Es una atribución de consumo, no un cargo real ni el importe de la suscripción.

## Validación

```sh
dotnet test backend.Tests/AgentObservability.Api.Tests.csproj
cd opencode-plugin && npm ci && npm run typecheck && npm test
cd dashboard && npm ci && npm run build
```

## API

- `POST /api/v1/telemetry/events` (cabecera `X-Telemetry-Key`)
- `GET /api/v1/overview?days=7|30|90` (sin `days`, consulta todo el historial)
- `GET /api/v1/sessions?status=&model=&error=&from=&to=&page=&pageSize=`
- `GET /api/v1/sessions/{id}` y `GET /api/v1/traces/{id}`
- `GET /api/v1/analytics/tools?days=1|7|30|90` (sin `days`, consulta todo el historial)
- `GET /api/v1/analytics/models?from=&to=&source=&model=&bucket=day|week|month`
- SignalR `/hubs/telemetry`, evento `telemetry.updated`

La deduplicación usa `source + eventId`. Las vistas permiten inspeccionar spans de modelo/herramienta y eventos no correlacionados. La política de atributos usa lista de exclusión para claves sensibles.
