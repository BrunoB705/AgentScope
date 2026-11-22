# Referencia técnica

Detalle operativo de la API HTTP, SignalR, política de atributos, plugin de OpenCode y ejecución de benchmarks de **AgentScope**.

## API HTTP y SignalR

Todas las rutas exigen la cabecera `X-Telemetry-Key`, salvo `GET /api/v1/health`. El proxy del dashboard inyecta la clave desde `TELEMETRY_API_KEY` o desde `telemetry.key`, de modo que el navegador nunca la recibe.

No hay claves predeterminadas; para ejecutar manualmente configura `Telemetry__ApiKey` y `OPENCODE_OBSERVABILITY_KEY` con el mismo valor.

### Endpoints

- **Estado y versión**
  - `GET /api/v1/health` (público): verifica conectividad con SQLite, versión de esquema y estado del worker.
  - `GET /api/v1/version` (autenticado): versión de API, protocolo y esquema.
- **Ingesta**
  - `POST /api/v1/telemetry/events`: valida `X-Telemetry-Protocol` / `protocolVersion` y responde `426` ante desfase.
- **Resumen y sesiones**
  - `GET /api/v1/overview?days=1|7|30|90&scope=all|real|benchmarks` (sin `days`, consulta todo el historial).
  - `GET /api/v1/sessions?status=&model=&project=&tool=&search=&error=&from=&to=&page=&pageSize=&scope=all|real|benchmarks`
  - `GET /api/v1/sessions/{id}`, `DELETE /api/v1/sessions/{id}` y `GET /api/v1/traces/{id}`
  - `PUT /api/v1/sessions/{id}/review`: cuerpo `{ "rating": 1..5, "note": "texto", "taskLabel": "etiqueta" }`; normaliza la etiqueta de tarea y emite `telemetry.updated`.
- **Comparaciones y presupuestos**
  - `GET /api/v1/comparisons`: sesiones con etiqueta de tarea, agrupadas por etiqueta.
  - `GET /api/v1/budgets`, `PUT /api/v1/budgets` (cuerpo `{ "project": "…", "monthlyLimit": número, "metric": "cost"|"quota" }`) y `DELETE /api/v1/budgets?project=`
- **Analítica y comportamiento**
  - `GET /api/v1/analytics/tools?days=1|7|30|90&scope=all|real|benchmarks` (sin `days`, consulta todo el historial).
  - `GET /api/v1/analytics/models?from=&to=&source=&model=&bucket=day|week|month&scope=all|real|benchmarks`
  - `GET /api/v1/behavior?days=1|7|30|90&scope=all|real|benchmarks`
- **Exportación y retención**
  - `GET /api/v1/export?from=&to=&scope=all|real|benchmarks`: exporta sesiones, spans y eventos filtrados en JSON Lines.
  - `DELETE /api/v1/data?before=<ISO>&dryRun=true|false`: purga sesiones anteriores a `before` (también configurable al arranque mediante `Telemetry:RetentionDays`).
- **Benchmarks**
  - `GET /api/v1/benchmarks/suites` y `GET /api/v1/benchmarks/models`
  - `POST /api/v1/benchmarks/runs`, `GET /api/v1/benchmarks/runs?suite=&page=&pageSize=` y `GET /api/v1/benchmarks/runs/{id}`
  - `POST /api/v1/benchmarks/runs/{id}/cancel` y `DELETE /api/v1/benchmarks/runs/{id}`
- **Tiempo real**
  - SignalR `/hubs/telemetry`, eventos `telemetry.updated` y `benchmark.updated`.

---

## Deduplicación, orígenes y política de privacidad

- **Deduplicación**: usa `source + eventId`.
- **Conflictos de origen**: una sesión conserva el `source` de su primer evento. Si llega un evento de otro origen con el mismo `sessionId`, se guarda con su propio origen, se registra una advertencia en el log y el detalle informa `quality.sourceConflictEvents` (la traza pasa a parcial).
- **Política de atributos libres** (`backend/AttributePolicy.cs`):
  - Separa cada clave en tokens (puntuación, camelCase y cambios letra/dígito) y la descarta si algún token coincide exactamente con un término sensible (`prompt`, `response`, `content`, `output`, `args`, `command`, `file`, `filename`, `path`, `body`, `secret`, `token`, `key`, `apikey`, `password`, `authorization`, `cookie`, entre otros). Así se bloquean `filePath` o `api_key`, pero no `profile` ni `compassion`.
  - Se guardan como máximo 32 claves; si se recorta, el evento conserva `attributes_truncated: "true"` y `attributes_dropped` con la cantidad descartada.

