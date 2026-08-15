# 06 · Diagnóstico y matemática

## El reparto de trabajo

Es la decisión más importante del producto y tiene su propio ADR (0007).

> **El modelo aporta lenguaje y evidencia. El código aporta los números.**

| El modelo produce | El código produce |
|---|---|
| Las 3 frases de identidad, con fuente | Los montos de cada fuga |
| El análisis competitivo y las coordenadas | La cuenta al revés completa |
| La **evidencia** de por qué cada fuga existe | Los costos de cada ruta |
| La ruta recomendada y su rationale | Las fechas de cada roadmap |
| Los ángulos y sus openers | |

Nunca al revés. Un número que sale de un modelo no se puede defender cuando el
cliente pregunta de dónde salió — y en este producto siempre pregunta.

## De las respuestas a los supuestos

`buildAssumptions()` en `lib/diagnostic/math.ts`.

Cada banda del quiz tiene un punto medio. `dormant_db = "2k_10k"` → 5.500
contactos. `ticket_band = "500_2k"` → USD 1.200.

**Leads por mes no se pregunta: se deriva.**

```
clientes_mes = facturación_mensual ÷ ticket_promedio
leads_mes    = clientes_mes ÷ tasa_de_cierre
```

Y se acota entre 10 y 5.000, porque las bandas son gruesas y los extremos
producen cifras que nadie se cree. Un negocio que declara USD 1,5M al mes con
ticket de USD 300 daría 5.000 clientes y 27.000 leads — técnicamente correcto,
comercialmente absurdo.

**La tasa de cierre sale de la industria** (`CLOSE_RATE_BY_INDUSTRY`), detectada
por el research. Los valores están ajustados hacia abajo respecto a los
benchmarks públicos, porque los benchmarks los publica quien queda bien en
ellos. Inmobiliaria 8%, ecommerce 3%, consultoría 25%, default 18%.

## Las cuatro fugas

Todas devuelven un monto **mensual en USD**.

### 1 · La base que dejaste de tocar

```
contactos_dormidos × 4% × ticket_promedio ÷ 12
```

El `÷ 12` reparte en el año la recuperación de una base que se trabaja una vez.
El 4% viene de meta-análisis de campañas de reactivación (3–6%); usamos el
extremo bajo a propósito.

### 2 · Lo que entra cuando nadie está mirando

```
leads_mes × 35% × ticket × tasa_cierre
```

El 35% es la porción de leads que llega de noche y en fin de semana en negocios
locales de LatAm.

### 3 · Los que se abandonan antes del quinto toque

```
leads_mes × 50% × ticket × tasa_cierre
```

El clásico: la mayoría de los equipos comerciales se rinde en el segundo toque.

### 4 · El canal que nadie está atendiendo

```
leads_mes × 15% × ticket × tasa_cierre
```

**Solo si el research detectó público bilingüe o un canal desatendido.** Es la
única fuga condicional, y es lo que la hace creíble: si apareciera siempre,
sería relleno.

Se muestran entre 2 y 4, ordenadas de mayor a menor.

## La cuenta al revés

```
clientes_meta ÷ cierre_desde_reunión      = reuniones necesarias
reuniones     ÷ tasa_de_agendamiento      = contactos necesarios
contactos     ÷ semanas_disponibles       = contactos por semana
contactos_sem × toques                    = envíos por semana
envíos_sem    ÷ 125                       = buzones necesarios
```

Defaults: cierre desde reunión 25%, agendamiento 5%, 5 toques, 125 envíos
seguros por buzón por semana. Las semanas salen de `goal_deadline`: esta semana
→ 2, este mes → 4, trimestre o explorando → 12.

### Detección de metas imposibles

El President escala (§3.1) cuando:

- Hacen falta **más de 200.000 contactos**. Eso no es un problema de ejecución,
  es un problema de tamaño de mercado.
- Hacen falta **más buzones que semanas disponibles**. No se pueden calentar un
  buzón por semana y menos, así que la meta no cabe en el plazo.

Cuando pasa, se crea un `approval` de tipo `escalation` con severidad `high`, y
el diagnóstico muestra el motivo en un bloque destacado. La ruta recomendada se
fuerza a WhatsApp, que es la única que no depende de calentamiento de dominios.

## Recálculo en vivo

`lib/diagnostic/math.ts` es **TypeScript puro sin importaciones de servidor**.
Eso no es casualidad: es lo que permite que el mismo módulo corra en
`components/money-panel.tsx` dentro del navegador.

Cuando el cliente arrastra un control, `computeLeaks()` y `computeInverseMath()`
se ejecutan localmente y el número se mueve en el mismo frame. La persistencia
va por detrás con 900 ms de debounce. Si falla, el usuario no se entera: ya vio
su número.

**Lo que no puede fallar es el evento `assumption_edited`**: vale 5 puntos de
intent y es la señal más honesta que existe. Alguien que discute tu número ya se
apropió del número.

La evidencia de cada fuga **no cambia** cuando el cliente edita: cambió el
monto, no la razón por la que la fuga existe.

## Las 3 rutas

`config/routes.ts`. Los costos se calculan desde los supuestos reales del
cliente, no son precios de lista:

- **WhatsApp:** infra = conversaciones estimadas × USD 0,0125 (tarifa Meta
  marketing LatAm). Fee USD 890.
- **Correo:** infra = buzones × USD 3,50 + dominios × USD 1,20 + USD 99 de datos
  y envío. Los buzones salen de la cuenta al revés. Fee USD 1.290.
- **Marca y contenido:** infra USD 0 — es trabajo, no software. Fee USD 1.900.

**El costo va siempre separado en infraestructura y fee.** Copiamos
deliberadamente la transparencia de LetGrowth: decir "USD 180 de infra y USD 900
de fee" convierte mejor que "desde USD 1.080". El cliente ya sabe que hay costos
abajo; el que los esconde parece que esconde más cosas.

**Los roadmaps llevan fechas absolutas** calculadas desde hoy, no "semana 1".

**Los prerequisitos van visibles**, incluida la aprobación de plantillas de Meta
(24–48 h, con posibilidad de rechazo). Mejor decirlo en la tarjeta que en la
llamada de reclamo.

### La honestidad de la Ruta B

Está escrita en `cost_notes` y aparece en pantalla:

> La promesa de 24 horas NO aplica al correo en frío: sin calentamiento se
> queman los dominios y la reputación no se recupera. La reactivación de tu
> base propia desde tu dominio actual sí arranca en 24 horas.

Si prometemos 24 h en frío, quemamos dominios y reputación. Está en §4.6 del
PRD como "honestidad técnica que hay que respetar".

## Cuando el modelo falla del todo

`fallbackDiagnosis()` arma el diagnóstico con lo que el research y la aritmética
ya dan: menos texto, **mismos números**. El cliente nunca se queda sin su cifra.

Eso es §8.3.5 hecho realidad y no una aspiración: la razón por la que funciona
es precisamente que los números no dependen del modelo.
