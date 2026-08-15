# ADR 0007 · El modelo aporta lenguaje; el código aporta números

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Es la decisión más importante del producto**

## Contexto

El diagnóstico tiene dos clases de contenido:

1. **Lenguaje y juicio:** quién eres, contra quién compites de verdad, por qué
   esta fuga existe en tu negocio, qué ruta te conviene.
2. **Números:** cuánta plata al mes, cuántas reuniones, cuántos buzones, cuánto
   cuesta cada ruta.

La tentación es obvia: pedirle al modelo que devuelva todo junto. Sale en una
llamada, el prompt es más corto, y los números salen "personalizados".

## Decisión

**El modelo nunca produce una cifra que el cliente vaya a leer.**

- `lib/diagnostic/math.ts` calcula las fugas y la cuenta al revés. Aritmética
  pura, sin IA, sin dependencias de servidor.
- `config/routes.ts` calcula los costos de cada ruta desde los supuestos reales.
- El President aporta la **evidencia** de por qué cada fuga existe, el texto de
  identidad, el análisis competitivo, los ángulos y el rationale de la ruta.

En `lib/diagnostic/generate.ts` el prompt lo dice explícito: *"tú NO calculas
los montos: el motor los calcula. Tú aportas la evidencia."*

## Por qué

**1 · Se puede defender.** El cliente siempre pregunta "¿de dónde sale ese
número?". Con este diseño, la respuesta es la fórmula en pantalla y los
supuestos que él mismo puede mover. Con un número salido del modelo, la
respuesta honesta sería "lo estimó una IA", y ahí se acabó la venta.

**2 · Se recalcula en el navegador.** Como `math.ts` es TypeScript puro sin
importaciones de servidor, el **mismo módulo** que calculó en el backend corre
en `components/money-panel.tsx`. Cuando el cliente arrastra un control, el
número se mueve en el mismo frame. Una llamada al modelo por cada movimiento
sería imposible: cara, lenta, y con resultados distintos cada vez.

**3 · Es reproducible.** Dos corridas con los mismos insumos dan el mismo
número. Un modelo, no. Un diagnóstico que cambia de cifra al recargar destruye
la confianza más rápido que uno con la cifra equivocada.

**4 · Es auditable.** Cuando alguien pregunte "¿por qué 4% de reactivación?",
la respuesta está en un comentario de `config/assumptions.ts`, no perdida en un
prompt.

## Consecuencias

- Las fórmulas viven en el código y son las mismas para todos. La
  personalización entra por los **supuestos** —que salen del quiz y son
  editables—, no por la fórmula.
- Agregar un tipo de fuga es escribir una función, no ajustar un prompt.
- Si el modelo falla por completo, `fallbackDiagnosis()` arma el diagnóstico
  igual: menos texto, **mismos números**. El cliente nunca se queda sin su
  cifra. Eso es §8.3.5 hecho realidad, no una aspiración.
- El costo por diagnóstico baja: los números no gastan tokens.

## Lo que este ADR prohíbe

Cualquier PR que le pida a un modelo devolver un monto, un porcentaje o un
conteo que vaya a aparecer en pantalla. Si hace falta un número nuevo, se
escribe la fórmula.
