# Plataforma de Mizar

Monolito modular para requisiciones, aprobaciones, órdenes y gastos de obra. La aplicación sigue el alcance de [PRD.md](./PRD.md). Desde el 10 de septiembre de 2026 todo es autoalojado: Next.js, Postgres, autenticación y almacenamiento corren en el VPS Hostinger, con respaldo diario a Google Drive. Ver [docs/migracion-autoalojado.md](./docs/migracion-autoalojado.md).

## Arranque local

Requisitos: Node.js 24 y npm 11. **No hace falta Docker ni la CLI de Supabase**: `scripts/dev-db.ts` levanta un Postgres real con `embedded-postgres`, el mismo motor (18.x) que corre en el VPS.

```powershell
Copy-Item .env.example .env.local
npm install
```

Completa en `.env.local` las tres variables del núcleo — `DATABASE_URL`, `STORAGE_ROOT` y `STORAGE_SIGNING_SECRET` — y levanta base y aplicación en dos terminales:

```powershell
npx tsx scripts/dev-db.ts   # bootstrap + migraciones + seed + datos demo; se queda escuchando
npm run dev
```

`dev-db.ts` sirve en `postgresql://postgres:postgres@127.0.0.1:55432/mizar_dev`. Acepta `--reset` (recrear el cluster desde cero) y `--no-demo` (solo los maestros, sin movimiento).

### Usuarios de prueba

`supabase/seed.sql` crea siete cuentas de demostración (el equipo de Mizar como cuentas demo, más las administrativas), todas con la contraseña `local-only-change-me`:

| Correo | Rol |
|---|---|
| `solicitante.demo@mizar.test` | Solicitante (Solicitante Demo) |
| `daniel.demo@mizar.test` | Revisor (Daniel Demo) |
| `nelson.demo@mizar.test` | Aprobador (Nelson Demo) |
| `juliana.demo@mizar.test` | Aprobador (Juliana Demo) |
| `claudia.demo@mizar.test` | Contabilidad (Claudia Demo) |
| `admin-mizar.demo@mizar.test` | Administrador Mizar |
| `admin-sixteam.demo@mizar.test` | Administrador Sixteam |

`supabase/seed-demo.sql` añade el movimiento: diez requisiciones repartidas por todos los estados del embudo, cinco órdenes con sus estados administrativos, gastos pagados y sin pagar, y caja menor. Las fechas son relativas al día de hoy, así que el dashboard nunca sale vacío. **Nunca se aplica en producción.**

Para recorrer la maqueta sin base de datos está `npm run dev:demo` (`NEXT_PUBLIC_DEMO_MODE=true`); no persiste ni llama endpoints de escritura.

La maqueta solo se habilita con `NEXT_PUBLIC_DEMO_MODE=true`; cualquier otro valor falla cerrado hacia Auth. El modo demo no persiste ni llama los endpoints de escritura. En producción, la UI autenticada muestra un gate de integración en vez de cifras sintéticas hasta conectar sus lecturas/escrituras. Auth, Storage, Kapso, MCP y toda operación persistente requieren completar las variables, aplicar las migraciones y superar los gates externos.

## Verificación

```powershell
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:e2e
npm run verify:schema
```

`npm run verify:schema` corre las migraciones y los 3 arneses SQL de `supabase/tests/` contra un
Postgres real (motor embebido, sin Docker) — ver [docs/modelo-datos.md](./docs/modelo-datos.md#verificación-ejecutable).
Los tests unitarios con mocks no ven los códigos de error reales de Postgres ni sus columnas
`NOT NULL`; este script sí.

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

- `lint`, tipos, 83 pruebas unitarias/integración, cobertura de `lib/domain` (97,72 % líneas/sentencias, 93,58 % ramas y 100 % funciones) y build de producción pasan.
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
