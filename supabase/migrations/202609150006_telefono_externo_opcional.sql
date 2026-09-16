-- QA adversarial de la adenda de pagos y caja (H2, docs/qa/QA-pagos-y-caja.md): desde el 11-sep el
-- teléfono del solicitante externo es OPCIONAL (decisión de Ernesto; RF-108; ya reflejado en
-- lib/http/schemas.ts y en el servicio, que insertan NULL sin problema). Pero
-- `requisiciones_solicitante_check` (202608240001) seguía exigiendo AMBOS —nombre y teléfono— para
-- todo solicitante externo, así que cualquier radicación sin teléfono (portal o WhatsApp, compra o
-- pago) violaba el CHECK y el catch de la ruta lo traducía en un 503 que perdía la solicitud entera.
--
-- Un CHECK no se "afloja" en el sitio: se recrea con el MISMO nombre y la condición nueva (mismo
-- patrón recrear-por-nombre que 202609150002/202609150005). Aditiva e idempotente: ningún DROP TABLE,
-- ninguna columna se toca — `solicitante_telefono_externo` sigue existiendo y se sigue guardando
-- cuando llega.
alter table public.requisiciones drop constraint if exists requisiciones_solicitante_check;
alter table public.requisiciones add constraint requisiciones_solicitante_check check (
  solicitante_id is not null or solicitante_nombre_externo is not null
);
