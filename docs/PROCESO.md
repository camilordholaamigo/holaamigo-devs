# Nuestro proceso de desarrollo

Este es el proceso que seguimos en **todo** cambio de Hola Amigo, heredado de
cómo trabajamos en Rentmies. No es opcional y no se salta ningún paso, ni
cuando hay prisa. Sobre todo cuando hay prisa.

---

## Los cinco pasos

### 1 · Debatir el problema

Antes de escribir una línea, se escribe **qué problema estamos resolviendo** y
**por qué ahora**. Si no se puede escribir en tres frases, no está entendido.

Se enumeran al menos **dos alternativas reales**. "Hacerlo así o no hacerlo" no
son dos alternativas. Cada una con su costo: tiempo, dinero, deuda técnica,
riesgo operativo.

### 2 · Escoger la mejor solución

Se elige una y **se escribe por qué se descartaron las otras**. Esa frase es la
que va a servir dentro de seis meses cuando alguien pregunte "¿por qué está
hecho así?".

Si la decisión es estructural — afecta el modelo de datos, la seguridad, el
costo por transacción, o es cara de revertir — se escribe un **ADR** en
`docs/adr/`. Numerado, con fecha, con las alternativas descartadas.

### 3 · Planear

Se listan los archivos que se tocan y en qué orden. Se define qué significa
"terminado" **antes** de empezar. Un plan sin definición de terminado se
convierte en trabajo infinito.

### 4 · Ejecutar

Se construye. Se corre `npx tsc --noEmit` y `npm run build` antes de dar nada
por hecho. Nada se declara listo sin haberlo visto correr.

### 5 · Documentar

Tres lugares, siempre los tres:

| Dónde | Qué va |
|---|---|
| `docs/CHANGELOG.md` | Qué cambió, cuándo, y qué hay que hacer para que funcione (migraciones, env vars). |
| `docs/PRD.md` | Si el alcance cambió respecto a lo acordado, se actualiza. Un PRD desactualizado miente. |
| `docs/wiki/` | Cómo funciona esa parte del sistema, en prosa, para que un humano lo entienda sin leer el código. |

Y además: **comentarios en el código que expliquen decisiones, no mecánica**.

```ts
// Mal — describe lo que el código ya dice
// Iteramos sobre los leads y filtramos los suprimidos

// Bien — explica por qué está así y qué pasaría si no
// Filtramos en la aplicación y no con ON CONFLICT porque el índice único es
// sobre coalesce(email, phone) y PostgREST no puede apuntar a un índice de
// expresión. El índice queda como red de seguridad ante carreras.
```

---

## La regla que gobierna las otras

> **Nada se automatiza antes de haberse hecho tres veces a mano.** (PRD §13.3)

Por eso la conexión de WhatsApp en v1 registra una intención y alerta a un
humano en vez de correr el OAuth de Meta. Con cinco clientes fundadores,
provisionar un número a mano toma 20 minutos y nos enseña qué automatizar. Un
OAuth a medio construir toma tres días y no nos enseña nada.

---

## Estructura de la documentación

```
docs/
  PROCESO.md              ← este archivo
  PRD.md                  ← el alcance acordado, vivo
  CHANGELOG.md            ← qué cambió y qué hay que hacer para desplegarlo
  api/README.md           ← contrato de cada endpoint
  adr/                    ← decisiones estructurales, numeradas
    0001-schema-dedicado.md
    0002-sse-en-vez-de-realtime.md
    0003-rls-deny-by-default.md
    0004-cache-de-research.md
    0005-auth-admin.md
    0006-moneda.md
    0007-numeros-deterministas.md
  wiki/                   ← cómo funciona, en prosa
    00-indice.md
    01-arquitectura.md
    02-modelo-de-datos.md
    03-agentes.md
    04-motor-de-research.md
    05-quiz-adaptativo.md
    06-diagnostico-y-matematica.md
    07-leads-pipeline.md
    08-scoring-plg.md
    09-operacion-y-runbook.md
```

## Cuándo escribir un ADR y cuándo no

**Sí:** cambia el modelo de datos · cambia el modelo de seguridad · cambia el
costo por transacción · introduce una dependencia externa · es caro de
revertir · contradice algo que ya está escrito en el PRD.

**No:** renombrar una variable · agregar un endpoint que sigue un patrón que ya
existe · ajustar copy · cambiar un color.

Regla práctica: si dentro de seis meses alguien puede mirar el código y
preguntar *"¿por qué diablos está así?"*, hay que escribir el ADR.
