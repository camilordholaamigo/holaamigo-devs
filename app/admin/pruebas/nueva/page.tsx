import Link from 'next/link';
import { db } from '@/lib/supabase/admin';
import { Card, SectionTitle } from '@/components/ui';
import { PruebaNueva, type OrgConLinea } from '@/components/prueba-nueva';
import { canalesActivos, faltaParaEnviar } from '@/lib/pruebas/callbell';

/**
 * /admin/pruebas/nueva — la única forma de armar una prueba a mano.
 *
 * Pantalla propia y no un modal, por dos razones que se pagan solas: el
 * formulario tiene tres pasos y una vista previa al lado —en un modal habría que
 * elegir entre las dos cosas—, y la URL se puede compartir y volver a abrir.
 *
 * No necesita organización, ni research, ni nada: con un número y tres líneas de
 * texto sale una conversación. Ése era el punto de ADR 0027.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Nueva prueba de línea · admin', robots: { index: false } };

interface LineaCruda {
  organization_id: string | null;
  phone_e164: string;
  nombre: string | null;
  ultima_prueba_at: string | null;
  organizations: { name: string | null; domain: string | null } | null;
}

export default async function NuevaPruebaPage() {
  const [canales, { data: lineas }] = await Promise.all([
    canalesActivos(),
    // Las organizaciones que ya tienen una línea conocida. Es lo que hace usable
    // el QA de clientes: se eligen de una lista en vez de pegar treinta
    // teléfonos. Los números salen de donde el research los dejó, con su fuente.
    db()
      .from('smoke_targets')
      .select(
        'organization_id, phone_e164, nombre, ultima_prueba_at, confianza, organizations ( name, domain )',
      )
      .eq('bloqueado', false)
      .not('organization_id', 'is', null)
      .order('confianza', { ascending: false })
      .limit(300),
  ]);

  const falta = Object.keys(faltaParaEnviar());

  // Una línea por organización: la de mayor confianza, que es el orden en que
  // vienen. Probar las tres líneas de treinta clientes son noventa
  // conversaciones, y el QA quiere cobertura amplia, no profundidad.
  const porOrg = new Map<string, OrgConLinea>();
  for (const l of (lineas ?? []) as unknown as LineaCruda[]) {
    if (!l.organization_id || porOrg.has(l.organization_id)) continue;
    porOrg.set(l.organization_id, {
      id: l.organization_id,
      nombre: l.organizations?.name ?? l.organizations?.domain ?? l.nombre ?? l.phone_e164,
      telefono: l.phone_e164,
      ultima_prueba_at: l.ultima_prueba_at,
    });
  }
  const organizaciones = [...porOrg.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
      <div className="space-y-4">
        <Link href="/admin/pruebas" className="text-[13px] text-ink-faint transition hover:text-ink">
          ← Pruebas de línea
        </Link>
        <SectionTitle
          eyebrow="Smoke tester"
          title="Nueva prueba"
          subtitle="Le escribimos por WhatsApp a la línea de un negocio, como si fuéramos un cliente, y calificamos lo que pasa. Funciona con cualquier número: no hace falta que el negocio esté en nuestra base ni que le hayamos corrido research."
        />
      </div>

      {falta.length > 0 ? (
        <Card className="border-leak/30 bg-leak-soft">
          <div className="space-y-1 p-5">
            <p className="text-[14px] font-semibold text-leak">
              Falta {falta.join(', ')} en el entorno.
            </p>
            <p className="text-[13px] leading-relaxed text-leak/80">
              Sin eso no sale ningún mensaje. Se carga en Vercel → Settings → Environment Variables
              y se vuelve a desplegar.
            </p>
          </div>
        </Card>
      ) : null}

      <PruebaNueva canales={canales} organizaciones={organizaciones} />
    </main>
  );
}
