# ADR 0006 · USD internamente, moneda local en pantalla, FX constante

- **Fecha:** 2026-08-15
- **Estado:** aceptada, con deuda declarada

## Contexto

El PRD (§7.3) pide que cada fuga muestre "un número mensual **en su moneda**".
Vendemos en Colombia primero, pero el producto es autoservicio y va a recibir
visitantes de México, Perú, Chile y Estados Unidos.

A la vez, las bandas del quiz (`ticket_band`, `rev_band`) están denominadas en
USD en el PRD, y traducirlas por país significaría mantener cinco juegos de
bandas y cinco tablas de puntos de scoring.

## Decisión

**Tres capas separadas:**

1. **Cálculo:** todo en USD. `lib/diagnostic/math.ts` no sabe qué es una moneda.
2. **Almacenamiento:** todo en USD. `diagnostics.leaks[].monthly_value_usd`,
   `recommendations.cost_infra_usd`. El nombre de la columna lo dice.
3. **Presentación:** `toCurrency(usd, org.currency)` justo antes de formatear.

`organizations.currency` se deriva del país que detecta el research, vía
`CURRENCY_BY_COUNTRY`. Default `USD`.

La tasa de cambio es una **constante** en `config/assumptions.ts`.

## Por qué una constante y no una API de FX

Porque el diagnóstico habla de **órdenes de magnitud, no de tesorería**. La
diferencia entre decir "se te están cayendo COP 18 millones al mes" y "COP 18,4
millones" no cambia ninguna decisión que el cliente vaya a tomar. Lo que sí la
cambiaría es que el número no esté, o que llegue tarde porque una API de FX se
cayó.

Sumar una dependencia externa —con su clave, su latencia, su caché y su modo de
falla— a un cálculo cuya precisión es intrínsecamente aproximada sería cambiar
robustez por una exactitud que no sirve para nada.

## La deuda, declarada

`FX_USD.COP = 4000` es un número escrito a mano. Si el peso se mueve más de un
15%, las cifras empiezan a sonar raras a un colombiano que sigue el dólar.

**Disparador de revisión:** cuando la desviación pase el 15%, o cuando un
cliente comente que el número no le cuadra. La corrección es editar una línea y
desplegar.

**Si algún día importa de verdad:** un cron diario que escriba la tasa en una
tabla `fx_rates` y una lectura con fallback a la constante. Media hora de
trabajo, el día que el negocio lo pida.

## Consecuencias

- Las bandas del quiz siguen etiquetadas en USD ("USD 500 – 2.000"). Para un
  colombiano eso es un pequeño salto mental. Es el precio de tener una sola
  tabla de bandas y una sola tabla de scoring.
- `formatMoney` usa `es-CO` para COP y `en-US` para el resto: separadores de
  miles y decimales correctos por región.
- Un cambio de moneda de la organización **no** recalcula diagnósticos
  anteriores, porque el almacenamiento es en USD. Se re-renderizan solos.
