# AgentScope

**AgentScope** es una plataforma local de observabilidad y evaluación para sesiones de **OpenCode**. Permite ver qué pasó dentro de una sesión de agente —tiempos, spans, herramientas, errores, tokens y costos— y comparar el rendimiento de distintos modelos con evidencia real.

---

## ¿Qué problema resuelve?

Trabajar con un agente de código suele ser una caja negra: cuesta saber en qué paso se fue el tiempo, qué herramienta falló, si un modelo entró en bucle o cuánto consumió realmente una tarea. AgentScope instrumenta esas sesiones de forma local y las muestra en un dashboard en tiempo real, con dos objetivos principales:

1. **Observar y diagnosticar:** reconstruir el trace completo de cada sesión para detectar cuellos de botella, ráfagas de errores o loops de herramientas.
2. **Elegir modelos con evidencia:** comparar modelos por etiqueta de tarea o ejecutar suites de prueba automatizadas midiendo tiempo, tokens, cuota estimada y corrección.

---

## Alcance y límites

- **Solo metadatos (privacidad por diseño):** el plugin nunca captura ni envía prompts, respuestas, argumentos de herramientas, contenido de archivos ni salidas de comandos. Solo registra nombres, estados, códigos de error, duraciones y conteos de tokens.
- **Local-first y uso personal:** corre en tu máquina (backend, base SQLite y dashboard en `localhost`). No está diseñado para despliegue multiusuario, cuentas ni acceso remoto.
- **Fuente actual:** pensado para sesiones de **OpenCode** mediante su API de plugins v2.
- **Cuota y tiempos sin inventos:** la cuota Go se calcula a partir del catálogo local de tarifas de OpenCode (si falta una tarifa, no se estima) y es una atribución de consumo, no un cargo real. Los spans sin duración se muestran como marcadores sin inferir tiempos.
- **Benchmarks sin sandbox estricto:** las pruebas de modelos corren en el entorno local del usuario (*best-effort*, quitando las claves internas de la plataforma del subproceso).

---

## Qué incluye el proyecto

| Componente | Tecnología | Rol |
|---|---|---|
| `backend/` | ASP.NET Core (.NET 10), SQLite, SignalR | Ingesta de eventos, almacenamiento local de sesiones/traces/spans, analítica y ejecución de benchmarks. |
| `dashboard/` | React, TypeScript, Vite (PWA) | Interfaz web en tiempo real conectada por REST y SignalR. |
| `opencode-plugin/` | TypeScript (Plugin API v2) | Adaptador que captura eventos de OpenCode y envía metadatos seleccionados al backend. |
| `telemetry-proxy/` | Node.js / TypeScript (sin deps en runtime) | Proxy HTTP local (`127.0.0.1:5081`) para capturar tráfico de apps externas que usan tu API key de OpenCode Go. |
| `benchmarks/` | Suites multi-lenguaje | Cuatro suites (`refactor-pequeno`, `csharp-dotnet`, `react-typescript`, `python-fastapi`) con pruebas de código (`code`) y abiertas con juez (`open`). |

### Vistas del dashboard

- **Inicio:** resumen del período con sesiones por estado, tasa de éxito, duración promedio, tokens, costos, herramientas/modelos más usados y últimas sesiones.
- **Observabilidad:** listado filtrable de sesiones (estado, modelo, proyecto, herramienta, rol/agente, errores y fechas) y detalle del trace con waterfall proporcional, inspección de spans, orquestación de subagentes y consumo por rol, herramientas, tokens, errores (con salto al span) y evaluación manual.
- **Herramientas:** uso, duración promedio y tasa de fallo por herramienta.
- **Comportamiento:** detector de sesiones que requieren atención (bucles de herramientas, ráfagas de errores, sesiones largas o interrumpidas).
- **Modelos:** consumo de tokens, eficiencia de caché, costo reportado por OpenCode y cuota Go estimada por origen y modelo, más subvista de **Eficiencia y valor** (latencia, tok/s, dispersión costo vs rendimiento, filtro por muestra mínima y cruce con **Pruebas**).
- **Comparar:** agrupación de sesiones por etiqueta de tarea para contrastar modelo, calificación, costo, duración, tokens y herramientas.
- **Pruebas:** ejecución de suites contra varios modelos (con verificación automática o juez ciego independiente), variantes, historial y recomendación final.

---

## Inicio rápido

### Requisitos

