-- ÓRDENES DE PAGO Y CAJA MENOR — paquete N4.2 (RF-601, riesgo dejado en ESTADO.md de N2). Desde
-- 202609150002 el catálogo de proveedores admite PERSONAS (CC/CE/PAS), y dos personas pueden llamarse
-- igual con cédulas distintas — dos "Juan Pérez" maestros de obra son un caso real, no hipotético. El
-- índice único funcional de razón social de 202608240001 (`proveedores_razon_social_normalizada_unico_idx`,
-- pensado cuando todo proveedor era una empresa con NIT) lo impedía.
--
-- La unicidad de nombre pasa a valer SOLO entre empresas (tipo NIT); entre personas la identidad es su
-- identificación (`proveedores_identificacion_unico_idx`, ya vigente). Un índice único no se puede
-- "apagar": la única forma de cambiar su alcance es recrearlo, con el MISMO nombre y la misma expresión
-- más el predicado — el mismo patrón recrear-por-nombre con el que este repo trata triggers, policies y
-- constraints (`drop ... if exists` + `create`); no se dropea ninguna columna ni tabla. El arnés
-- `schema_verification.sql` sigue encontrándolo por nombre, como UNIQUE y sobre `lower(btrim(razon_social))`.
drop index if exists public.proveedores_razon_social_normalizada_unico_idx;
create unique index if not exists proveedores_razon_social_normalizada_unico_idx
  on public.proveedores(lower(btrim(razon_social))) where tipo_identificacion = 'NIT';
