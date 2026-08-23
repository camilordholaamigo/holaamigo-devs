// ─── Smoke Tester — Prodesa project catalog (29 entries) ─────────────────
// Inline source of truth for the Prodesa projects used by the form-trigger
// flow. Same data as scripts/seed-prodesa-projects.mjs; both this module
// and the script feed prodesa_projects via upsert.
//
// When the real Prodesa CSV with full subtipo metadata is available,
// replace the synthetic subtipo generator with parsed CSV rows.

export interface ProdesaCatalogEntry {
  nombre: string
  categoria: 'VIS' | 'NO VIS'
  precio_min: number
  precio_max: number
  subtipos_count: number
  ciudad: string
}

export const PRODESA_CATALOG: ProdesaCatalogEntry[] = [
  { nombre: 'avenida_colon',          categoria: 'NO VIS', precio_min: 244_400_000, precio_max: 317_000_000, subtipos_count: 4, ciudad: 'Bogotá' },
  { nombre: 'vesta',                  categoria: 'VIS',    precio_min: 234_900_000, precio_max: 234_900_000, subtipos_count: 1, ciudad: 'Bogotá' },
  { nombre: 'cerezo',                 categoria: 'NO VIS', precio_min: 415_000_000, precio_max: 634_000_000, subtipos_count: 5, ciudad: 'Bogotá' },
  { nombre: 'PSJ Colibri',            categoria: 'VIS',    precio_min: 173_400_000, precio_max: 213_000_000, subtipos_count: 3, ciudad: 'Soacha' },
  { nombre: 'PSJ Mirla',              categoria: 'VIS',    precio_min: 204_120_000, precio_max: 270_540_000, subtipos_count: 2, ciudad: 'Soacha' },
  { nombre: 'Gorrion',                categoria: 'NO VIS', precio_min: 172_344_000, precio_max: 182_400_000, subtipos_count: 2, ciudad: 'Soacha' },
  { nombre: 'serrania_del_vinculo',   categoria: 'VIS',    precio_min: 222_220_000, precio_max: 242_500_000, subtipos_count: 3, ciudad: 'Bogotá' },
  { nombre: 'PSJ_Balcones_de_Soacha', categoria: 'VIS',    precio_min: 244_488_000, precio_max: 270_540_000, subtipos_count: 2, ciudad: 'Soacha' },
  { nombre: 'ADR Águila',             categoria: 'NO VIS', precio_min: 295_000_000, precio_max: 570_000_000, subtipos_count: 7, ciudad: 'Bogotá' },
  { nombre: 'ADR Condor',             categoria: 'VIS',    precio_min: 236_372_175, precio_max: 236_372_175, subtipos_count: 1, ciudad: 'Bogotá' },
  { nombre: 'LMQ Orizzo',             categoria: 'VIS',    precio_min: 221_319_000, precio_max: 238_329_000, subtipos_count: 4, ciudad: 'Bogotá' },
  { nombre: 'brisas_de_san_pablo',    categoria: 'NO VIS', precio_min: 140_948_000, precio_max: 140_948_000, subtipos_count: 1, ciudad: 'Mosquera' },
  { nombre: 'mirasol',                categoria: 'NO VIS', precio_min: 149_702_378, precio_max: 149_702_378, subtipos_count: 1, ciudad: 'Mosquera' },
  { nombre: 'Primavera',              categoria: 'VIS',    precio_min: 230_000_000, precio_max: 270_540_000, subtipos_count: 3, ciudad: 'Mosquera' },
  { nombre: 'castelo',                categoria: 'NO VIS', precio_min: 624_000_000, precio_max: 721_000_000, subtipos_count: 3, ciudad: 'Bogotá' },
  { nombre: 'praseo',                 categoria: 'NO VIS', precio_min: 474_000_000, precio_max: 614_000_000, subtipos_count: 2, ciudad: 'Bogotá' },
  { nombre: 'strada',                 categoria: 'NO VIS', precio_min: 414_717_000, precio_max: 683_000_000, subtipos_count: 4, ciudad: 'Bogotá' },
  { nombre: 'trevi',                  categoria: 'NO VIS', precio_min: 548_000_000, precio_max: 703_000_000, subtipos_count: 6, ciudad: 'Bogotá' },
  { nombre: 'armonia',                categoria: 'VIS',    precio_min: 225_000_000, precio_max: 225_000_000, subtipos_count: 1, ciudad: 'Mosquera' },
  { nombre: 'Caoba',                  categoria: 'NO VIS', precio_min: 157_181_450, precio_max: 157_181_450, subtipos_count: 1, ciudad: 'Mosquera' },
  { nombre: 'Altos_de_las_palmas',    categoria: 'VIS',    precio_min: 255_150_000, precio_max: 255_150_000, subtipos_count: 3, ciudad: 'Chía' },
  { nombre: 'Cian',                   categoria: 'VIS',    precio_min: 228_690_000, precio_max: 238_140_000, subtipos_count: 2, ciudad: 'Bogotá' },
  { nombre: 'bermellon',              categoria: 'VIS',    precio_min: 150_578_000, precio_max: 150_578_000, subtipos_count: 1, ciudad: 'Soacha' },
  { nombre: 'escarlata',              categoria: 'VIS',    precio_min: 199_000_000, precio_max: 199_000_000, subtipos_count: 1, ciudad: 'Soacha' },
  { nombre: 'STC Torino',             categoria: 'VIS',    precio_min: 240_554_000, precio_max: 240_554_000, subtipos_count: 2, ciudad: 'Bogotá' },
  { nombre: 'ambar',                  categoria: 'NO VIS', precio_min: 470_680_000, precio_max: 501_009_340, subtipos_count: 3, ciudad: 'Bogotá' },
  { nombre: 'agora',                  categoria: 'VIS',    precio_min: 236_372_000, precio_max: 335_962_500, subtipos_count: 6, ciudad: 'Bogotá' },
  { nombre: 'centrico',               categoria: 'VIS',    precio_min: 234_971_450, precio_max: 234_971_450, subtipos_count: 1, ciudad: 'Bogotá' },
  { nombre: 'ADP Atrio de Pance',     categoria: 'NO VIS', precio_min: 614_300_000, precio_max: 814_704_000, subtipos_count: 2, ciudad: 'Cali' },
]

export interface SyntheticSubtipo {
  name: string
  price: number
  area: number | null
  habitaciones: number | null
  banos: number | null
  plano_id: string | null
}

/**
 * Build a synthetic subtipo list per project for the seed.
 * Distributes prices linearly between min and max across `count` buckets.
 * Replace with parsed CSV rows when the real Prodesa CSV is available.
 */
export function buildSyntheticSubtipos(
  min: number,
  max: number,
  count: number
): SyntheticSubtipo[] {
  if (count <= 0) return []
  if (count === 1) {
    return [
      { name: 'TIPO A', price: min, area: null, habitaciones: null, banos: null, plano_id: null },
    ]
  }
  const span = max - min
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1)
    const price = Math.round(min + span * t)
    const letter = String.fromCharCode(65 + i)
    return {
      name: `TIPO ${letter}`,
      price,
      area: null,
      habitaciones: null,
      banos: null,
      plano_id: null,
    }
  })
}
