/**
 * Resuelve el alias `@/` cuando se importa un archivo del proyecto desde un
 * script suelto de `scripts/`.
 *
 * Existe porque las pruebas de este repo corren con `node` a secas —sin
 * bundler— y `@/lib/...` es una invención de `tsconfig.json` que Node no
 * conoce. La alternativa era que cada prueba se transpilara el archivo a mano,
 * que es lo que se hacía y probaba la copia en vez del original.
 *
 * Se registra desde el propio script con `register()` de `node:module`, así que
 * no hay que cambiar el comando de `npm test`.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = new URL('../', import.meta.url);

// TypeScript importa sin extensión (`@/lib/utils`) y Node exige una. Se prueban
// las dos que usa el repo, en el orden en que aparecen: primero el módulo, y
// después el índice de la carpeta.
const EXTENSIONES = ['.ts', '.tsx', '/index.ts', '/index.tsx', ''];

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith('@/')) return next(specifier, context);

  const base = new URL(specifier.slice(2), RAIZ);

  for (const ext of EXTENSIONES) {
    const candidato = new URL(base.href + ext);
    if (existsSync(fileURLToPath(candidato))) return next(candidato.href, context);
  }

  return next(base.href, context);
}
