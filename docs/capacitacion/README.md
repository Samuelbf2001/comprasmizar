# Capacitación y aceptación de Mizar

Este paquete organiza una sesión práctica sobre la demo y deja preparado el registro de UAT del modo conectado. No sustituye la validación contra datos reales, el acta de aceptación ni los gates de producción.

## Materiales

- [Plan, guion y asistencia](plan-y-asistencia.md)
- [Recorridos de aceptación](recorridos-aceptacion.md)

## Cómo usarlo

1. Hacer una explicación breve por rol.
2. Ejecutar primero la demo navegable, etiquetando cada interacción como `DEMO / SIN PERSISTENCIA`.
3. Repetir los recorridos sobre un entorno aislado con migraciones aplicadas, datos y usuarios de prueba autorizados; añadir Kapso cuando el canal y sus plantillas estén disponibles.
4. Registrar hallazgos y gates abiertos; no marcar aceptación solo porque una pantalla renderiza.
