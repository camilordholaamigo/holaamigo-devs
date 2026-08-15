import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Normaliza lo que sea que el usuario escriba en el campo de URL a
 * `https://dominio.com`. Acepta "acme.com", "www.acme.com/precios",
 * "http://acme.com". Devuelve null si no es un dominio plausible.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  // Un dominio real tiene al menos un punto y un TLD de 2+ letras.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  if (host.length > 253) return null;

  return `https://${host}`;
}

export function domainOf(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@,;]+\.[a-z]{2,}$/i;

export function isValidEmail(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim();
  return value.length <= 254 && EMAIL_RE.test(value);
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return isValidEmail(value) ? value : null;
}

/** Formatea dinero para pantalla. Nunca con decimales: son estimaciones. */
export function formatMoney(amount: number, currency = 'USD'): string {
  const locale = currency === 'COP' ? 'es-CO' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
}

export function formatNumber(value: number, locale = 'es-CO'): string {
  return new Intl.NumberFormat(locale).format(Math.round(value));
}

/** Fecha absoluta a partir de hoy + n días, en español. */
export function dateInDays(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function isoInDays(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** Primera IP real detrás del proxy de Vercel. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return headers.get('x-real-ip');
}

/** Rango de diacríticos combinantes (U+0300–U+036F), como escape explícito. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
