-- Post-check para 202609070001_aprobador_elegido.sql, ejecutado JUSTO DESPUÉS de esa migración sobre
-- los datos legado sembrados por 202609070001_aprobador_elegido.pre.sql (ver el mecanismo documentado
-- en el encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md): una etiqueta activa cuyo
-- aprobador ya estaba inactivo, y una requisición etiquetada con ella.
--
-- Por qué existe: sobre una base VACÍA (el resto de este arnés, aprobador_elegido_verification.sql)
-- no hay ninguna requisición previa con ese perfil para backfillear, así que un backfill sin filtro de
-- elegibilidad y uno correcto son indistinguibles ahí. Este archivo sí distingue: el backfill de la
-- migración copia `etiquetas.aprobador_id` a `requisiciones.aprobador_id` para toda fila con
-- aprobador_id NULL — SIN el filtro `public.es_aprobador_elegible(e.aprobador_id)`, copiaría aquí un
-- aprobador YA INACTIVO, sembrando el mismo problema (una requisición con un aprobador no elegible)
-- que esta migración existe para resolver.
do $$
declare v_aprobador uuid;
begin
  select aprobador_id into v_aprobador from public.requisiciones where id = '90000000-0000-0000-0000-000000000106';
  if v_aprobador is not null then
    raise exception 'El backfill copió un aprobador NO elegible (etiqueta legado con aprobador inactivo) a requisiciones.aprobador_id: %', v_aprobador;
  end if;
end $$;

-- Limpieza necesaria (a diferencia de los otros dos pares .pre/.post de esta tarea, que no la
-- necesitan por namespace de IDs propio): esta fila SÍ choca con un invariante GLOBAL que corre más
-- adelante en el mismo pipeline — schema_verification.sql (~línea 270) exige que NINGUNA etiqueta
-- activa de TODA la base tenga un aprobador no elegible. Dejar 'Legado AE Etiqueta' activa (con su
-- aprobador ya inactivo) haría fallar ese arnés, que este cambio tiene prohibido tocar. Desactivarla
-- es información de negocio legítima en sí misma (una etiqueta con aprobador roto no debería seguir
-- activa) y no revierte nada de lo que este .post.sql acaba de comprobar arriba.
update public.etiquetas set activa = false where id = '90000000-0000-0000-0000-000000000105';
