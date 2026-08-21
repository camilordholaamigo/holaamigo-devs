# Plan · El agente de agendamiento se compila del diagnóstico

> Sigue `docs/PROCESO.md`. Los pasos 1 y 2 están acá; el 5 está en
> `docs/adr/0024-el-agente-se-compila-del-diagnostico.md` y
> `docs/wiki/22-agente-de-agendamiento.md`.

## 1 · El problema

El diagnóstico termina en un botón que registra una **intención** de conectar
WhatsApp y le avisa a un humano por Slack. Todo lo que convierte esa intención
en un agente que agenda citas —qué vendemos, quién califica, qué objeciones
llegan, cómo se reserva, qué contesta a las preguntas de siempre— se resuelve
después, en semanas de correos y llamadas.

Y el diagnóstico **ya tiene** ese 90%: leyó el sitio, sacó la oferta, los
precios, los competidores, el ICP; el quiz sacó la meta, el tono y los límites.
Lo único que falta es que alguien lo lea hacia adentro de un agente.

Appointment setting por WhatsApp es el primer mercado. El tiempo de onboarding
es el costo de adquisición que no aparece en ninguna hoja de cálculo.

## 2 · Las alternativas

| | Qué es | Costo | Por qué no |
|---|---|---|---|
| **A · Formulario de configuración** | Después de conectar, el cliente llena una ficha larga del agente. | Bajo de construir. | Es la misma ida y vuelta de semanas, mudada al cliente. Y pregunta cosas que ya sabemos: se lee como "no leímos tu sitio". |
| **B · Un prompt generado por el modelo** | Una llamada grande que devuelve el system prompt del agente. | Muy bajo. | Contradice ADR 0007 (cifras del modelo), no se versiona, no se diffea, no se prueba. Un prompt que escribió un modelo es un prompt que nadie puede defender a las 2 a.m. |
| **C · Un playbook compilado** ✅ | El código ensambla un objeto de datos versionado; el modelo solo aporta lenguaje; una base de conocimiento en vector store aterriza las respuestas; el runtime corre sobre Responses API con herramientas reales. | El más alto: migración, compilador, runtime, banco de pruebas. | — |

**Se elige C.** El playbook es **datos, no prompt**: se le muestra al cliente,
se edita campo por campo, se versiona, se diffea y se prueba. B se descartó
porque un prompt opaco no es un producto; A porque mueve las semanas de ida y
vuelta al cliente en vez de eliminarlas.

## 3 · Qué se automatiza y qué no (§13.3)

Se automatiza **la construcción del agente** — que es lo que cuesta semanas.
NO se automatiza **la provisión del número con Meta**: esas 24-48 horas son de
Meta, no nuestras, y fingir lo contrario sería exactamente el "progreso que no
está pasando" que prohíbe ADR 0023. El agente queda listo y probable antes de
que exista el número.

## 4 · Definición de terminado

1. Un cliente que termina el diagnóstico y elige WhatsApp tiene, sin escribir
   nada, un agente con guion, calificación, objeciones, FAQ y agenda.
2. Puede hablar con él en el mismo minuto, desde el navegador.
3. Ve qué salió de su sitio y qué inferimos, y corrige lo inferido con un tap.
4. Ninguna cifra del playbook la escribió un modelo.
5. `npx tsc --noEmit`, `npm run lint`, `npm run build` y `npm test` en verde.
