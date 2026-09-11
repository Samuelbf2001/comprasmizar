-- Post-check para 202609070002_acceso_publico_global.sql, ejecutado JUSTO DESPUÉS de esa migración
-- sobre los datos legado sembrados por 202609070002_acceso_publico_global.pre.sql (ver el mecanismo
-- documentado en el encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md): una obra con
-- portal habilitado y un hash histórico POR OBRA, de antes de que el código pasara a ser GLOBAL.

-- 1) La obra legado sigue siendo insertable/actualizable SIN la constraint vieja
--    (obras_codigo_publico_check, que exigía hash propio cuando el portal estaba habilitado): se
--    prueba con un UPDATE real que la constraint vieja habría rechazado.
do $$ begin
  update public.obras set public_code_hash = null
   where id = '90000000-0000-0000-0000-000000000202' and public_submission_enabled;
  if not exists (
    select 1 from public.obras
    where id = '90000000-0000-0000-0000-000000000202' and public_code_hash is null and public_submission_enabled
  ) then
    raise exception 'La obra legado no pudo quedar con public_code_hash NULL tras la migración (la constraint vieja seguiría bloqueando)';
  end if;
end $$;

-- 2) verificar_codigo_publico (el código GLOBAL, hash en acceso_publico) devuelve false para el
--    código que era válido bajo el hash histórico POR OBRA — el hash de esa obra queda obsoleto y no
--    debe filtrarse ni interferir con la verificación global (que arranca sin hash configurado).
do $$ begin
  if public.verificar_codigo_publico('legado-obra-clave-vieja') is not false then
    raise exception 'verificar_codigo_publico debería devolver false (hash global aún sin configurar), aunque exista un hash histórico por obra que coincida';
  end if;
end $$;
