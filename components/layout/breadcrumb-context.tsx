"use client";

// Ensayo 2026-09-23 (CAT-08: nunca ids internos a la vista): el detalle de una requisición vive en
// /requisiciones/{uuid}, y la migaja de la barra superior mostraba ese segmento tal cual — el UUID
// crudo era la primera línea visible de la pantalla, antes del consecutivo. La barra la pinta
// MizarApp, que solo conoce la URL; quien sabe el consecutivo es el detalle, ya cargado. Este
// contexto es el canal mínimo para que el detalle se lo diga, sin subir la carga de datos a MizarApp.
import { createContext, useContext, useEffect } from "react";

export type DetailCrumbSetter = (label: string | null) => void;

export const DetailCrumbContext = createContext<DetailCrumbSetter | null>(null);

/** El detalle declara su nombre visible (el consecutivo) mientras está montado. */
export function useDetailCrumb(label: string | undefined): void {
  const setCrumb = useContext(DetailCrumbContext);
  useEffect(() => {
    if (!setCrumb) return;
    setCrumb(label || null);
    return () => setCrumb(null);
  }, [setCrumb, label]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Qué muestra la migaja del detalle: el nombre que declaró la pantalla (consecutivo) si ya lo hay;
 * mientras carga, nunca el UUID — el nombre de la bandeja padre. Un segmento que no es un id interno
 * (p. ej. REQ-2026-0001 en modo demo) sí se muestra tal cual.
 */
export function detailCrumbLabel(segment: string, reported: string | null | undefined, fallback: string): string {
  if (reported) return reported;
  if (!segment || UUID_RE.test(segment)) return fallback;
  return segment;
}