- **.NET 10 SDK**
- **Node.js 22.18+**
- **PowerShell 7**, **Git** y **OpenCode**
- *(Opcional)* **Docker Compose** para levantar API + dashboard en contenedores (con el worker de benchmarks desactivado).
- *(Opcional)* **Python** con `fastapi`, `httpx` y `pytest` si vas a correr la suite `python-fastapi`.

### Levantar en Windows

```powershell
.\start.ps1
opencode
```

- Dashboard: `http://127.0.0.1:5173`
- Healthcheck de la API: `http://127.0.0.1:5080/api/v1/health`
- Proxy local para apps externas (OpenCode Go): `http://127.0.0.1:5081/v1` (o `http://127.0.0.1:5081/<app>/v1`, por ejemplo `http://127.0.0.1:5081/learnharness/v1`)
- Detener servicios: `.\stop.ps1` (PowerShell) o `.\stop.cmd` (CMD).

En el primer arranque, `start.ps1` genera una clave aleatoria y guarda base de datos, clave y logs fuera del repositorio (en `%LOCALAPPDATA%\AgentObservabilityPlatform\`).

### Instalar como aplicación (PWA)

Con `.\start.ps1` corriendo, abrí `http://127.0.0.1:5173` en Microsoft Edge o Chrome y elegí **Instalar aplicación** (o **Aplicaciones → Instalar AgentScope**). El acceso directo de escritorio **AgentScope** inicia los servicios en segundo plano, abre la ventana de la PWA y los detiene al cerrarla.

### Proxy local para apps externas (LearnHarness, clientes BYOK, scripts)

Al iniciar AgentScope (desde el ícono de escritorio o con `.\start.ps1`), también se levanta automáticamente el proxy en `http://127.0.0.1:5081` apuntando por defecto a OpenCode Go (`https://opencode.ai/zen/go/v1`):

- Configurá la **Base URL** de la app externa en `http://127.0.0.1:5081/<nombre-app>/v1` (por ejemplo `http://127.0.0.1:5081/learnharness/v1`) y usá tu misma API key de OpenCode Go.
- El proxy reenvía el tráfico (incluyendo streaming SSE) sin guardar prompts ni respuestas, agrupa las llamadas por sesión (15 min de inactividad por defecto) y reporta modelo, tokens, duración y errores a AgentScope etiquetados con `<nombre-app>`.
- Variables opcionales: `AGENTSCOPE_PROXY_UPSTREAM` (default `https://opencode.ai/zen/go/v1`), `AGENTSCOPE_PROXY_PORT` (default `5081`) y `AGENTSCOPE_PROXY_SESSION_TIMEOUT_MS` (default `900000`).

### Plugin de OpenCode fuera del repositorio

El repositorio ya incluye el puente en `.opencode/plugins/agent-observability.ts`. Para capturar sesiones desde cualquier otro directorio, copiá `opencode-plugin/src/index.ts` a `~/.config/opencode/plugins/agent-observability.ts`.

### Levantar con Docker Compose

```powershell
$key = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:TELEMETRY_API_KEY = $key
$env:OPENCODE_OBSERVABILITY_KEY = $key
docker compose up --build
```

### Ejecución manual (desarrollo)

Configurá `Telemetry__ApiKey` y `OPENCODE_OBSERVABILITY_KEY` con el mismo valor, y ejecutá:

```powershell
dotnet run --project backend --no-launch-profile --urls http://127.0.0.1:5080
cd dashboard && npm ci && npm run dev -- --host 127.0.0.1 --port 5173
```

---

## Validación y tests

Antes de correr suites de benchmarks podés verificar qué prerrequisitos faltan en tu máquina con:

```powershell
powershell -File benchmarks/check-prerequisites.ps1
```

Para instalar las dependencias de la suite de Python (una sola vez por máquina):

```powershell
pip install -r benchmarks/python-fastapi/requirements.txt
```

Para correr las pruebas unitarias e integración de cada componente:

```sh
dotnet test backend.Tests/AgentObservability.Api.Tests.csproj
cd opencode-plugin && npm ci && npm run typecheck && npm test
cd telemetry-proxy && npm ci && npm run typecheck && npm test
cd dashboard && npm ci && npm test && npm run build
```

---

## Referencia técnica

Los endpoints de la API, eventos de SignalR, política de filtrado de atributos sensibles y detalles internos del plugin y benchmarks están documentados en [docs/referencia-tecnica.md](docs/referencia-tecnica.md).
