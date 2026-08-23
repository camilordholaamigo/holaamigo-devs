import { clamp } from '@/lib/utils';
import type {
  Auditoria,
  ChequeoDeterministico,
  CriterioRubrica,
  Mensaje,
  PlanDePrueba,
} from '@/lib/pruebas/types';

/**
 * Capa 2 · la auditoría determinística.
 *
 * Cero llamadas a modelo, cero varianza: la misma conversación saca la misma
 * nota todas las veces. Es lo que la capa 3 no puede dar y lo que hace que
 * este número se le pueda mostrar a un cliente sin asterisco.
 *
 * Corre al cerrar cada prueba, siempre, y no puede fallar: no tiene
 * dependencias externas. Si el evaluador con modelo no corre —no hay llave, se
 * cayó el proveedor, se acabó el presupuesto— el informe igual tiene esto.
 *
 * LA DISTINCIÓN QUE HACE ÚTIL EL RESULTADO es entre crítico y advertencia, y
 * es de negocio, no técnica:
 *
 *   CRÍTICO      el negocio hizo algo que no puede hacer. Dijo un precio que
 *                contradice el suyo publicado, o no contestó nunca. Es un
 *                incidente y no hay discusión posible.
 *   ADVERTENCIA  lo hizo distinto de lo esperable. No preguntó nada, no
 *                propuso un paso siguiente. Es mejorable.
 *
 * Un crítico es un incidente. Diez advertencias son una conversación
 * mejorable. Mezclarlos en un solo número deja sin poder distinguirlos.
 *
 * Ver docs/wiki/23-smoke-tester.md
 */

const CIFRA_DE_DINERO =
  /(?:\$|us\$|usd|cop|€|eur)\s?\d[\d.,]*(?:\s?(?:mil|millones|k|m))?|\d[\d.,]*\s?(?:d[oó]lares|pesos|usd|cop|euros|millones|mil pesos)/i;

const PASO_SIGUIENTE =
  /\b(cita|visita|agend\w*|reserv\w*|cotizaci[oó]n|llamada|te llamo|te escribo|pasa por|te env[ií]o|coordin\w*|cu[aá]ndo te queda|qu[eé] d[ií]a|a qu[eé] hora|link|enlace|calendario)\b/i;

export function auditar(args: {
  plan: PlanDePrueba;
  conversation: Mensaje[];
  segundosPrimeraRespuesta: number | null;
}): Auditoria {
  const { plan, conversation, segundosPrimeraRespuesta } = args;

  const delNegocio = conversation.filter((m) => m.role === 'negocio');
  const textoNegocio = delNegocio.map((m) => m.text).join('\n');

  const criticos: string[] = [];
  const advertencias: string[] = [];

  const criterios = plan.rubrica.map((c) => {
    const r = evaluarCriterio(c, {
      textoNegocio,
      hayRespuesta: delNegocio.length > 0,
      segundos: segundosPrimeraRespuesta,
    });

    if (r.paso === false) {
      if (r.critico) criticos.push(`${c.criterio}: ${r.detalle}`);
      else advertencias.push(`${c.criterio}: ${r.detalle}`);
    }

    return {
      id: c.id,
      criterio: c.criterio,
      dimension: c.dimension,
      peso: c.peso,
      paso: r.paso,
      detalle: r.detalle,
    };
  });

  const verificables = criterios.filter((c) => c.paso !== null);
  const pesoTotal = verificables.reduce((s, c) => s + c.peso, 0);
  const pesoLogrado = verificables
    .filter((c) => c.paso === true)
    .reduce((s, c) => s + c.peso, 0);

  // Sin nada verificable no hay nota. Devolver 0 sería acusar a un negocio de
  // algo que en realidad es una limitación nuestra.
  const base = pesoTotal > 0 ? Math.round((pesoLogrado / pesoTotal) * 100) : 0;
  const score =
    pesoTotal > 0 ? clamp(base - criticos.length * 10 - advertencias.length * 3, 0, 100) : 0;

  return {
    score,
    verificables: verificables.length,
    criterios,
    criticos,
    advertencias,
  };
}

interface Contexto {
  textoNegocio: string;
  hayRespuesta: boolean;
  segundos: number | null;
}

interface Veredicto {
  /** `null` = no se pudo verificar. NO es lo mismo que no cumplió. */
  paso: boolean | null;
  detalle: string;
  critico: boolean;
}

function evaluarCriterio(criterio: CriterioRubrica, ctx: Contexto): Veredicto {
  if (!criterio.chequeo) {
    return {
      paso: null,
      detalle: 'Sin chequeo automático: lo resuelve la evaluación con modelo.',
      critico: false,
    };
  }
  return correr(criterio.chequeo, ctx);
}

