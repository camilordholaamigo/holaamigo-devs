import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Hay un package-lock.json en C:\Users\camil (fuera de este repo) que
  // Turbopack detecta como raíz candidata. Lo fijamos aquí para que el build
  // sea idéntico en local y en Vercel.
  turbopack: {
    root: __dirname,
  },

  // El crawler lee HTML de sitios de terceros y libphonenumber trae sus datos
  // en el bundle: los dejamos fuera del tree-shaking del servidor.
  serverExternalPackages: ['read-excel-file'],

  experimental: {
    // Las rutas que corren research y diagnóstico pasan de 4,5 MB en el body
    // solo cuando alguien pega una base enorme; el resto va por multipart.
    serverActions: { bodySizeLimit: '10mb' },
  },
};

export default nextConfig;
