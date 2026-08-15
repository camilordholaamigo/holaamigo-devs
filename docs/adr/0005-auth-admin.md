# ADR 0005 · Admin con contraseña compartida y cookie firmada

- **Fecha:** 2026-08-15
- **Estado:** aceptada, **temporal por diseño**
- **Contradice:** PRD §8.1, que dice "admin (auth Supabase + allowlist)"

## Contexto

El admin lo usan **tres personas del equipo interno**. Contiene datos de
prospectos: correos, respuestas del quiz, cifras de facturación declaradas. No
es público, pero tampoco es un sistema bancario.

Supabase Auth con magic links exige: SMTP configurado en el proyecto de
Rentmies, plantillas de correo, una tabla de allowlist que mantener, y manejo
de sesión en el cliente. Es medio día de trabajo que no mueve la aguja de las
ventas esta semana.

## Decisión

Contraseña compartida en `ADMIN_PASSWORD` + cookie de sesión firmada con
HMAC-SHA256, `httpOnly`, `Secure`, `SameSite=Lax`, TTL de 12 horas.

Lo que **sí** es innegociable y ya está implementado:

- La cookie **está firmada**, no es un flag booleano. Su payload
  (`usuario.expiración.nonce`) va con HMAC sobre un secreto de servidor. No se
  puede fabricar desde la consola del navegador.
- La comparación de contraseña es **en tiempo constante** (`timingSafeEqual`),
  incluso cuando las longitudes difieren, para no filtrar la longitud.
- El login tiene **rate limit** de 10 intentos por IP por hora. Una contraseña
  compartida sin rate limit es una contraseña adivinable.
- El **layout de `/admin` verifica en cada request**, del lado del servidor.
  Cada ruta de API del admin verifica también, por su cuenta.
- El login vive en `/admin-login`, fuera del árbol protegido, para que la
  puerta no se cierre sobre sí misma.

## Alternativas descartadas

**Supabase Auth + allowlist.** Es la correcta a mediano plazo. Descartada hoy
por costo de setup contra un beneficio que con 3 usuarios es marginal.

**Vercel Password Protection.** Un toggle. Pero protege el deployment entero
—incluida la landing— así que es inservible: la landing tiene que ser pública.

**Basic Auth en middleware.** Sin logout, sin expiración, credenciales en cada
request. Peor en todo.

## Cuándo se revisa

Cualquiera de estas tres condiciones dispara la migración a Supabase Auth:

1. Más de 5 personas necesitan acceso.
2. Alguien externo al equipo fundador necesita entrar.
3. Hace falta saber **quién** aprobó qué. Hoy `approvals.decided_by` siempre
   dice `admin`, y eso es una pérdida de trazabilidad que ya duele.

La migración es acotada: `lib/auth/admin.ts` expone `currentAdmin()` y todo el
resto del código solo usa eso. Cambiar la implementación no toca ninguna página
ni ninguna ruta.

## Consecuencias

- `approvals.decided_by` es siempre `admin`. Sin auditoría por persona.
- Rotar la contraseña invalida todas las sesiones si también cambia
  `ADMIN_SESSION_SECRET`; si no, hay que esperar el TTL de 12 h.
- La contraseña debe ser larga y aleatoria, no memorizable. Va en el gestor de
  contraseñas del equipo, no en un chat.
