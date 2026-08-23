'use client'

import { usePathname } from 'next/navigation'

/**
 * Returns the current shell route prefix, so shared components (e.g. the
 * smoke-tester view, agentes-ia view) can build links that stay inside the
 * route group the user is already in.
 *
 *   /central/smoke-tester      → '/central'
 *   /terminal/smoke-tester/abc → '/terminal'
 *
 * Defaults to '/terminal' so SSR + the legacy route group keep working.
 */
export function useRoutePrefix(): '/central' | '/terminal' {
  const pathname = usePathname()
  if (pathname?.startsWith('/central')) return '/central'
  return '/terminal'
}
