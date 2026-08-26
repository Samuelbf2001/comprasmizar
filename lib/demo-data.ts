export type Role = 'Revisor' | 'Solicitante' | 'Aprobador' | 'Contabilidad' | 'Administrador Mizar' | 'Administrador Sixteam';

export type RequestStatus = 'En revisión' | 'En aprobación' | 'Aprobada' | 'Devuelta' | 'Declinada';

export type Requisition = {
  id: string;
  requestor: string;
  initials: string;
  work: string;
  item: string;
  amount: number;
  status: RequestStatus;
  channel: 'Web' | 'WhatsApp' | 'Público';
  date: string;
  tag: string;
};

export const navigation = [
  { label: 'Inicio', href: '/', icon: 'LayoutDashboard' },
  { label: 'Nueva requisición', href: '/requisiciones/nueva', icon: 'PlusCircle' },
  { label: 'Mis requisiciones', href: '/requisiciones/mis', icon: 'ClipboardList' },
  { label: 'Revisión de Daniel', genericLabel: 'Revisión', href: '/revision', icon: 'Inbox', badge: '12' },
  { label: 'Aprobaciones', href: '/aprobaciones', icon: 'CheckCircle2', badge: '4' },
  { label: 'Órdenes', href: '/ordenes', icon: 'FileCheck2' },
  { label: 'Gastos y caja menor', href: '/gastos', icon: 'Receipt' },
  { label: 'Catálogos', href: '/catalogos', icon: 'Database' },
  { label: 'Proveedores', href: '/proveedores', icon: 'Truck' },
  { label: 'Mensajes Kapso', href: '/mensajes', icon: 'MessageSquare' },
  { label: 'Reportes', href: '/reportes', icon: 'BarChart3' },
];

export const requisitions: Requisition[] = [
  { id: 'REQ-2026-0147', requestor: 'Andrés Cárdenas', initials: 'AC', work: 'Altos de La Pradera', item: 'Cemento gris uso general', amount: 2480000, status: 'En revisión', channel: 'WhatsApp', date: 'Hoy · 08:42', tag: 'Materiales' },
  { id: 'REQ-2026-0146', requestor: 'Juliana Rojas', initials: 'JR', work: 'Casa Campestre El Retiro', item: 'Pago mano de obra — semana 33', amount: 1850000, status: 'En aprobación', channel: 'Web', date: 'Ayer · 17:20', tag: 'Nómina' },
  { id: 'REQ-2026-0145', requestor: 'Camilo Suárez', initials: 'CS', work: 'Bodega Industrial Norte', item: 'Tubería PVC 4” · 18 unidades', amount: 960000, status: 'Aprobada', channel: 'Público', date: 'Ayer · 15:08', tag: 'Materiales' },
  { id: 'REQ-2026-0144', requestor: 'Mariana Gil', initials: 'MG', work: 'Altos de La Pradera', item: 'Servicio de transporte', amount: 420000, status: 'Devuelta', channel: 'Web', date: '22 ago · 11:24', tag: 'Servicios' },
  { id: 'REQ-2026-0143', requestor: 'Andrés Cárdenas', initials: 'AC', work: 'Altos de La Pradera', item: 'Arena de revoque · 6 m³', amount: 1350000, status: 'Aprobada', channel: 'WhatsApp', date: '22 ago · 09:12', tag: 'Materiales' },
  { id: 'REQ-2026-0142', requestor: 'Luisa Fernanda', initials: 'LF', work: 'Edificio San Marcos', item: 'Caja menor — ferretería', amount: 186000, status: 'Declinada', channel: 'Web', date: '21 ago · 16:31', tag: 'Caja menor' },
];

export const works = ['Altos de La Pradera', 'Casa Campestre El Retiro', 'Bodega Industrial Norte', 'Edificio San Marcos', 'Torres del Río'];

export const items = [
  { name: 'Cemento gris uso general', category: 'Materiales', unit: 'Bulto', uses: 48, state: 'Activo' },
  { name: 'Arena de revoque', category: 'Materiales', unit: 'm³', uses: 36, state: 'Activo' },
  { name: 'Tubería PVC 4”', category: 'Plomería', unit: 'Unidad', uses: 22, state: 'Activo' },
  { name: 'Varilla corrugada 3/8”', category: 'Materiales', unit: 'Unidad', uses: 17, state: 'Activo' },
  { name: 'Pintura vinilo blanco', category: 'Acabados', unit: 'Galón', uses: 9, state: 'Pendiente normalización' },
];

export const suppliers = [
  { name: 'Cementos del Oriente SAS', nit: '901.234.567-1', contact: 'Paola Méndez', phone: '+57 310 442 18 90', orders: 18, state: 'Activo' },
  { name: 'Arenera Chicamocha', nit: '900.876.432-8', contact: 'Jorge Pineda', phone: '+57 315 009 21 44', orders: 7, state: 'Documentos pendientes' },
  { name: 'Ferretería El Constructor', nit: '800.445.123-6', contact: 'Mónica León', phone: '+57 301 880 76 32', orders: 23, state: 'Activo' },
  { name: 'Transportes La Sabana', nit: '901.887.002-4', contact: 'Víctor Salazar', phone: '+57 320 455 08 19', orders: 11, state: 'Activo' },
];

export const orders = [
  { id: 'OC-2026-0098', request: 'REQ-2026-0145', supplier: 'Ferretería El Constructor', work: 'Bodega Industrial Norte', amount: 960000, state: 'Pendiente de entrega', date: '23 ago 2026' },
  { id: 'OC-2026-0097', request: 'REQ-2026-0143', supplier: 'Arenera Chicamocha', work: 'Altos de La Pradera', amount: 1350000, state: 'Cumplida', date: '22 ago 2026' },
  { id: 'OC-2026-0096', request: 'REQ-2026-0139', supplier: 'Cementos del Oriente SAS', work: 'Casa Campestre El Retiro', amount: 3200000, state: 'Pendiente de entrega', date: '21 ago 2026' },
  { id: 'OP-2026-0021', request: 'REQ-2026-0141', supplier: 'Transportes La Sabana', work: 'Torres del Río', amount: 485000, state: 'Cumplida', date: '20 ago 2026' },
];

export const formatMoney = (value: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value);

export const statusTone: Record<string, string> = {
  'En revisión': 'warning',
  'En aprobación': 'blue',
  Aprobada: 'success',
  Devuelta: 'danger',
  Declinada: 'muted',
  Cumplida: 'success',
  'Pendiente de entrega': 'warning',
  'Documentos pendientes': 'warning',
  Activo: 'success',
};