---

## Detalles del plugin de OpenCode

- Usa la API de plugins v2 de OpenCode. El puente de proyecto está en `.opencode/plugins/agent-observability.ts`; para uso global en otros directorios, se copia `opencode-plugin/src/index.ts` a `~/.config/opencode/plugins/agent-observability.ts`.
- Usa `OPENCODE_OBSERVABILITY_KEY` si está definida; si no, lee la clave local desde `%LOCALAPPDATA%\AgentObservabilityPlatform\telemetry.key`.
- Los eventos anteriores a la carga del plugin no se reconstruyen; una sesión ya abierta debe generar actividad nueva para aparecer.
- Registra sesiones, proveedor y modelo informados por OpenCode al iniciar cada paso, y herramientas completadas o fallidas. Correlaciona herramientas con el paso del modelo y sólo transmite metadatos seleccionados (nombres, estados, códigos de error y tokens).
- El título de la sesión llega por el evento `session.renamed`. Como respaldo, si una sesión todavía no tiene título, el plugin lo consulta a OpenCode hasta cuatro veces con espera creciente (inmediato, 30 s, 2 min y 10 min) y deja de consultar en cuanto lo conoce.
- El waterfall usa las duraciones reportadas por OpenCode; los spans sin duración se muestran como marcadores y no se infieren tiempos.
- La cuota Go estimada se calcula por paso con el desglose de entrada, salida y caché y las tarifas del catálogo de modelos que OpenCode sirve localmente; si falta una tarifa, no se inventa una estimación.

---

## Detalles de ejecución de benchmarks

- Cada prueba es de tipo `code` (copia un fixture a un directorio temporal, pide al modelo que lo modifique y ejecuta `verify` para obtener pass/fail) u `open` (sin repositorio; un juez aparte evalúa la respuesta con la rúbrica de la prueba).
- El juez se elige por separado y no puede ser uno de los modelos evaluados. Corre a ciegas, con `--archived`, y devuelve una nota de 1 a 5 con una justificación breve. Las respuestas de los modelos no se guardan: sólo métricas, pass/fail, nota y justificación.
- Si se activa la recomendación final, una llamada extra al mismo juez sugiere qué modelo conviene para la suite.
- Las corridas usan la telemetría existente para tokens y costo y quedan como sesiones normales con proyecto `benchmark` o `benchmark-judge`. El tráfico se separa en el dashboard con el selector de alcance (`Todo el tráfico`, `Trabajo real`, `Solo pruebas`). Al eliminar una corrida terminada se eliminan también sus sesiones y deja de contar como uso real.
- **Contención y entorno**:
  - La contención es *best-effort*: el proceso corre con tu usuario y `--auto`, sin sandbox.
  - Se quitan del entorno de los subprocesos las claves de la propia plataforma (`TELEMETRY_API_KEY`, `Telemetry__ApiKey`, `ConnectionStrings__Telemetry`, `OPENCODE_OBSERVABILITY_KEY`, `OPENCODE_OBSERVABILITY_URL`), se entrega la de telemetría sólo a los procesos de OpenCode y se validan rutas temporales.
  - Las credenciales de otros proveedores que tengas exportadas en la sesión sí llegan al subproceso: no las dejes activas mientras corrés pruebas.
  - En Docker, el worker de benchmarks está desactivado (`Benchmarks__WorkerEnabled=false`) y `./benchmarks` se monta en solo lectura.

---

## Almacenamiento local en Windows

- `start.ps1` genera una clave aleatoria una sola vez en `%LOCALAPPDATA%\AgentObservabilityPlatform\telemetry.key` y en cada arranque restringe sus permisos con `icacls` a la cuenta actual (sin herencia).
- La base SQLite se guarda en `%LOCALAPPDATA%\AgentObservabilityPlatform\telemetry.db` y los registros en `%LOCALAPPDATA%\AgentObservabilityPlatform\logs`.
