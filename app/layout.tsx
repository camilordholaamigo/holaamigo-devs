import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Hola Amigo · Motor de Ventas',
  description:
    'Diagnóstico de tu negocio en 6 minutos: contra quién compites, dónde se te está cayendo la plata, y tres agentes listos para trabajar.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://holacamilo.vercel.app'),
  openGraph: {
    title: 'Hola Amigo · Motor de Ventas',
    description: 'Seis minutos. Tu diagnóstico, tu cuenta al revés, y tres agentes esperando permiso.',
    type: 'website',
    locale: 'es_CO',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#fbfaf8',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-paper text-ink">{children}</body>
    </html>
  );
}
