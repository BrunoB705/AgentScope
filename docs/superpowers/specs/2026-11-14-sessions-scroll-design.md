# Lista de sesiones con scroll propio

## Intención

En la pestaña de Observabilidad el panel de sesiones pide hasta 100 filas
(`dashboard/src/main.tsx:164`) y `.table-wrap` no tiene altura máxima
(`dashboard/src/style.css:3`), así que la página crece con cada fila. Eso produce
dos molestias: hay que scrollear la página entera para llegar a una sesión vieja,
y al elegir una sesión del fondo hay que volver a subir para ver su trace en el
panel derecho.

El trace ya resolvió el mismo problema con scroll propio y techo de altura
(`dashboard/src/style.css:56`). Este cambio aplica ese patrón a la lista.

## Objetivos

- La altura de la página de Observabilidad deja de depender de la cantidad de
  sesiones.
- El panel de detalle sigue visible al elegir cualquier fila.
- Filtros, contador de resultados y paginación quedan visibles sin scrollear la
  lista.

## Fuera de alcance

- La API y el tamaño de página (`pageSize: 100`) no cambian.
- No cambian el orden, los filtros ni el paginado.
- No se modifica el scroll del trace.
- No se rediseña el layout general ni las demás pestañas.

## Alternativas consideradas

- **Reducir `pageSize` a 25**: una línea, pero la página sigue creciendo y el
  detalle sigue quedando arriba. No resuelve ninguna de las dos molestias.
- **Observabilidad a pantalla fija** con header y métricas quietos: resuelve lo
  mismo con más cirugía y deja esta pestaña con un ritmo distinto al de las
  demás.
- **Elegida**: altura acotada con scroll propio en la lista, reusando el patrón
  del timeline. No agrega dependencias ni virtualización.

## Diseño

- `main.tsx`: el contenedor de la tabla de sesiones conserva `div.table-wrap` y
  suma la clase `sessions-table`, más `role="region"`,
  `aria-label="Lista de sesiones"` y `tabIndex={0}` para poder scrollearla con
  teclado, igual que el timeline.
- `style.css`:
  - `.sessions-table` con `max-height:min(58vh,680px)`,
    `overflow-y:auto`, `overscroll-behavior:contain` y
    `scrollbar-gutter:stable`, el mismo techo que `.timeline` para que las dos
    columnas se vean parejas.
  - Encabezado fijo: `.sessions-table thead th` con `position:sticky`, `top:0`,
    `z-index:1` y el fondo del panel.
  - `.sessions-table:focus-visible` con el mismo outline que `.timeline`.
  - `.layout` con `align-items:start` para que el panel de sesiones no se estire
    a la altura del detalle.
  - En el breakpoint angosto, `max-height:55vh`.
- Filtros y paginación quedan fuera del contenedor que scrollea.

## Criterios de aceptación

- Con 5 o con 100 sesiones, la altura del documento es la misma y no depende de
  la cantidad de filas.
- La lista scrollea dentro de un área de `min(58vh,680px)`.
- Con la lista scrolleada hasta el fondo, el encabezado
  SESIÓN/ESTADO/MODELO/SPANS/INICIADA sigue visible.
- Al elegir una fila del fondo, el panel de detalle sigue a la vista sin
  scrollear la página.
- Filtros, contador de resultados y botones Anterior/Siguiente quedan visibles
  sin scrollear la lista.
- El scroll del timeline no cambia.
- `npm run build` en `dashboard/` pasa.

## Verificación

Build del dashboard más revisión visual del usuario en la pestaña de
Observabilidad. El dashboard no tiene suite de tests, así que la verificación
visual es el control del comportamiento.
