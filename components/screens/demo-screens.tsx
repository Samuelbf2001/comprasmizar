// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): barrel de las pantallas DEMO
// (sin datos conectados) que components/mizar-app.tsx usaba antes por import estático. En
// producción (demoMode=false) ninguna de ellas se renderiza nunca — ver
// isConnectedReadRoute/ConnectedScreen en ./connected — así que mizar-app.tsx las carga con
// next/dynamic, una por una y por nombre, apuntando a ESTE barrel (ver "Importing Named
// Exports" en node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md). El barrel en sí
// (este archivo) SÍ importa cada módulo de forma estática: eso es intencional y necesario
// para poder reexportar por nombre; lo que importa para el bundle es que mizar-app.tsx no
// importe este archivo de forma estática (lo verifica tests/unit/bundle-boundaries.test.ts).
export { DashboardScreen } from "./dashboard";
export { ReviewScreen, ApprovalsScreen, RequestDetailScreen } from "./workflow";
export { OrdersScreen, ExpensesScreen } from "./operations";
export { ReportsScreen, AdminScreen } from "./reports-admin";
