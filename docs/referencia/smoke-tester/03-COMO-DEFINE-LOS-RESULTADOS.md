# 03 · Cómo define los resultados

Un smoke test conversacional no tiene un `assert` obvio. La conversación
terminó… ¿y? El sistema responde con **tres capas independientes**, de la más
barata a la más cara:

| Capa | Qué contesta | Cómo | Costo | Determinístico |
|---|---|---|---|---|
| **1 · Estado terminal** | ¿Llegó al final? | Máquina de estados | 0 | Sí |
| **2 · Auditoría por pasos** | ¿Siguió el protocolo? | Regex sobre la transcripción | 0 | Sí |
| **3 · Evaluación LLM** | ¿Estuvo bien hecho? | Claude califica 0-100 | ~USD 0,02 | No |

Las tres son opcionales entre sí. La 1 es obligatoria; con la 1 sola ya tenés
un smoke test útil.

---

## Capa 1 · El estado terminal

La pregunta más importante: **¿la conversación llegó al final o se murió por
el camino?** El resultado son dos campos.

### `status` — la salud técnica de la corrida

| `status` | Significa |
|---|---|
| `completed` | La conversación corrió hasta un final, cualquiera que sea |
| `timeout` | El agente dejó de responder |
| `failed` | Falló el transporte o el motor (no es culpa del agente) |
| `cancelled` | Alguien la paró, o la reemplazó una corrida nueva |

### `closed_with` — el veredicto de negocio

| `closed_with` | Significa |
|---|---|
| `agendado` | El agente emitió `#agendado`: hay cita |
| `cotizacion` | El agente emitió `#cotizacion`: hay cotización |
| `incomplete` | Se acabaron los turnos sin llegar a un cierre |
| `timeout` | El agente se quedó mudo |
| `null` | El comprador dio el objetivo por cumplido sin etiqueta (el motivo queda en `form_data.motivo_cierre`) |

### La tabla de decisión completa

| Condición | `status` | `closed_with` |
|---|---|---|
| `#agendado` / `#cotizacion` en la respuesta | `completed` | `agendado` / `cotizacion` |
| El comprador da el objetivo por cumplido | `completed` | `null` |
| Se agotaron los turnos (default 14) | `completed` | `incomplete` |
| El agente no responde en 8 min | `timeout` | `timeout` |
| Falla el envío por el transporte | `failed` | `null` |

**Toda condición es terminal y toda condición escribe.** Ésta es la propiedad
de diseño más importante de la capa: no existe un camino que deje el run
abierto. Si existiera, ese camino se convierte en un run zombi, y un run zombi
envenena la correlación de todos los que vienen después.

### El detector de etiquetas

```ts
export function detectTerminalTag(text: string): ClosedWith | null {
  const t = text.toLowerCase()
  if (t.includes('#agendado')) return 'agendado'
  if (t.includes('#cotizacion') || t.includes('#cotización')) return 'cotizacion'
  return null
}
```

Trivial, y es el corazón del veredicto. Dos cosas que aprendimos:

- **Acepta la variante con tilde.** El agente escribe en español y a veces
  acentúa. Una etiqueta que no matchea por una tilde es un cierre perdido.
- **La detección corre sobre el BLOQUE completo del agente**, no sobre el
  último mensaje. En una ráfaga de 4 chunks la etiqueta suele venir en el
  primero o el segundo, no en el último.

> **Si portás esto:** definí las etiquetas de cierre de tu dominio antes de
> escribir una línea de código. Son el contrato entre el agente y el arnés, y
> —no por casualidad— también entre el agente y tu CRM. Si tu agente todavía
> no emite etiquetas, agregárselas es probablemente el cambio de mayor
> retorno que podés hacerle.

---

## Capa 2 · La auditoría determinística por pasos

**Archivo:** `codigo/lib/smoke-tester/prodesa-auditor.ts` · 100 % regex, cero
llamadas a LLM.

### La idea

Muchos agentes de negocio siguen un **protocolo**: pasos obligatorios, cosas
prohibidas, un orden. Eso no se evalúa con un LLM — se verifica con reglas.

El caso real tiene 10 pasos:

```
 1. Bienvenida + info + #ID + CTA "¿buscás en X?"
 2. Info del proyecto + #ID + CTA presupuesto
 3. Subtipos separados por BREAK + #ID por subtipo + CTA dual
 4. Respuesta empática al tipo elegido
 5. Subsidio (SOLO si es VIS)          ← rama condicional
 6. Reporte en centrales de riesgo     ← obligatorio
 7. Ingreso mensual                    ← obligatorio
 8. Ahorros / cesantías                ← obligatorio
 9. Oferta de cotización
10. Cierre con #agendado o #cotizacion
```

