/**
 * Historial de cambios (ADM-08 / RF-1003, 25-sep-2026): los filtros que ofrece la pantalla y acepta
 * GET /api/audit, con su nombre de negocio. Vive aparte del servicio y sin imports a propósito: lo lee
 * también la pantalla (components/screens/audit-log.tsx), y así el cliente no arrastra nada del servidor.
 *
 * Son GRUPOS, no los nombres crudos de `auditoria.entidad`/`auditoria.evento`: quien audita piensa en
 * «pagos» o «devoluciones», no en `orden` + `PAGO_ANULADO`. La traducción de cada grupo a SQL vive en
 * lib/infrastructure/audit-log-repository.ts.
 */

/** «Sobre qué»: tipo de registro afectado. `accesos` (ingresos, descargas y consultas del asistente)
 *  no son cambios: el listado los oculta salvo que se pidan con este filtro o con uno de evento. */
export const AUDIT_ENTITY_OPTIONS = [
  { key: "requisicion", label: "Requisiciones" },
  { key: "orden", label: "Órdenes" },
  { key: "pago", label: "Pagos" },
  { key: "gasto", label: "Gastos" },
  { key: "proveedor", label: "Proveedores" },
  { key: "catalogo", label: "Catálogos" },
  { key: "usuario", label: "Usuarios y contraseñas" },
  { key: "permisos", label: "Permisos por rol" },
  { key: "portal", label: "Portal público" },
  { key: "adjunto", label: "Soportes" },
  { key: "pantalla", label: "Pantallas de oficina" },
  { key: "accesos", label: "Ingresos y descargas" },
] as const;
export type AuditEntityGroup = (typeof AUDIT_ENTITY_OPTIONS)[number]["key"];

/** Por dónde entró el cambio. `publico` = portal sin sesión; `whatsapp` = Kapso (radicación o
 *  aprobación por WhatsApp); `sistema` = procesos automáticos e importaciones. */
export const AUDIT_ORIGIN_OPTIONS = [
  { key: "web", label: "Plataforma web" },
  { key: "publico", label: "Portal público" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "mcp", label: "Asistente (MCP)" },
  { key: "sistema", label: "Sistema" },
] as const;
export type AuditOriginKey = (typeof AUDIT_ORIGIN_OPTIONS)[number]["key"];

/** «Qué pasó»: familias de eventos. Cada una agrupa los códigos que escriben los servicios. */
export const AUDIT_EVENT_OPTIONS = [
  { key: "creacion", label: "Creaciones y altas", events: ["CREADA", "CREADO", "GENERADA", "REGISTRADO", "REGISTRADA", "PROPUESTO", "ITEM_PROPUESTO", "SESION_PANTALLA_CREADA", "SOPORTE_DISPONIBLE", "DOCUMENTO_DISPONIBLE"] },
  { key: "edicion", label: "Ediciones", events: ["ACTUALIZADA", "ACTUALIZADO", "CABECERA_EDITADA", "PROVEEDORES_ASIGNADOS", "APROBADOR_REASIGNADO", "REPARTIDO"] },
  { key: "revision", label: "Revisión", events: ["ENTRADA_REVISION", "RETOMADA_REVISION", "REVISADA", "ENVIADA_APROBACION"] },
  { key: "aprobacion", label: "Aprobaciones", events: ["APROBADA", "ITEMS_DECIDIDOS"] },
  { key: "devolucion", label: "Devoluciones y declinaciones", events: ["DEVUELTA", "DECLINADA"] },
  { key: "orden", label: "Estado de órdenes", events: ["ESTADO_CUMPLIMIENTO_ACTUALIZADO", "ESTADO_ADMINISTRATIVO_ACTUALIZADO"] },
  { key: "pago", label: "Pagos registrados y anulados", events: ["PAGO_REGISTRADO", "PAGO_ANULADO", "GASTO_ANULADO"] },
  { key: "seguridad", label: "Contraseñas y permisos", events: ["CONTRASENA_ACTUALIZADA", "CLAVE_RESTABLECIDA", "CLAVE_CAMBIADA", "PERMISOS_POR_ROL_ACTUALIZADOS", "SESION_PANTALLA_REVOCADA"] },
  { key: "descarga", label: "Descargas", events: ["DOCUMENTO_DESCARGADO", "SOPORTE_DESCARGADO", "REPORTE_REQUISICIONES_DESCARGADO", "CIERRE_CAJA_DESCARGADO", "XLSX_PROVISIONAL_DESCARGADO", "PDF_PROVISIONAL_DESCARGADO"] },
] as const;
export type AuditEventGroup = (typeof AUDIT_EVENT_OPTIONS)[number]["key"];

/** Tamaño de página por defecto y máximo del historial. */
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 100;
