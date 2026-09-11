-- Fase 3 del plan de rendimiento (docs/plan-rendimiento.md, hallazgo H3): índices para las nuevas
-- consultas paginadas por cursor (requisiciones/órdenes/gastos/caja menor) y para los agregados del
-- dashboard (lib/infrastructure/postgres-repositories.ts: listVisibleTo con query, listVisibleHeaders,
-- dashboardByStatus, listAttentionCandidates, listRecentlyUpdated, dashboardPendingCount,
-- dashboardAggregates). Todo aditivo: solo `create index if not exists`, nada de DROP.
--
-- NOTA para el revisor (decisión deliberada, ver el comentario junto a listVisibleExpenses en
-- postgres-repositories.ts): la paginación de `gastos` ordena/pagina por `fecha_orden` (nace con el
-- registro, NUNCA nula), no por `fecha` (fecha de PAGO, nula mientras la orden no se ha pagado desde
-- 202609070003_gasto_fecha_pago.sql) — un cursor de teclado sobre una columna nullable rompe la
-- comparación de tupla `(a, b) < (cursor)` en SQL. Por eso esta migración crea AMBOS índices sobre
-- gastos: `gastos_fecha_idx` (la columna que se pidió en el plan, usada por los filtros from/to y por
-- inProcessValue/periodExpense) y `gastos_fecha_orden_id_idx` (la que de verdad usa la paginación).

-- gastos(referencia_id): listByReference/deleteExpenseByReference/dashboardAggregates filtran por esta
-- columna sola; el único índice existente que la toca es el unique (origen, referencia_id), con
-- "origen" como columna líder — no sirve para un filtro que solo trae referencia_id.
create index if not exists gastos_referencia_idx on public.gastos(referencia_id);
-- gastos(fecha): pedido explícito del plan ("fecha_pago") — fecha de PAGO. Usado por los filtros
-- from/to de listVisibleExpenses y por dashboardAggregates (periodExpense/inProcessValue filtran o
-- excluyen por esta columna). Un índice btree normal ya cubre `is null` además de los rangos.
create index if not exists gastos_fecha_idx on public.gastos(fecha);
-- gastos(fecha_orden desc, id desc): la paginación por cursor de gastos usa esta columna (ver NOTA
-- arriba) — NOT NULL, así que la comparación de tupla del cursor nunca choca con NULL.
create index if not exists gastos_fecha_orden_id_idx on public.gastos(fecha_orden desc, id desc);

-- requisiciones(updated_at desc): pedido explícito del plan — actividad reciente del dashboard
-- (listVisibleHeaders con orderBy "updated_at").
create index if not exists requisiciones_updated_at_idx on public.requisiciones(updated_at desc);
-- requisiciones(created_at desc, id desc): la paginación general (sin filtro de estado) no la cubre
-- ningún índice existente — requisiciones_revision_idx lidera con "estado", no sirve para una consulta
-- sin ese filtro; este cubre el caso general y sirve de red de seguridad para cualquier filtro que no
-- calce con los índices compuestos ya existentes (obra_id/etiqueta_id/aprobador_id/solicitante_id).
create index if not exists requisiciones_created_at_id_idx on public.requisiciones(created_at desc, id desc);

-- ordenes(updated_at desc): pedido explícito del plan — actividad reciente del dashboard
-- (listRecentlyUpdated de órdenes).
create index if not exists ordenes_updated_at_idx on public.ordenes(updated_at desc);
-- ordenes(fecha_generacion desc, id desc): la paginación por cursor de órdenes usa esta columna (NOT
-- NULL) — ordenes_requisicion_idx/ordenes_estado_idx ya ordenan por fecha_generacion desc pero lideran
-- con requisicion_id/estado_cumplimiento respectivamente, no sirven para el caso sin esos filtros.
create index if not exists ordenes_fecha_generacion_id_idx on public.ordenes(fecha_generacion desc, id desc);

-- caja_menor(fecha desc, id desc): la paginación por cursor de caja menor (Entregable A) — `fecha` es
-- NOT NULL en esta tabla (se paga en el acto, reunión 2026-09), así que filtro y orden pueden compartir
-- la misma columna sin el problema de NULLs que sí tiene `gastos.fecha`.
create index if not exists caja_menor_fecha_id_idx on public.caja_menor(fecha desc, id desc);
