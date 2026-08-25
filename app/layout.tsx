import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mizar · Mesa de control de obra',
  description: 'Requisiciones, aprobaciones y gastos de obra en un solo lugar.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}
