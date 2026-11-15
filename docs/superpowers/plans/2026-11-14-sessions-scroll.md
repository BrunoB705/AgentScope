# Lista de sesiones con scroll propio — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Acotar la altura de la lista de sesiones de la pestaña de Observabilidad para que la página deje de crecer con las filas y el panel de detalle quede siempre a la vista.

**Architecture:** Se reusa el patrón ya aplicado al timeline: un contenedor con `max-height`, scroll propio y encabezado fijo. Solo cambian el marcado del contenedor de la tabla de sesiones y una regla nueva de CSS; no se toca la API, el tamaño de página ni el resto del layout.

**Tech Stack:** React 19, TypeScript, Vite y CSS plano (sin framework de estilos, sin tests de frontend).

**Spec:** `docs/superpowers/specs/2026-11-14-sessions-scroll-design.md`

## Global Constraints

- No se agregan dependencias ni se instala ningún runner de tests para este cambio.
- `pageSize: 100` en `dashboard/src/main.tsx` no se modifica.
- No cambia la API, el orden, los filtros ni el paginado.
- El scroll del timeline (`dashboard/src/style.css:56`) no se modifica.
- Textos de interfaz en español rioplatense, solo caracteres latinos.
- El techo de la lista es `min(58vh,680px)`, idéntico al del timeline.

## Review Focus

- **Encabezado transparente al scrollear:** las filas pasan por detrás de los títulos de columna. Se espera encabezado opaco con el fondo del panel.
- **Lista corta o filtrada:** con una o dos filas el panel no debe quedar con un hueco vacío del alto máximo. Se espera que se encoja al contenido.
- **Filtros y paginación:** quedan fuera del área que scrollea. Se esperan siempre visibles.
- **Ancho angosto:** en menos de 540 px la lista debe seguir scrolleando adentro y la tabla conservar su scroll horizontal.
- **Teclado:** la región debe recibir foco y scrollearse con flechas, con outline visible.

---

### Task 1: Lista de sesiones con scroll propio y encabezado fijo

**Files:**
- Modify: `dashboard/src/main.tsx:331`
- Modify: `dashboard/src/style.css:61` (insertar después del bloque del timeline)

**Interfaces:**
- Consumes: el `div.table-wrap` que hoy envuelve la tabla de sesiones, identificado porque la tabla siguiente empieza con `<th>SESIÓN</th>` (es el único de ese branch).
- Produces: clase CSS `.sessions-table` sobre ese contenedor.

- [ ] **Step 1: Marcar el contenedor de la tabla de sesiones como región scrolleable**

En `dashboard/src/main.tsx`, dentro del branch de sesiones de la pestaña de Observabilidad, reemplazar exactamente:

```tsx
<><div className="table-wrap"><table><thead><tr><th>SESIÓN</th><th>ESTADO</th><th>MODELO</th><th>SPANS</th>
```

por:

```tsx
<><div className="table-wrap sessions-table" role="region" aria-label="Lista de sesiones" tabIndex={0}><table><thead><tr><th>SESIÓN</th><th>ESTADO</th><th>MODELO</th><th>SPANS</th>
```

El par `ESTADO`/`SPANS` es lo que distingue esta tabla de la de Inicio, que también empieza con `SESIÓN`. No tocar los otros `div.table-wrap` (Inicio y Modelos).

- [ ] **Step 2: Acotar la altura de la lista y fijar el encabezado**

En `dashboard/src/style.css`, insertar después del bloque del timeline (después de la línea que empieza con `@media(max-width:540px){.timeline{max-height:55vh`), un bloque nuevo:

```css
/* La lista de sesiones scrollea dentro de su panel, como el trace. */
.sessions-table{max-height:min(58vh,680px);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.sessions-table thead th{position:sticky;top:0;z-index:1;background:#11141a;border-bottom:1px solid #3a414c}
.sessions-table:focus-visible{outline:1px solid #315244;outline-offset:2px}
.layout{align-items:start}
@media(max-width:540px){.sessions-table{max-height:55vh}}
```

El `background` es el mismo `#11141a` del panel; sin él las filas se ven por detrás del encabezado.

- [ ] **Step 3: Compilar para descartar errores de marcado**

Run (workdir `dashboard`): `npm run build`
Expected: `tsc -b` sin errores y `vite build` termina con `✓ built in …`, sin warnings nuevos.

- [ ] **Step 4: Verificar la altura acotada y el encabezado fijo**

Con el dashboard servido (`.\start.ps1` desde la raíz del repo, o `npm run dev` en `dashboard`), abrir Observabilidad con una página llena de sesiones y:

- Comprobar que la lista scrollea adentro del panel y que la página ya no crece con cada fila.
- Scrollear la lista hasta el fondo y comprobar que el encabezado SESIÓN/ESTADO/MODELO/SPANS/INICIADA sigue visible y opaco.
- Comprobar que filtros, contador de resultados y paginación quedan visibles sin scrollear la lista.

- [ ] **Step 5: Verificar los casos de Review Focus**

- Elegir una fila del fondo: el panel de detalle sigue a la vista, sin scrollear la página.
- Filtrar por un estado que devuelva una sola fila: el panel se encoje y no queda un hueco vacío.
- Con la ventana en menos de 540 px, repetir Step 4 y comprobar que la tabla mantiene su scroll horizontal.
- Tabulá hasta la lista y comprobar que aparece el outline; con la lista enfocada, las flechas la scrollean.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/main.tsx dashboard/src/style.css docs/superpowers/plans/2026-11-14-sessions-scroll.md docs/superpowers/specs/2026-11-14-sessions-scroll-design.md
git commit -m "feature: se acorta la lista de sesiones con scroll propio"
```
