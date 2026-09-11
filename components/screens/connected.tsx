// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): este archivo era
// components/screens/connected.tsx completo (4 672 líneas: tipos, capa de datos, gráficos
// recharts y las 7 pantallas conectadas en un solo módulo, que cualquier rol descargaba
// entero en cualquier ruta). Ahora es solo un barrel que reexporta el mismo API público
// desde components/screens/connected/*, para que los tests existentes (que importan desde
// "../../components/screens/connected") sigan funcionando sin cambios. El código real vive en:
//   - connected/shared.tsx           tipos y helpers puros (sin recharts, sin pantallas)
//   - connected/data.ts              routeKind/loadRoute/caché/mutate (sin React)
//   - connected/dashboard-charts.tsx único módulo que importa `recharts`
//   - connected/dashboard.tsx        ConnectedDashboard (carga los gráficos con next/dynamic)
//   - connected/new-requisition.tsx  ConnectedNewRequisition, DemoRequisitionScreen
//   - connected/requisitions.tsx     ConnectedRequisitions
//   - connected/detail.tsx           ConnectedRequisitionDetail
//   - connected/orders.tsx           ConnectedOrders
//   - connected/expenses.tsx         ConnectedExpenses
//   - connected/screen.tsx           ConnectedScreen (carga cada pantalla con next/dynamic)
// components/mizar-app.tsx NO importa este barrel: importa ConnectedScreen desde
// "./screens/connected/screen" e isConnectedReadRoute desde "./screens/connected/data"
// directamente, para no arrastrar (ni siquiera por tipos) las pantallas pesadas.
export { groupExpensesByWorkAndTag } from "./connected/shared";
export { clearRouteCache, isConnectedReadRoute } from "./connected/data";
export { ConnectedScreen } from "./connected/screen";
export { ConnectedDashboard } from "./connected/dashboard";
export { ConnectedNewRequisition, DemoRequisitionScreen } from "./connected/new-requisition";
export { ConnectedRequisitions } from "./connected/requisitions";
export { ConnectedRequisitionDetail } from "./connected/detail";
export { ConnectedOrders } from "./connected/orders";
export { ConnectedExpenses } from "./connected/expenses";