### Cómo mapea la conversación a pasos

El truco está en cómo se corta la transcripción:

```
conversación = [agente_apertura, comprador_1, agente_bloque_1,
                comprador_2, agente_bloque_2, …]

bloque[0] = todo lo que dijo el agente ANTES del primer mensaje del comprador
bloque[i] = todo lo que dijo el agente ENTRE comprador[i] y comprador[i+1]
```

Los chunks de una ráfaga se concatenan con doble salto de línea: **una ráfaga
de 5 mensajes es UN bloque lógico**. Después los bloques se mapean a pasos por
posición, con la rama condicional resuelta antes:

```ts
const stepOrder = isVIS
  ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]   // con subsidio
  : [1, 2, 3, 4,    6, 7, 8, 9, 10]   // sin subsidio: el paso 5 no aplica
```

Esto lo hace robusto a las tres cosas que rompen un auditor ingenuo:
ramificaciones del flujo, ráfagas multi-mensaje, y pasos faltantes (el mapeo
se corre, no se descuadra).

### Errores críticos vs. advertencias

Cada paso devuelve dos listas, y la diferencia es de negocio, no técnica:

```ts
// CRÍTICO — invalida el paso
if (menciona_marca_prohibida) critical.push('Menciona "Mi Casa Ya" (PROHIBIDO)')
if (!tiene_id)                critical.push('Falta #ID válido de la Ciudadela')
if (!tiene_cta)               critical.push('CTA del Paso 1 ausente')

// ADVERTENCIA — el paso pasa, pero hay que mirarlo
if (menciona_subtipos)        warnings.push('Menciona subtipos prematuramente')
if (palabras > 85)            warnings.push(`Excede 85 palabras (${palabras})`)
```

**Crítico = el agente hizo algo que no puede hacer** (mencionar una marca
prohibida por contrato, saltarse una pregunta obligatoria de riesgo, cerrar
sin etiqueta). **Advertencia = lo hizo distinto de lo pedido** (se adelantó,
se pasó de largo, repitió un ID).

Un crítico es un incidente. Diez advertencias son una conversación mejorable.
Mezclarlos en un solo número te deja sin poder distinguirlos.

### La nota

```ts
score = round(pasos_pasados / total_pasos * 100)
      - criticos  * 10
      - warnings  * 3
score = clamp(score, 0, 100)
```

Cruda a propósito y fácil de explicarle a un cliente: *"7 de 10 pasos, 1 error
crítico, 2 advertencias → 70 − 10 − 6 = 54"*.

### Verificación transversal

Además de los pasos, hay chequeos que barren **toda** la conversación:

```ts
function checkSevenQuestionsCompleted(blocks) {
  const todo = blocks.join(' ').toLowerCase()
  const checks = [
    /ciudad|en (bogot|soach|medell|cali)/.test(todo),
    /presupuesto/.test(todo),
    /\btipo\b|\bvivir\b|\binvertir\b/.test(todo),
    /pago|cr[eé]dito|contado|hipotecari/.test(todo),
    /centrales de riesgo|datacr[eé]dito|reportad/.test(todo),
    /ingreso/.test(todo),
    /ahorros?|cesant[ií]as/.test(todo),
  ]
  return checks.filter(Boolean).length >= 6   // se tolera 1 faltante
}
```

El `>= 6` es deliberado: **un auditor que exige perfección se ignora a la
semana**. La tolerancia es lo que mantiene la señal utilizable.

### Cómo portarlo

Lo que se conserva es la **estructura**, no los pasos:

```ts
function auditarPasoN(text: string, ctx: TuContexto): StepAudit {
  const tiene_x = /regex/i.test(text)
  const critical: string[] = []
  const warnings: string[] = []

  if (!text)     critical.push('Paso N ausente')
  else {
    if (!tiene_x)          critical.push('Falta X')
    if (dice_prohibido)    critical.push('Dijo algo prohibido')
    if (se_adelanto)       warnings.push('Se adelantó')
  }

  return {
    step: N,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: { tiene_x, /* … booleanos para la UI */ },
  }
}
```

El campo `validations` es un mapa de booleanos que la UI pinta como
✓/✗ por paso. Es lo que convierte "score 54" en algo accionable.

---

## Capa 3 · La evaluación con LLM

**Archivo:** `codigo/lib/smoke-tester/evaluator.ts` · Claude Sonnet, ~USD 0,02
por conversación.

### Qué mide

