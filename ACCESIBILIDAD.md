# Auditoría de accesibilidad — WCAG 2.1 nivel AA

Fecha: 2026-07-16 · Fase 6 (Estabilización)

**Objetivo del FSD §6.4:**

> Conformidad objetivo WCAG 2.1 nivel AA: contraste ≥ 4.5:1 (≥ 7:1 en KDS),
> navegación completa por teclado en backoffice y POS, `:focus-visible` consistente.
> HTML semántico + atributos ARIA en componentes dinámicos.
> Alternativas accesibles a Drag & Drop.
> La información nunca se comunica solo por color.

---

## Resumen

| Criterio | Estado |
|---|---|
| Contraste ≥ 4.5:1 (≥ 7:1 en KDS) | ✅ 21/21 combinaciones — **1 fallo encontrado y corregido** |
| Navegación por teclado | ✅ |
| `:focus-visible` consistente | ✅ |
| ARIA en componentes dinámicos | ✅ 18/18 modales etiquetados |
| Alternativas al Drag & Drop | ✅ En las 3 pantallas que lo usan |
| Información no comunicada solo por color | ✅ |
| `prefers-reduced-motion` | ✅ En las 4 hojas con animación |

Reproducible con: `node scripts/contraste.mjs`

---

## 1. Contraste (1.4.3 Contraste mínimo, AA)

**Se encontró un fallo real y se corrigió.** El gris `--c-texto-tenue` (`#64748b`,
slate-500) daba **4.34:1** sobre el fondo de página — por debajo del 4.5:1 exigido.
Afectaba al texto secundario y a las cabeceras de tabla, que aparecen en casi todas las
pantallas del backoffice.

Se sustituyó por `#5d6d84`: **4.81:1** sobre el fondo y **5.27:1** sobre superficie. A
simple vista es el mismo gris; la diferencia es que ahora cumple.

Las 21 combinaciones de la paleta verificadas:

| Combinación | Ratio | Mínimo |
|---|---:|---:|
| Texto principal sobre superficie | 17.85:1 | 4.5:1 |
| Texto principal sobre fondo | 16.30:1 | 4.5:1 |
| Texto suave sobre superficie | 7.58:1 | 4.5:1 |
| **Texto tenue sobre fondo** (corregido) | **4.81:1** | 4.5:1 |
| Botón primario (blanco sobre verde) | 5.47:1 | 4.5:1 |
| Botón peligro (blanco sobre rojo) | 6.47:1 | 4.5:1 |
| Insignia éxito / alerta / error / info | 4.51–5.49:1 | 4.5:1 |
| Estados de mesa (libre/ocupada/pre-cuenta) | 4.51–5.30:1 | 4.5:1 |
| **KDS: texto sobre fondo oscuro** | **18.05:1** | 7:1 |
| **KDS: texto secundario** | **12.72:1** | 7:1 |
| **KDS: superficie de tarjeta** | **16.29:1** | 7:1 |

El KDS supera con holgura el 7:1 que pide el FSD, que es nivel AAA. Tiene sentido: se lee
a 1–2 metros, de pie y con vapor de por medio.

---

## 2. La información nunca solo por color (1.4.1 Uso del color, A)

Es el criterio más fácil de incumplir sin darse cuenta, y el que más importa aquí: un
mesero con daltonismo rojo-verde no puede distinguir una mesa libre de una ocupada si el
único indicio es el color. Cada estado del sistema lleva **texto o icono además del color**:

| Dónde | Color | Y además |
|---|---|---|
| Mesas del comandero | verde / rojo / amarillo / gris | Icono ✓ ● 🧾 ⊘ y texto en la leyenda |
| Estados de plato (KDS) | gris / azul / verde | Texto: «En espera», «Preparando», «Listo» |
| Semáforo de stock | verde / ámbar / rojo | Texto: «Normal», «Bajo mínimo», «Negativo» |
| Cronómetro del KDS | verde / ámbar / rojo | El número de minutos, siempre visible |
| Permisos sin guardar (vista 3) | fondo ámbar | Texto «sin guardar» |
| Pre-cuenta en el POS | amarillo parpadeante | Insignia «🧾 Pre-cuenta» |
| Costo de receta > 40 % | rojo | Texto «⚠ Supera el 40 % recomendado» |
| Severidad en auditoría | 🔴 🟠 ⚪ | `title`/`aria-label`: «Riesgo alto/medio/Informativo» |
| Estado de conexión | verde / ámbar / rojo | Texto «En vivo» / «Reconectando» / «Sin conexión» |
| Integridad de la auditoría | verde / rojo | Texto «Registro íntegro» / «Registro alterado» |
| Diferencia del arqueo | verde / rojo | Texto «Cuadrado» / «Sobrante» / «Faltante» |

