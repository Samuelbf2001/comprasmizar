# Manual del solicitante

## Propósito

Crear una requisición de compra o pago una sola vez y poder seguir su estado, sin volver a escribirla para Daniel.

## Cómo hacerlo en el producto conectado

1. Entra con tu usuario y contraseña, o usa el enlace público autorizado por tu obra.
2. Selecciona la obra, fecha requerida, tipo de solicitud y destino. La etiqueta contable se asigna durante la revisión.
3. Agrega cada ítem desde el catálogo maestro: cantidad y unidad. Si no existe, usa la propuesta de ítem nuevo; no normalices nombres por tu cuenta.
4. Añade posible proveedor, enlace, observaciones y foto/PDF cuando ayuden a comprar.
5. Revisa los campos obligatorios y envía. Conserva el consecutivo de la requisición.
6. Consulta **Mis requisiciones** para ver recibida, en revisión, en aprobación, aprobada, devuelta o declinada.

Una requisición devuelta vuelve a Daniel con el motivo del aprobador. Una declinada no se borra y no debe generar gasto.

## Formulario público

La única superficie sin login completo es el formulario público y solo puede crear requisiciones. En producción, el enlace lleva la capacidad en el fragmento `#` —se elimina del navegador antes de enviar— y el servidor exige además el código de obra, teléfono autorizado cuando aplique y límites de tasa. En demo no se persiste nada y el resultado lo declara explícitamente. El código no debe ponerse en una URL ni compartirse en chats.

## WhatsApp

Cuando el canal conectado esté habilitado, el WhatsApp Flow de Kapso recoge tipo, obra, ítems, cantidad, posible proveedor, enlace y foto. No uses el celular personal de Daniel ni envíes credenciales. Consulta la [guía de WhatsApp](whatsapp-kapso.md).

## Qué está disponible hoy

`/requisiciones/publica` mantiene demo mobile-first y un formulario real separado cuando el gate público está configurado. `/requisiciones/nueva`, `/requisiciones/mis` y el detalle consumen el backend autenticado fuera de demo. La carga de adjuntos y la validación contra el CC2-02 real siguen pendientes; sin Supabase/migraciones configurados las rutas fallan cerradas y no muestran cifras sintéticas.

## Aceptación del solicitante

- [ ] Puedo crear una requisición de compra real y una de pago sin re-digitación.
- [ ] El catálogo muestra unidades y puedo proponer un ítem nuevo.
- [ ] Recibo y entiendo el consecutivo y cada estado.
- [ ] Una devolución muestra el motivo; una declinación queda consultable.