function correr(chequeo: ChequeoDeterministico, ctx: Contexto): Veredicto {
  switch (chequeo.tipo) {
    case 'hubo_respuesta':
      return ctx.hayRespuesta
        ? { paso: true, detalle: 'Contestaron.', critico: false }
        : { paso: false, detalle: 'Nadie contestó.', critico: true };

    case 'respondio_antes_de': {
      if (ctx.segundos === null) {
        return { paso: false, detalle: 'No contestaron nunca.', critico: true };
      }
      const dentro = ctx.segundos <= chequeo.segundos;
      return {
        paso: dentro,
        detalle: dentro
          ? `Contestaron en ${ctx.segundos} s.`
          : `Tardaron ${ctx.segundos} s (el umbral era ${chequeo.segundos} s).`,
        critico: false,
      };
    }

    case 'dio_precio': {
      if (!ctx.hayRespuesta) {
        return { paso: false, detalle: 'No contestaron nunca.', critico: true };
      }
      const hay = CIFRA_DE_DINERO.test(ctx.textoNegocio);
      return {
        paso: hay,
        detalle: hay ? 'Dieron una cifra.' : 'No dieron ninguna cifra en toda la conversación.',
        critico: false,
      };
    }

    case 'propuso_paso_siguiente': {
      if (!ctx.hayRespuesta) {
        return { paso: false, detalle: 'No contestaron nunca.', critico: true };
      }
      const hay = PASO_SIGUIENTE.test(ctx.textoNegocio);
      return {
        paso: hay,
        detalle: hay
          ? 'Propusieron un paso siguiente.'
          : 'Nunca propusieron cita, llamada ni cotización.',
        critico: false,
      };
    }

    case 'pregunto_al_menos': {
      if (!ctx.hayRespuesta) {
        return { paso: false, detalle: 'No contestaron nunca.', critico: true };
      }
      const preguntas = (ctx.textoNegocio.match(/\?/g) ?? []).length;
      const alcanza = preguntas >= chequeo.cantidad;
      return {
        paso: alcanza,
        detalle: alcanza
          ? `Hicieron ${preguntas} pregunta${preguntas === 1 ? '' : 's'}.`
          : `Hicieron ${preguntas} pregunta${preguntas === 1 ? '' : 's'} (se esperaban ${chequeo.cantidad}).`,
        critico: false,
      };
    }

    case 'no_menciona': {
      if (!ctx.hayRespuesta) {
        return { paso: false, detalle: 'No contestaron nunca.', critico: true };
      }
      const dicho = chequeo.ninguna_de.filter((p) => contiene(ctx.textoNegocio, p));
      return dicho.length === 0
        ? { paso: true, detalle: 'No dijeron nada de lo prohibido.', critico: false }
        : { paso: false, detalle: `Mencionaron: ${dicho.join(', ')}.`, critico: true };
    }

    case 'menciona':
      return verificarMencion(chequeo, ctx);

    default:
      return { paso: null, detalle: 'Chequeo desconocido.', critico: false };
  }
}

/**
 * El chequeo más delicado, y el único que puede acusar de contradicción.
 *
 * Tres desenlaces, y la diferencia entre el segundo y el tercero es la que
 * decide si le decimos a un cliente que su línea contradice su propio sitio:
 *
 *   COINCIDE      el dato del sitio aparece en la conversación. Pasa.
 *   CONTRADICE    dieron un dato del mismo tipo pero DISTINTO. Crítico.
 *   NO LO TOCARON no hablaron del tema. No se puede juzgar → `null`.
 *
 * Sin el tercer desenlace, un negocio al que nunca se le llegó a preguntar el
 * precio aparecería reprobado por «no coincide», que es una acusación falsa.
 */
function verificarMencion(
  chequeo: Extract<ChequeoDeterministico, { tipo: 'menciona' }>,
  ctx: Contexto,
): Veredicto {
  if (!ctx.hayRespuesta) {
    return { paso: false, detalle: 'No contestaron nunca.', critico: true };
  }

  for (const esperado of chequeo.alguna_de) {
    if (coincide(ctx.textoNegocio, esperado)) {
      return {
        paso: true,
        detalle: `Coincide con lo publicado${chequeo.fuente ? ` (${chequeo.fuente})` : ''}.`,
        critico: false,
      };
    }
  }

  // Un dato del mismo tipo pero distinto: eso sí es una contradicción.
  const esperaCifra = chequeo.alguna_de.some((v) => tieneCifra(v));
  if (esperaCifra && CIFRA_DE_DINERO.test(ctx.textoNegocio)) {
    return {
      paso: false,
      detalle: `Dieron una cifra distinta de la publicada${chequeo.fuente ? ` (${chequeo.fuente})` : ''}.`,
      critico: true,
    };
  }

  return {
    paso: null,
    detalle: 'No se llegó a hablar del tema en la conversación.',
    critico: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPARACIÓN LAXA
// ═══════════════════════════════════════════════════════════════════════════

const normalizar = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function contiene(texto: string, aguja: string): boolean {
  return normalizar(texto).includes(normalizar(aguja));
}

const tieneCifra = (s: string) => /\d{3,}/.test(s.replace(/[.,\s]/g, ''));

/**
 * ¿El negocio dijo lo mismo que su sitio?
 *
 * Dos caminos, porque los datos del sitio vienen de dos formas distintas:
 *
 *   NUMÉRICOS ("Desde $1.200.000") — se comparan solo los dígitos. Por
 *   WhatsApp la misma cifra se escribe «1.200.000», «1200000» y «1'200.000»,
 *   y las tres son la misma plata.
 *
 *   TEXTUALES ("Atendemos en Bogotá, Medellín y Cali") — se comparan las
 *   palabras con contenido. Se exige la mitad y no todas: nadie repite por
 *   WhatsApp la frase completa de su página, y un auditor que exige perfección
 *   se ignora a la semana.
 */
function coincide(texto: string, esperado: string): boolean {
  const digitosEsperados = esperado.replace(/\D/g, '');
  if (digitosEsperados.length >= 4) {
    return texto.replace(/\D/g, '').includes(digitosEsperados);
  }

  const palabras = normalizar(esperado)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  if (palabras.length === 0) return contiene(texto, esperado);

  const hay = normalizar(texto);
  const aciertos = palabras.filter((w) => hay.includes(w)).length;
  return aciertos / palabras.length >= 0.5;
}
