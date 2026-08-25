# Gates externos de salida a producción

El código puede construirse y probarse localmente, pero estos gates necesitan personas, cuentas o datos de Mizar. No deben marcarse como aprobados mediante datos inventados.

| Gate | Evidencia requerida | Dueño PRD | Estado inicial |
|---|---|---|---|
| Cuenta y número Kapso | Cuenta autorizada, sandbox, número de producción y plantillas aprobadas | Ernesto + Samuel | Bloqueado por acceso |
| Supabase dev/prod | Proyectos en São Paulo, secretos rotados, migraciones y RLS verificadas | Samuel | Bloqueado por acceso |
| VPS y dominio | SSH por llaves, firewall, DNS, TLS y alerta de uptime | Samuel | Bloqueado por acceso |
| Maestros reales | CC2-02, gastos históricos, ítems, proveedores, obras y usuarios | Mizar | No suministrados |
| P1 impuestos/Helisa | Archivo de carga aceptado por contabilidad | Ernesto + contabilidad | Abierto |
| P2 acceso público | Validación enlace+código o lista de teléfonos | Ernesto + Daniel | Abierto |
| P3 reparto | Confirmación de reparto manual por montos | Ernesto + Daniel | Abierto |
| P4 formatos | Logos, membretes y aprobación visual de PDF OC/reporte | Ernesto + Claudia/Daniel | Abierto |
| Paridad contable | Mes real cargado y diferencia de exportación igual a cero | Contabilidad + QA | Bloqueado por dataset |
| Restauración | Restore exitoso desde Supabase y copia fría | Samuel + QA | Bloqueado por infraestructura |
| UAT/capacitación | Recorridos reales y acta de aceptación por los cuatro roles | Mizar + Ernesto | Pendiente |

## Evidencia local que no cierra estos gates

El 24-ago-2026 pasaron lint, tipos, 77 pruebas unitarias/integración, cobertura del dominio (97,72 % líneas/sentencias, 93,58 % ramas y 100 % funciones), build, auditoría de dependencias sin vulnerabilidades y 22 E2E demo en escritorio/móvil. Otros 14 E2E quedan omitidos de forma explícita porque requieren Auth/backend real. También se comprobó el fail-closed de Auth en el build y se revisó visualmente el PDF provisional. Los contratos locales de expediente de proveedor y adjuntos privados cubren carga firmada multipart, verificación server-side y descarga autorizada. Esta evidencia aprueba el checkout como base técnica local, pero no sustituye migración SQL/RLS ejecutada, Storage Supabase real, credenciales, datos reales, plantillas Kapso, paridad, restore, despliegue o firmas UAT.
