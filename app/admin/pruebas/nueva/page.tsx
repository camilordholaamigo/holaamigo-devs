import Link from 'next/link';
import { db } from '@/lib/supabase/admin';
import { Card, SectionTitle } from '@/components/ui';
import { PruebaNueva, type ClienteProbable, type MoldeDeBateria } from '@/components/prueba-nueva';
import { canalesActivos, faltaParaEnviar } from '@/lib/pruebas/callbell';
import { configDePruebas } from '@/lib/pruebas/lanzar';

/**
 * /admin/pruebas/nueva — la única forma de armar una prueba a mano.
 *
 * Pantalla propia y no un modal, por dos razones que se pagan solas: el
 * formulario tiene tres pasos y una vista previa al lado —en un modal habría que
 * elegir entre las dos cosas—, y la URL se puede compartir y volver a abrir.
 *
 * Dos caminos, y el de arriba es el que más se usa:
 *
 *   1. **Un cliente nuestro.** Se elige de la lista y las preguntas las compila
 *      el sistema leyendo su análisis, con la misma batería que corre el disparo
 *      automático del diagnóstico. Es un botón, y sirve para reproducir a mano
 *      exactamente lo que el cliente va a ver.
 *   2. **Un número cualquiera.** El guion lo escribe una persona. No necesita
 *      organización, ni research, ni nada. Ése era el punto de ADR 0027.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Nueva prueba de línea · admin', robots: { index: false } };

interface OrgCruda {
  id: string;
  name: string | null;
  domain: string | null;
  lifecycle: string | null;
}

export default async function NuevaPruebaPage() {
  const [canales, config, { data: orgsCrudas }] = await Promise.all([
    canalesActivos(),
    configDePruebas(),
    // Todo el que pasó por la landing, lo último primero. La lista NO se filtra
    // por «tiene número conocido», que es lo que la dejaba vacía: el research
    // solo escribe en `smoke_targets` los números que encontró PUBLICADOS en el
    // sitio (ADR 0025), y un cliente que no publica WhatsApp —la mitad de los
    // que valen— desaparecía de esta pantalla junto con todo su análisis. El
    // número se puede escribir a mano; el análisis no se puede recuperar de
    // ningún otro lado.
    db()
      .from('organizations')
      .select('id, name, domain, lifecycle')
      .order('created_at', { ascending: false })
      .limit(150),
  ]);

  const orgs = (orgsCrudas ?? []) as OrgCruda[];
  const ids = orgs.map((o) => o.id);

  const [{ data: runs }, { data: targets }, { data: moldesCrudos }] = await Promise.all([
    ids.length
      ? db()
          .from('research_runs')
          .select('organization_id, status')
          .in('organization_id', ids)
          .in('status', ['done', 'partial'])
      : Promise.resolve({ data: [] as { organization_id: string; status: string }[] }),
    ids.length
      ? db()
          .from('smoke_targets')
          .select('organization_id, phone_e164, source_url, ultima_prueba_at, bloqueado, confianza')
          .in('organization_id', ids)
          .order('confianza', { ascending: false })
      : Promise.resolve({ data: [] as TargetCrudo[] }),
    db()
      .from('smoke_templates')
      .select('id, nombre, que_mide, max_turnos')
      .in('id', config.bateria),
  ]);

  const conAnalisis = new Set(
    ((runs ?? []) as { organization_id: string | null }[])
      .map((r) => r.organization_id)
      .filter((x): x is string => Boolean(x)),
  );

  // La de mayor confianza por organización, que es el orden en que vienen.
  const lineaDe = new Map<string, TargetCrudo>();
  for (const t of (targets ?? []) as TargetCrudo[]) {
    if (!t.organization_id || lineaDe.has(t.organization_id)) continue;
    lineaDe.set(t.organization_id, t);
  }

  const clientes: ClienteProbable[] = orgs.map((o) => {
    const linea = lineaDe.get(o.id);
    return {
      id: o.id,
      nombre: o.name?.trim() || o.domain || 'sin nombre',
      dominio: o.domain,
      lifecycle: o.lifecycle ?? 'diagnostic',
      telefono: linea?.phone_e164 ?? null,
      // Con fuente = el research lo leyó en SU sitio. Es la diferencia entre el
      // camino automático y el manual, y se muestra porque cambia qué tan
      // defendible es el mensaje (ADR 0025).
      fuenteTelefono: linea?.source_url ?? null,
      ultimaPruebaAt: linea?.ultima_prueba_at ?? null,
      bloqueado: Boolean(linea?.bloqueado),
      tieneAnalisis: conAnalisis.has(o.id),
    };
  });

  // En el orden de la batería, no en el que devuelve Postgres: el orden importa
  // (`servicio` primero porque da en dos minutos el dato que el cliente lee).
  const porId = new Map(
    ((moldesCrudos ?? []) as MoldeDeBateria[]).map((m) => [m.id, m] as const),
  );
  const bateria: MoldeDeBateria[] = config.bateria
    .map((id) => porId.get(id))
    .filter((m): m is MoldeDeBateria => Boolean(m));

  const falta = Object.keys(faltaParaEnviar());

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
      <div className="space-y-4">
        <Link href="/admin/pruebas" className="text-[13px] text-ink-faint transition hover:text-ink">
          ← Pruebas de línea
        </Link>
        <SectionTitle
          eyebrow="Smoke tester"
          title="Nueva prueba"
          subtitle="Le escribimos por WhatsApp a la línea de un negocio, como si fuéramos un cliente, y calificamos lo que pasa. Puede ser un cliente nuestro —y ahí las preguntas salen de su análisis— o cualquier número, con el guion escrito a mano."
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
              y se vuelve a desplegar: el despliegue que está corriendo tiene las variables del
              momento en que se construyó, así que agregarla no alcanza.
            </p>
          </div>
        </Card>
      ) : null}

      <PruebaNueva canales={canales} clientes={clientes} bateria={bateria} />
    </main>
  );
}

interface TargetCrudo {
  organization_id: string | null;
  phone_e164: string;
  source_url: string | null;
  ultima_prueba_at: string | null;
  bloqueado: boolean;
  confianza: number | null;
}
