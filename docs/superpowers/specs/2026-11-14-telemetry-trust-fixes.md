# Arreglos de confiabilidad de telemetría

## Objetivo

Corregir cuatro fallas que hoy hacen que AgentScope pueda mostrar un historial incompleto, incorrecto o accesible desde la red, sin cambiar la arquitectura ni migrar el esquema.

## Alcance

1. **Cola del plugin sin pérdida silenciosa.** Si el backend no responde, el evento no se descarta después de los reintentos. La cola tiene un límite y, si se llena, descarta el más viejo dejando un aviso explícito con el contador.
2. **Estado de sesión correcto.** `session.execution.succeeded` cierra la sesión como `completed`; `session.execution.interrupted` se distingue como `interrupted`; `session.execution.started` reabre una sesión cerrada y limpia `EndedAt`.
3. **Deduplicación atómica sin cambio de esquema.** La comprobación de duplicado y la inserción se serializan dentro del proceso de la API. No se agrega índice único ni migración.
4. **Dashboard sólo en loopback.** El script de desarrollo de Vite escucha en `127.0.0.1`, no en `0.0.0.0`.

## Fuera de alcance

- Migraciones EF, tablas nuevas, capa de servicio o reescritura del backend.
- Autenticación multiusuario o exposición remota.
- Buffer persistente en disco para la telemetría.
- Cambios en `agent-context/`.

## Criterios de aceptación

- Un evento que falla los tres intentos sigue en la cola y se reintenta después; no se pierde en silencio.
- Al superar el límite de cola se descarta el más viejo y se informa cuántos se descartaron.
- Una ejecución exitosa termina en `completed`; una interrumpida en `interrupted`; una reanudada vuelve a `active` y `EndedAt` queda nulo.
- Veinte POST concurrentes del mismo evento de sesión producen una sola fila y un solo `duplicate: false`.
- `npm run dev` en el dashboard queda escuchando en `127.0.0.1`.
- Los tests existentes y los nuevos pasan; el build del dashboard pasa.
- No se agregan dependencias ni se modifica el esquema.
