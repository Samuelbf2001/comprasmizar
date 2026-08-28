import type { Metadata } from 'next';
import { DM_Sans } from 'next/font/google';
import './globals.css';

// Tipografía de marca (ver docs/identidad-mizar.md): DM Sans para titulares,
// cuerpo e interfaz. Next.js la autohospeda en build (sin peticiones a Google
// en el navegador) y la expone como variable CSS que consume app/globals.css
// (--font-display / --font-body).
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
    <html lang="es" className={dmSans.variable}>
      <body>{children}</body>
    </html>
  );
}
