# Agent Behaviour — diseño

## Intención

Que AgentScope responda “¿qué sesiones debería mirar?” sin que el usuario tenga que abrir el detalle de cada una. La primera versión detecta patrones observables en los datos que ya existen y los presenta como señales accionables, cada una con evidencia y un link a la sesión que la originó.

## Objetivos

- Detectar cuatro patrones: bucle de herramienta, ráfaga de errores, sesión larga y sesión interrumpida.
- Mostrar las sesiones marcadas en una vista nueva, ordenadas por cantidad de señales.
- Explicar cada señal con números concretos y permitir abrir la sesión.
- Filtrar por 7, 30, 90 días o todo el historial.
- No cambiar el esquema ni agregar dependencias.

## No objetivos

- Detección de compactaciones, delegación a subagentes o reintentos por argumentos: hoy no hay datos fiables.
- Uso relativo al límite de contexto: no se conoce el límite por modelo.
- Machine learning, scoring compuesto o alertas automáticas.
- Persistir las señales en una tabla propia.
- Cambiar el contrato de detalle de sesión.

## Enfoques considerados

**A. Calcular al leer (elegido).** El backend consulta sesiones y spans de la ventana, calcula las señales y las devuelve. La vista nueva consume ese endpoint. Sin tablas nuevas, sin backfill y sin job de fondo.

**B. Persistir señales.** Una tabla que se llena al ingestar. Lecturas más rápidas e histórico propio, pero requiere esquema nuevo, migración, backfill y más código. Para un solo usuario es overkill.

**C. Sólo panel en el detalle.** Lo más barato, pero no responde qué sesiones mirar primero. Se descarta porque el valor principal es el triage entre sesiones.

## Cómo funciona

### Señales y umbrales

- **`tool_loop`** (warning): una herramienta aparece 4 o más veces en la sesión, o 3 o más veces consecutivas dentro de la secuencia de tools. Evidencia: nombre, llamadas, máxima racha, errores.
- **`error_burst`** (alert): 3 o más tools fallidas, o 2 o más pasos de modelo fallidos. Evidencia: errores de tools y de modelo.
- **`long_session`** (warning): 20 o más pasos de modelo, o 30 o más spans totales. Evidencia: pasos y spans.
- **`interrupted`** (alert): la sesión está en estado `interrupted`. Evidencia: fecha de cierre.

Las tools consecutivas se cuentan sobre los spans de herramienta ordenados por inicio, ignorando los spans de inferencia intercalados. Los umbrales son constantes del endpoint; no se configuran en v1.

### API

`GET /api/v1/behavior?days=1|7|30|90` (sin `days`, todo el historial; un valor inválido equivale a todo, igual que la analítica existente).

Respuesta:

```json
{
  "windowDays": 30,
  "totals": { "sessions": 12, "flaggedSessions": 3, "signals": 5 },
  "sessions": [
    {
      "id": "ses_...",
      "title": "Refactor del parser",
      "project": "agent-scope",
      "model": "opencode-go/deepseek-v4.1-flash",
      "status": "completed",
      "startedAt": "2026-11-14T10:00:00Z",
      "updatedAt": "2026-11-14T10:20:00Z",
      "signals": [
        {
          "kind": "tool_loop",
          "severity": "warning",
          "title": "Bucle de herramienta: bash",
          "explanation": "bash se llamó 8 veces; 5 fallaron y la racha máxima fue 5.",
          "evidence": { "tool": "bash", "calls": 8, "maxConsecutive": 5, "errors": 5 }
        }
      ]
    }
  ]
}
```

Sólo se devuelven sesiones con al menos una señal. La ventana filtra por `StartedAt` de la sesión. Las señales se ordenan por severidad (`alert` antes que `warning`) y luego por tipo; las sesiones por cantidad de señales y luego por `UpdatedAt`.

### Dashboard

- Nueva pestaña **Comportamiento** entre Herramientas y Modelos.
- Selector de ventana 1/7/30/90/todo y botón de actualización.
- Tarjetas de totales: sesiones analizadas, sesiones marcadas, señales.
- Una tarjeta por sesión marcada con título, proyecto, modelo, estado y sus señales; cada señal muestra título y explicación.
- Botón **Ver sesión** que cambia a la vista de sesiones y selecciona esa sesión.
- Estado vacío cuando no hay señales.
- La vista se recarga con SignalR y con el polling de 10 segundos, igual que las otras analíticas.

## Restricciones

- Sin cambios de esquema, dependencias ni contratos existentes.
- El backend sigue en `backend/Program.cs`; el dashboard en `main.tsx` y `style.css`.
- No se toca el plugin: las señales salen de spans y sesiones ya persistidos.
- No se guarda contenido de prompts, respuestas ni argumentos.

## Criterios de aceptación

- Cuatro tools iguales en una sesión producen una señal `tool_loop` con `calls = 4`.
- Tres tools fallidas producen `error_burst`; dos modelos fallidos también.
- Veinte pasos de modelo producen `long_session`.
- Una sesión `interrupted` produce la señal `interrupted`.
- Una sesión sana no aparece en la respuesta.
- `days=30` excluye una sesión con `StartedAt` de hace 40 días.
- La vista Comportamiento compila y muestra las señales; “Ver sesión” abre el detalle.
- Los tests existentes y los nuevos pasan; el build del dashboard pasa.
