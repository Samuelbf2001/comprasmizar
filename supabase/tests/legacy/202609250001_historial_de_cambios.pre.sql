-- Datos legado para 202609250001_historial_de_cambios.sql: una excepción de permisos ya guardada desde
-- Configuración → Permisos por rol, como la que podría existir en producción, ANTES de que existieran
-- los permisos del 25-sep-2026. Revisor sin payment:register (una decisión que hay que respetar),
-- admin_mizar con su default viejo, admin_sixteam con "*", y contabilidad (que no recibe nada).
insert into public.configuracion (clave, valor)
values ('permisos_por_rol_v1', jsonb_build_object(
  'revisor', jsonb_build_array('requisition:create', 'requisition:read', 'requisition:review', 'item:manage', 'supplier:manage', 'order:read', 'dashboard:read'),
  'admin_mizar', jsonb_build_array('requisition:create', 'catalog:manage', 'supplier:manage', 'dashboard:read', 'expense:read', 'report:read', 'report:export'),
  'admin_sixteam', jsonb_build_array('*'),
  'contabilidad', jsonb_build_array('order:read', 'order:account', 'dashboard:read')
))
on conflict (clave) do update set valor = excluded.valor;
