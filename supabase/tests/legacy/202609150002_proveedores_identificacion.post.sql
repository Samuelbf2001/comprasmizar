-- Post-check para 202609150002_proveedores_identificacion.sql, ejecutado JUSTO DESPUÉS de esa migración
-- sobre los datos legado de 202609150002_proveedores_identificacion.pre.sql. Sobre una base vacía el
-- backfill `identificacion = nit` y un no-op son indistinguibles; aquí sí: la fila con NIT debe salir
-- con identificación espejo, tipo NIT y no pendiente; la fila sin NIT, sin identificación (nada que
-- inventar) y también no pendiente (existía antes, no es un alta al vuelo).
do $$
declare v_tipo text; v_ident text; v_norm text; v_pendiente boolean;
begin
  select tipo_identificacion, identificacion, identificacion_normalizada, pendiente_normalizacion
    into v_tipo, v_ident, v_norm, v_pendiente
    from public.proveedores where id = '92000000-0000-4000-8000-000000000401';
  if v_tipo is distinct from 'NIT' or v_ident is distinct from '900.777.888-1' or v_norm is distinct from '9007778881' or v_pendiente then
    raise exception 'Backfill legado: el proveedor con NIT debía quedar NIT/900.777.888-1/9007778881/no pendiente (obtenido %/%/%/%)', v_tipo, v_ident, v_norm, v_pendiente;
  end if;

  select tipo_identificacion, identificacion, pendiente_normalizacion
    into v_tipo, v_ident, v_pendiente
    from public.proveedores where id = '92000000-0000-4000-8000-000000000402';
  if v_tipo is distinct from 'NIT' or v_ident is not null or v_pendiente then
    raise exception 'Backfill legado: el proveedor sin NIT debía quedar NIT/sin identificación/no pendiente (obtenido %/%/%)', v_tipo, v_ident, v_pendiente;
  end if;
end $$;