| Dimensión | 0-100 | Pregunta |
|---|---|---|
| `accuracy` | ↑ mejor | ¿Los datos que dijo son correctos **según la ficha**? |
| `tone` | ↑ mejor | ¿Profesional, amable, apropiado para el mercado? |
| `completeness` | ↑ mejor | ¿Respondió cada pregunta completa? |
| `proactivity` | ↑ mejor | ¿Ofreció información relevante sin que se la pidieran? |
| `hallucination_risk` | ↑ mejor | 100 = no inventó nada, 0 = todo inventado |

Y tres listas, que son lo que de verdad se lee:

- `hallucinations[]` — **cita textual** de cada dato inventado;
- `errors[]` — problemas concretos;
- `suggestions[]` — **cómo ajustar la ficha o el prompt del agente**.

`suggestions` es el output con más valor de las tres capas: convierte una nota
en una tarea.

### Por qué necesita la ficha técnica

El prompt del evaluador recibe tres cosas:

```
DATOS REALES DEL PROYECTO "{proyecto}":
{ficha_tecnica}              ← la verdad de referencia

INSTRUCCIONES DEL AGENTE:
{instrucciones}              ← lo que se le pidió al agente

[la transcripción]
```

**Sin `ficha_tecnica`, `accuracy` y `hallucination_risk` no significan nada** —
el evaluador no tiene contra qué comparar. Puede juzgar tono y completitud, y
nada más. Si vas a portar solo una cosa de esta capa, portá la disciplina de
tener una verdad de referencia por escenario.

Y `instrucciones` importa igual: sin ellas el evaluador califica contra su
propia idea de cómo debería comportarse un asesor, no contra la tuya.

### Robustez del parseo

Los LLM devuelven JSON envuelto en explicaciones o en fences. El evaluador lo
asume:

```ts
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const first = raw.indexOf('{')       // fallback: del primer { al último }
  const last  = raw.lastIndexOf('}')
  if (first >= 0 && last > first) return raw.slice(first, last + 1)
  return raw
}
```

Y todo número pasa por `clamp(0, 100)` con default, y toda lista por
`ensureArray()` (filtra no-strings, corta en 50). **Nunca confíes en la forma
de lo que devuelve un LLM, aunque se lo hayas pedido.**

### La agregación por corrida

`aggregateRunSummary()` promedia y cuenta frecuencias:

```json
{
  "average_score": 78,
  "total": 5,
  "evaluated": 5,
  "common_errors":      ["No mencionó el parqueadero", "…"],
  "common_suggestions": ["Agregar el área construida a la ficha", "…"],
  "top_hallucinations": ["Dijo que entrega en 2027", "…"]
}
```

Lo valioso es el **conteo por frecuencia**: un error que aparece en 5 de 5
conversaciones es un problema del prompt o de la ficha. Uno que aparece 1 de 5
es ruido del modelo. Sin esa distinción no sabés dónde intervenir.

### Limitaciones honestas

- **No es determinístico.** La misma conversación puede sacar 74 y 79. Sirve
  para tendencias entre corridas, no como criterio de aprobado/reprobado.
- **Hoy es un botón aparte**, no se dispara al cerrar. Deuda conocida.
- **Necesita `ANTHROPIC_API_KEY`.** Sin ella lanza; las capas 1 y 2 siguen
  funcionando (el arnés no depende de ella).

---

## Cómo se ven juntas

Una conversación cerrada devuelve algo así:

```
Run 8f3a… · Proyecto Mirasol · Flujo completo
├── status:       completed
├── closed_with:  agendado                       ← Capa 1: llegó al final
├── turnos:       9 de 14
├── mensajes:     27 (12 comprador / 15 agente)
│
├── Auditoría (Capa 2) ......................... 78/100
│   ├── pasos superados:   8/10
│   ├── críticos:          1  → "Paso 6 ausente: no preguntó por centrales"
│   └── advertencias:      3  → "Excede 85 palabras (112)", …
│
└── Evaluación (Capa 3) ........................ 82/100
    ├── accuracy 85 · tone 95 · completeness 78 · proactivity 70 · halluc. 90
    ├── alucinaciones: ["Dijo que la entrega es en 2027"]   ← la ficha dice 2028
    └── sugerencias:   ["Agregar fecha de entrega a la ficha", …]
```

**Cómo leerlo, en orden:**

1. `closed_with` — si no es `agendado`/`cotizacion`, nada más importa: el
   agente no cierra.
2. Errores **críticos** de la capa 2 — son incumplimientos de protocolo, y son
   objetivos: no hay discusión posible.
3. `hallucinations` de la capa 3 — cada una es un dato que hay que corregir en
   la ficha o prohibir en el prompt.
4. Las notas numéricas — **al final, y solo para comparar corridas entre sí.**
   Un 82 aislado no significa nada; un 82 que la semana pasada era 91 sí.