---

## 3. Alternativas al Drag & Drop (2.1.1 Teclado, A)

El FSD lo exige explícitamente. Las tres pantallas con arrastre tienen una vía alternativa
completa; el arrastre **nunca es la única forma** de hacer algo:

| Pantalla | Arrastre | Alternativa |
|---|---|---|
| Diseñador de salón (vista 2) | Arrastrar mesas por el lienzo | Flechas del teclado con la mesa enfocada (Shift = 5 pasos), botones ↑↓←→ en el panel de propiedades, y pulsar una forma de la paleta la coloca en el centro |
| Divisor de cuentas (vista 20) | Arrastrar platos entre columnas | Botón «⇄ Mover a…» que abre un diálogo con las cuentas destino |
| Editor de menú (vista 5) | Reordenar categorías arrastrando | Botones ▲▼ en cada categoría |

*Verificado en navegador:* con la mesa enfocada, la flecha derecha la movió de 8 % a 9.57 %
(un paso de rejilla exacto) y Shift la aceleró a cinco pasos.

---

## 4. Teclado y foco (2.1.1, 2.4.3, 2.4.7)

- **`:focus-visible` global** con contorno de 3 px y `outline-offset`, definido una sola vez
  en `base.css` para que sea consistente en todo el sistema.
- **Enlace «Saltar al contenido»** al inicio de cada página, oculto hasta recibir foco.
- **Objetivos táctiles ≥ 48 px** (`--target-tactil`), y ≥ 56 px en el teclado del PIN y
  ≥ 80 px en los botones del KDS, que se pulsan con prisa.
- **Modales nativos `<dialog>`**: el navegador gestiona el foco atrapado y la tecla Escape.
- **El foco se devuelve tras repintar**: en el diseñador de salón, mover una mesa con el
  teclado repinta el lienzo, así que se restaura el foco sobre la mesa movida para no
  desorientar a quien navega sin ratón.

---

## 5. ARIA y semántica (4.1.2, 1.3.1)

- **18 de 18 modales** usan `<dialog>` nativo (que aporta `role="dialog"` y `aria-modal`
  implícitos al abrirse con `showModal()`) y **todos tienen `aria-labelledby`** apuntando a
  su título: el lector de pantalla anuncia de qué trata el modal.
- **`aria-live="polite"`** en las regiones que cambian solas: avisos flotantes, estado de
  conexión, saldo del cobro, resultado del arqueo, contador de comensales.
- **Landmarks**: `<main>`, `<header>`, `<nav>`, `<aside>` en todas las pantallas.
- **`role="tablist"`/`role="tab"`** con `aria-selected` en las pestañas.
- **`aria-current="page"`** en el enlace activo del menú.
- **`role="alert"`** en los mensajes de error de campo.
- **Todos los inputs con `<label for>`**; los botones de solo icono llevan `aria-label`.
- **Tablas con `<caption>`** (en `.solo-lectores`) y `<th scope="col">`.

---

## 6. Movimiento (2.3.3 Animación desde interacciones, AAA)

Las 4 hojas con animación respetan `prefers-reduced-motion`. Importa en concreto para:

- El **pulso verde** del plato listo en el comandero: con la preferencia activa, se
  sustituye por un contorno estático que sigue distinguiéndolo.
- El **parpadeo amarillo** de la pre-cuenta en el POS.

---

## 7. Responsivo (1.4.10 Reflujo, AA)

Ninguna pantalla exige scroll horizontal:

- El backoffice colapsa tablas a tarjetas apiladas, con la etiqueta de cada campo por
  delante del dato (`data-etiqueta`).
- El árbol de categorías se convierte en un `<select>` en móvil.
- El diseñador de salón pasa a **solo lectura con aviso** en móvil, como pide el FSD: es la
  decisión honesta, porque arrastrar mesas en una pantalla de 5″ no es usable.
- El KDS ajusta sus columnas con `auto-fill`.

---

## Pendiente

Esta auditoría es **estática y manual**: verifica la paleta, el marcado y los patrones.
Antes de producción convendría complementarla con:

1. **Lectores de pantalla reales** (NVDA en Windows, VoiceOver en iOS para el comandero).
   Ninguna herramienta automática sustituye escuchar la pantalla.
2. **axe-core o Lighthouse** en el pipeline, para detectar regresiones en cada cambio.
3. **Pruebas con el personal real** por rol, que es lo que pide el FSD §10.2.
