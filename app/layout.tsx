import type { Metadata } from 'next';
import { Fraunces, DM_Sans } from 'next/font/google';
import './globals.css';

// Tipografía de marca (ver docs/identidad-mizar.md): Fraunces para títulos,
// DM Sans para cuerpo e interfaz. Next.js las autohospeda en build (sin
// peticiones a Google en el navegador) y las expone como variables CSS que
// consume app/globals.css (--font-display / --font-body).
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Mizar · Mesa de control de obra',
  description: 'Requisiciones, aprobaciones y gastos de obra en un solo lugar.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" className={`${fraunces.variable} ${dmSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
