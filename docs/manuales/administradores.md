# Manual de administradores Mizar y Sixteam

## Administrador Mizar

En Alcance Completo, Claudia o Juliana administra obras, etiquetas, usuarios y sociedades; también puede administrar proveedores cuando se habilite autoservicio. Ve reportes ejecutivos. En el modo Básico de la demo, el gate de autoservicio mantiene catálogos y normalización fuera de este rol: no debe editar ítems ni saltarse permisos.

## Administrador Sixteam

Samuel/equipo administra todo lo anterior más configuración técnica, respaldos, soporte, permisos, integraciones y gates de salida. Sixteam no debe resolver manualmente un acto de aprobación que pertenece a Mizar.

## Reglas operativas

- Alta y baja se hacen con permisos de servidor/RLS; ocultar un botón no es una barrera de seguridad.
- Los cambios de catálogo deben quedar en auditoría inmutable.
- Los backups automáticos diarios y la exportación completa deben probarse con una restauración, no solo marcarse en UI.
- No se pegan secretos de Supabase, Kapso, MCP o Helisa en tickets, docs, URLs o capturas.

## Estado actual

La demo muestra selector de rol, gate de autoservicio y guard de ruta. `/configuracion` es navegación demostrativa; no prueba configuración real, RLS, backups ni soporte. Los gates externos de [docs/gates-externos.md](../gates-externos.md) siguen siendo obligatorios.

## Checklist

- [ ] Admin-Mizar no puede leer/escribir catálogos en Básico.
- [ ] Sixteam puede revocar una sesión de pantalla y verificar permisos mínimos.
- [ ] El backup se restaura en un entorno controlado.
- [ ] La auditoría identifica usuario, timestamp, cambio y origen.
- [ ] Se revisan P2, P4, P6 y P7 antes de activar Completo.
