import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // El paquete portable del smoke tester, tal como llegó. Es código de OTRA
    // aplicación que guardamos como referencia — sus doce bugs documentados
    // son la razón de la mitad de las decisiones de lib/pruebas. No compila
    // acá (ver tsconfig) y tampoco tiene por qué pasar nuestro linter:
    // corregirlo lo volvería una copia editada y dejaría de ser la referencia.
    "docs/referencia/**",
  ]),
]);

export default eslintConfig;
