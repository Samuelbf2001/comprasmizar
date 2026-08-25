# Plataforma de Mizar

Monolito modular para requisiciones, aprobaciones, órdenes y gastos de obra. La aplicación sigue el alcance de [PRD.md](./PRD.md): Next.js en VPS Hostinger y Postgres, Auth y Storage gestionados por Supabase.

## Arranque local

Requisitos: Node.js 24, npm 11, Docker y Supabase CLI para usar la base local.

```powershell
Copy-Item .env.example .env.local
# Solo para recorrer la maqueta local sin datos ni escrituras:
(Get-Content .env.local) -replace 'NEXT_PUBLIC_DEMO_MODE=false', 'NEXT_PUBLIC_DEMO_MODE=true' | Set-Content .env.local
npm install
npm run dev
```

La maqueta solo se habilita con `NEXT_PUBLIC_DEMO_MODE=true`; cualquier otro valor falla cerrado hacia Auth. El modo demo no persiste ni llama los endpoints de escritura. En producción, la UI autenticada muestra un gate de integración en vez de cifras sintéticas hasta conectar sus lecturas/escrituras. Auth, Storage, Kapso, MCP y toda operación persistente requieren completar las variables, aplicar las migraciones y superar los gates externos.

## Verificación

```powershell
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:e2e
```

## Estructura

- `app/`: rutas, UI y endpoints del monolito.
- `components/`: sistema visual y componentes de negocio.
- `lib/domain/`: reglas puras sin dependencias de infraestructura.
- `lib/services/`: casos de uso, autorización y puertos de repositorio.
- `supabase/`: migraciones, RLS y datos semilla.
- `ops/`: contenedor, proxy, respaldo y verificación de restauración.
- `tests/`: pruebas unitarias, integración y recorridos E2E.
- `docs/`: decisiones, runbooks y trazabilidad del PRD.

## Fronteras de seguridad

- La autorización se aplica en la capa de servicios y RLS es la segunda barrera.
- El endpoint público solo crea requisiciones después de validar obra, código, teléfono autorizado y límite por IP; la pantalla demo no lo invoca.
- Los adjuntos se sirven con URLs firmadas; ningún bucket sensible es público.
- Las API keys MCP se almacenan mediante hash, heredan un usuario y no pueden aprobar ni devolver requisiciones.
- El webhook Kapso exige firma, usa un ledger durable para reintentos y conserva un log propio ligado a la requisición. Los adjuntos del Flow fallan cerrado hasta configurar su copia al bucket privado. La bandeja de conversación es un iframe HTTPS del proveedor, no una mensajería paralela.

## Estado verificable de este checkout

- `lint`, tipos, 77 pruebas unitarias/integración, cobertura de `lib/domain` (97,72 % líneas/sentencias, 93,58 % ramas y 100 % funciones) y build de producción pasan.
- El E2E demo pasa 22 recorridos en escritorio/móvil; 14 casos de Auth/backend real quedan omitidos explícitamente por falta de entorno y fixtures.
- Proveedores y adjuntos operativos tienen contratos locales de extremo a extremo: expediente privado, carga firmada multipart, verificación server-side de tamaño/MIME, listado y descarga autorizada. Esto no equivale a un E2E contra Supabase.
- El build con demo desactivado redirige `/` y `/revision` a login y `/api/health` responde `unconfigured` sin revelar secretos.
- Las migraciones y el arnés SQL existen, pero no se ejecutaron aquí: no hay daemon Docker, Supabase CLI ni `psql` disponibles.
- No se desplegó Supabase, VPS, dominio o Kapso y no se afirma UAT, paridad Helisa, restore ni datos reales.

Los enlaces públicos se generan solo en un entorno autorizado; la capacidad viaja en el fragmento `#` para no entrar en logs HTTP y el código de obra sigue siendo un segundo factor separado:

```powershell
npx tsx scripts/generate-public-link.ts 00000000-0000-4000-8000-000000000000
```

## Entornos externos pendientes

El repositorio no aprovisiona por sí solo cuentas de terceros. Para una salida real todavía se necesitan las credenciales autorizadas de Supabase, VPS, dominio y Kapso, además de los formatos y datos fuente de Mizar enumerados en `docs/gates-externos.md`. Ningún secreto debe entrar al repositorio.
