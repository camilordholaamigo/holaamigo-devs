# 07 · Pipeline de leads

## Qué sostiene esto

La promesa de "en 1 día empiezas a tener leads nuevos". Es el atajo de valor:
el camino de menor fricción y mayor valor inmediato, y por eso el skip de la
conexión de canal lleva directo aquí.

## El pipeline

```
parsear → mapear columnas → normalizar → validar → deduplicar →
segmentar por temperatura → verificar supresión → insertar
```

## 1 · Parseo

`parseDelimited()` para CSV/TSV/pegado (Papa Parse con autodetección de
delimitador — los CSV exportados de Excel en Colombia usan `;`).
`parseXlsx()` para Excel, con `read-excel-file`.

**Detección de encabezados:** si la primera fila contiene algo que parece un
dato —un `@` o un número de 8+ dígitos— se asume que **no hay encabezados** y se
generan `columna_1`, `columna_2`. Esto pasa más seguido de lo que uno espera con
exportaciones de WhatsApp.

Tope: 50.000 filas, 25 MB.

## 2 · Mapeo de columnas

Dos pasos, en este orden:

**Primero el diccionario.** `DICTIONARY` cubre los nombres reales que manda la
gente: `nombre`, `Nombre completo`, `NOMBRE Y APELLIDO`, `contacto`, `cliente`,
`correo`, `e-mail`, `celular`, `móvil`, `whatsapp`… Compara normalizando tildes
y mayúsculas, primero por igualdad y después por inclusión.

**Si el diccionario encontró correo o teléfono, ahí termina.** No gastamos una
llamada al modelo cuando ya sabemos la respuesta. Es la mayoría de los casos.

**Si no, entra el modelo** con los encabezados y 8 filas de muestra. Devuelve el
mapeo y el país detectado desde el formato de los teléfonos.

**Validación de la salida:** si el modelo devuelve un nombre de columna que no
existe en el archivo, se pone en `null`. Es un error que comete, y sin esta
verificación produce un mapeo que apunta a la nada.

El usuario siempre puede corregir el mapeo en pantalla y recalcular.

## 3 · Normalización de teléfonos

`libphonenumber-js` con el país detectado como default. Salida en E.164.

**Rescate colombiano:** 10 dígitos que empiezan en 3, escritos sin indicativo
(`3001234567`). libphonenumber los rechaza sin contexto de país, pero es
exactamente cómo escribe todo el mundo su celular en Colombia. La regla
explícita los convierte a `+57…`.

## 4 · Validación

Un contacto necesita **correo válido o teléfono usable**. Sin uno de los dos, no
hay a quién escribirle: cuenta como inválido y no entra.

## 5 · Deduplicación

**Dentro del archivo:** por `email ?? phone_e164`.

**Contra la base:** se leen las claves existentes de la organización (paginado
de 1.000) y se filtran las repetidas antes de insertar.

Por qué en la aplicación y no con `ON CONFLICT`: el índice único es sobre
`coalesce(email, phone_e164)`, una **expresión**, y PostgREST no puede apuntar
un `ON CONFLICT` a un índice de expresión. El índice queda como red de seguridad
ante carreras, no como mecanismo principal.

Consecuencia práctica para el usuario: **puede subir el mismo archivo dos veces
sin miedo**. Está dicho así en el panel.

## 6 · Segmentación por temperatura

Desde `last_interaction_at`:

| Temperatura | Antigüedad | Segmento propuesto |
|---|---|---|
| `hot` | < 30 días | `reactivacion_inmediata` |
| `warm` | 1 a 4 meses | `reactivacion_suave` |
| `cold` | 4 meses a año y medio | `reactivacion_larga` |
| `dead` | > año y medio | `reengagement_final` |

Sin fecha de última interacción → `cold`.

**Parseo de fechas:** `dd/mm/yyyy` se fuerza explícitamente, porque `new Date()`
lo lee como `mm/dd` y convertiría el 3 de julio en el 7 de marzo. Es el formato
por defecto de Excel en español.

## 7 · Supresión

Antes de insertar, se cruzan correos y teléfonos contra `suppressions` de esa
organización. Los que estén ahí **no entran**, aunque vengan en el archivo.

La lista de supresión se alimenta sola:

| Origen | Motivo |
|---|---|
| Respuesta con intención `opt_out` en WhatsApp | `opt_out` |
| Rebote duro de correo | `bounce` |
| Queja de spam | `complaint` |
| Manual desde el admin | `manual` |

`suppressed` es un estado terminal en `leads`. Nunca se sale de ahí
automáticamente.

## La base legal — la línea que no se cruza

**Sin la declaración de base legal, no se procesa el archivo.** No es un
formalismo:

- **Colombia:** Habeas Data (Ley 1581 de 2012).
- **Europa:** GDPR, base legal del artículo 6.
- **Estados Unidos:** TCPA y registro 10DLC para SMS/WhatsApp.

Dos opciones, ambas explícitas en lenguaje que un no-abogado entiende:

1. *Me dieron su autorización expresa* — llenaron un formulario, aceptaron
   términos, dijeron que sí por escrito.
2. *Son clientes o prospectos con relación comercial previa* — compraron,
   cotizaron, o iniciaron una conversación.

Más un checkbox de declaración de responsabilidad. Se guarda en `lead_batches`
con `consent_basis`, `consent_ip` y `consent_at`.

El botón de confirmar está deshabilitado sin el checkbox, y debajo dice por qué:
*"No es un formalismo: es lo que nos permite escribirle a esta gente sin
quemarte a ti."*

## La arquitectura de dos pasos

`POST /api/leads/upload` acepta `mode=preview` y `mode=commit`. El archivo se
manda **dos veces**.

Por qué: el servidor queda sin estado. No hay que inventar un almacén temporal
de PII con TTL, ni una tabla de borradores que limpiar. El archivo ya está en el
navegador; reenviarlo no le cuesta nada al usuario. Y la llamada al modelo
ocurre solo en `preview` — en `commit` el mapeo llega dado.

## Vista previa

Lo que ve el usuario antes de confirmar, con números reales:

> **1.847** válidos · **1.612** con teléfono usable · **213** duplicados ·
> **94** inválidos
>
> 340 calientes · 512 tibios · 780 fríos · 215 dormidos
