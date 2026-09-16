"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedRequisitionDetail,
// partido de components/screens/connected.tsx. Misma lógica, mismos nombres.
//
// Rediseño "una acción por estado y rol" (dueño del producto, reunión 2026-09, inspirado en
// PatternFly overflow menu / GitLab Pajamas autosave / NN/g progressive disclosure / Precoro):
// antes esta pantalla enseñaba media docena de botones a la vez (Guardar revisión, Enviar a
// aprobación, Editar cabecera, Subir cotización, Crear proveedor, Declinar…) y el dueño del
// producto lo resumió así: "demasiados botones para avanzar en el flujo". Ahora cada estado/rol
// tiene UNA acción primaria (barra pegajosa al pie del panel de ítems), las secundarias viven en
// un menú «Más ⋯», el formulario se autoguarda y el motivo de una acción irreversible se escribe
// DENTRO de su diálogo de confirmación en vez de en una `<textarea>` siempre visible.
import { Fragment, useEffect, useRef, useState } from "react";
import { Check, RotateCw, X } from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import { ActionMenu, SectionTitle, Tone, useConfirmDialog } from "../screen-primitives";
import { AttachmentPicker } from "../attachment-upload";
import { SupplierQuickCreate, type QuickSupplier } from "../supplier-quick-create";
import { friendlyErrorText } from "../../../lib/http/friendly-error";
import {
  emptyCatalogs,
  estadoLabel,
  estimateLineTotal,
  eventLabel,
  formatIsoDate,
  money,
  pendingBeneficiaryId,
  resolveUserName,
  summarizeLines,
  supplierFichaPath,
  uploadOperationalAttachment,
  type DetailBundle,
  type NamedOption,
  type RequisitionItem,
} from "./shared";
import { mutate } from "./data";

/**
 * Autoguardado (contrato del servidor intacto: sigue siendo el mismo `mutate`/PATCH/acción de
 * siempre, solo cambia QUIÉN lo dispara). Vive junto a `run` porque resuelve el mismo problema
 * desde el otro lado: `run` guarda-y-actúa cuando el usuario pulsa un botón; `useAutosave` guarda
 * solo, sin que nadie tenga que pulsar nada, mientras la persona sigue escribiendo.
 *
 * Reglas (dueño del producto): un disparo por `blur` de cualquier campo Y uno por 1.500 ms de
 * inactividad; un solo vuelo a la vez con coalescencia (si llega un cambio mientras hay uno en
 * curso, se reintenta con el estado más reciente al terminar, nunca se pierde); nunca reenvía si
 * el JSON es idéntico al último guardado con éxito. Usa `mutate` (no `run`): `run` marca `busy` y
 * tapa la pantalla con el candado de guardado; el autoguardado tiene que ser invisible mientras
 * los datos son válidos.
 */
type AutosaveStatus = "idle" | "saving" | "saved" | "blocked" | "error";

function useAutosave({
  enabled,
  blockedReason,
  buildBody,
  send,
}: {
  enabled: boolean;
  blockedReason: string | null;
  buildBody: () => Record<string, unknown> | null;
  send: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [savedAt, setSavedAt] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const lastSavedRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `latestRef`/`attemptRef` se actualizan desde un efecto (nunca durante el render: React 19
  // prohíbe mutar un ref mientras se renderiza) — `attemptRef.current` se define UNA sola vez y
  // lee `latestRef.current` en el momento en que de verdad se ejecuta (un blur o un timeout,
  // siempre después de que el efecto ya corrió), así que igual siempre ve los valores últimos.
  const latestRef = useRef({ enabled, blockedReason, buildBody, send });
  useEffect(() => {
    latestRef.current = { enabled, blockedReason, buildBody, send };
  });

  const attemptRef = useRef<() => void>(() => {});
  useEffect(() => {
    attemptRef.current = () => {
      const current = latestRef.current;
      if (!current.enabled) return;
      if (current.blockedReason) {
        setStatus("blocked");
        return;
      }
      const body = current.buildBody();
      if (!body) return;
      const json = JSON.stringify(body);
      if (json === lastSavedRef.current) return;
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      setStatus("saving");
      void current
        .send(body)
        .then(() => {
          lastSavedRef.current = json;
          dirtyRef.current = false;
          setStatus("saved");
          setSavedAt(new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }));
        })
        .catch((error: unknown) => {
          setStatus("error");
          setErrorMessage(friendlyErrorText(error, "No se pudo guardar."));
        })
        .finally(() => {
          inFlightRef.current = false;
          if (pendingRef.current) {
            pendingRef.current = false;
            attemptRef.current();
          }
        });
    };
  }, []);

  const scheduleDebounced = () => {
    dirtyRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => attemptRef.current(), 1500);
  };
  const onBlurCapture = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    attemptRef.current();
  };
  const retry = () => attemptRef.current();

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  // Solo con cambios SIN CONFIRMAR (guardado en curso o pendiente de reintento): un guardado ya
  // exitoso no debe seguir bloqueando el cierre de la pestaña.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // "blocked" se deriva directamente de `blockedReason` en vez de sincronizarse vía otro efecto
  // (que dispararía un re-render en cascada): así se ve de inmediato, en el mismo render en que
  // el campo que faltaba se completa o se rompe, sin esperar al próximo intento de guardado.
  const effectiveStatus: AutosaveStatus = blockedReason ? "blocked" : status;
  return { status: effectiveStatus, savedAt, errorMessage, scheduleDebounced, onBlurCapture, retry };
}

type Autosave = ReturnType<typeof useAutosave>;

/** Indicador `aria-live="polite"` de la barra pegajosa: «Guardando…» / «Guardado 10:42» /
 *  «Sin guardar: <motivo>» + «Reintentar». Nunca un toast rojo por estar tecleando: los estados
 *  "blocked"/"error" se leen como aviso, no como fallo del usuario. */
function AutosaveIndicator({ autosave, blockedReason }: { autosave: Autosave; blockedReason: string | null }) {
  return (
    <span className="autosave-indicator" role="status" aria-live="polite">
      {autosave.status === "saving" && "Guardando…"}
      {autosave.status === "saved" && `Guardado ${autosave.savedAt}`}
      {autosave.status === "blocked" && `Sin guardar: ${blockedReason ?? ""}`}
      {autosave.status === "error" && (
        <>
          Sin guardar: {autosave.errorMessage}{" "}
          <button type="button" className="text-link" onClick={autosave.retry}>
            Reintentar
          </button>
        </>
      )}
    </span>
  );
}

type MissingField = "tag" | "work" | "approver" | "price" | null;

// Campos que la ola 1 añadió al servidor (N3) y que shared.tsx (fuera de este paquete) todavía no
// declara: `billedCompanyId` en la requisición y `societyId` en cada centro de costo del bootstrap
// (GET /api/catalogs ya lo trae). Se leen como opcionales para no depender de ese parche.
type BilledCompanyAware = { billedCompanyId?: string };
type CostCenterOption = NamedOption & { societyId?: string };

export function ConnectedRequisitionDetail({
  data,
  role,
  go,
  refresh,
}: {
  data: DetailBundle;
  role: Role;
  go: (path: string) => void;
  /** Recarga los datos de la ruta. Devuelve una promesa: espérala antes de soltar el estado ocupado,
   *  o la pantalla se rehabilita mostrando todavía los datos anteriores. */
  refresh: () => void | Promise<void>;
}) {
  const {
    requisition,
    catalogs = emptyCatalogs,
    orders = [],
    expenses = [],
    history = [],
    attachments = [],
  } = data;
  const [tagId, setTagId] = useState(requisition.tagId ?? ""),
    // Reunión 2026-09: el aprobador lo elige el revisor (ya no lo deriva la etiqueta). Se inicializa con
    // el ya asignado si lo hay; elegir una etiqueta con aprobador por defecto lo prerellena SOLO si esto
    // sigue vacío (ver el onChange de la etiqueta, abajo) — nunca pisa una elección ya hecha.
    [approverId, setApproverId] = useState(requisition.approverId ?? ""),
    // Reunión 2026-08-31: la obra la asigna el revisor (filtrada por la empresa de la
    // requisición) y la forma de pago se captura aquí también.
    [workId, setWorkId] = useState(requisition.workId ?? ""),
    // Centros de costo (reunión 2026-09-12, dueño del producto): "en la requisición sale
    // PREDETERMINADO el centro asociado a la obra y se puede cambiar" — se precarga al elegir obra
    // (ver el onChange de "Obra", abajo) SOLO si el revisor aún no había elegido uno, el mismo
    // criterio de "sugerencia, no imposición" que ya usa etiqueta -> aprobador.
    [costCenterId, setCostCenterId] = useState(requisition.costCenterId ?? ""),
    // RF-009: empresa facturada = sociedad a cuyo nombre viene el soporte. Valor inicial = el que ya
    // guardó el servidor; si no lo hay (payload viejo), la misma derivación del dominio
    // (resolveBilledCompany: sociedad del centro de costo, si no la de la obra, si no la de la
    // requisición). Editable; viaja en review() como `billedCompanyId`.
    [billedCompanyId, setBilledCompanyId] = useState(() => {
      const saved = (requisition as BilledCompanyAware).billedCompanyId;
      if (saved) return saved;
      const costCenter = ((catalogs.costCenters ?? []) as CostCenterOption[]).find((option) => option.id === requisition.costCenterId);
      if (costCenter?.societyId) return costCenter.societyId;
      return catalogs.works.find((work) => work.id === requisition.workId)?.societyId ?? requisition.societyId ?? "";
    }),
    [paymentTerms, setPaymentTerms] = useState(requisition.paymentTerms ?? "ANTICIPADO"),
    // Cabecera: fecha requerida/observaciones ya NO tienen toggle "Editar cabecera" — son campos
    // inline que se autoguardan (ver `headerAutosave`, abajo). El motivo del cambio es el mismo de
    // toda esta reescritura: un botón menos que pulsar para que algo se guarde.
    [headerForm, setHeaderForm] = useState({ requiredDate: requisition.requiredDate ?? "", observations: requisition.observations ?? "" }),
    [lines, setLines] = useState<RequisitionItem[]>(requisition?.items ?? []),
    [supplierOptions, setSupplierOptions] = useState<NamedOption[]>(
      catalogs.suppliers,
    ),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    // Confirmación visible de que la acción ocurrió. Sin ella, la única señal era que el chip de
    // estado cambiara — y como `refresh()` no se esperaba, ni eso llegaba a tiempo.
    [success, setSuccess] = useState(""),
    [supplierStatus, setSupplierStatus] = useState(""),
    // Alta rápida de proveedor: el formulario vive en components/screens/supplier-quick-create.tsx
    // (compartido con la captura y el directorio); aquí solo queda A QUÉ ítem se asigna.
    [quickSupplierItemId, setQuickSupplierItemId] = useState<string | null>(
      null,
    ),
    // Cotización del comprador: adjunto propio, distinto del soporte del solicitante. Ya no hay
    // botón "Subir cotización": se sube en cuanto se elige el archivo en `AttachmentPicker`.
    [quoteFile, setQuoteFile] = useState<File | null>(null),
    [quoteBusy, setQuoteBusy] = useState(false),
    [quoteFeedback, setQuoteFeedback] = useState(""),
    // Bloqueante de atasco (reunión 2026-08-31): selección local de proveedor por ítem, para el bloque
    // "Generar órdenes" — vive aparte de `lines` (el borrador editable de la revisión) porque este
    // bloque solo existe cuando la requisición ya está `aprobada` y `lines` deja de ser relevante.
    [assignSupplierChoice, setAssignSupplierChoice] = useState<Record<string, string>>({}),
    // En `en_aprobacion`, el revisor ya no tiene el bloque de reasignación siempre visible: vive
    // detrás de «Más ⋯» → «Reasignar aprobador», en un diálogo propio con el `<select>` dentro.
    [reassignOpen, setReassignOpen] = useState(false),
    // Qué campo falta al pulsar la primaria sin completar el formulario (obra/etiqueta/aprobador/
    // valor > 0): se enfoca y se marca ESE campo en vez de solo deshabilitar el botón.
    [missingField, setMissingField] = useState<MissingField>(null);
  // Amplía a HTMLElement (no solo botón): el disparador ahora también puede ser el <select> de
  // proveedor de una fila ("+ Crear proveedor…" como última opción, ver la tabla más abajo).
  const quickSupplierTriggerRef = useRef<HTMLElement | null>(null),
    reassignTriggerRef = useRef<HTMLElement | null>(null),
    tagSelectRef = useRef<HTMLSelectElement | null>(null),
    workSelectRef = useRef<HTMLSelectElement | null>(null),
    approverSelectRef = useRef<HTMLSelectElement | null>(null),
    priceInputRefs = useRef<Record<string, HTMLInputElement | null>>({}),
    // Cuenta si el PRIMER autoguardado de una `enviada` ya mandó `start_review`: los siguientes
    // (y el propio botón "Enviar a aprobación" si el usuario lo pulsa antes de que el debounce
    // dispare) ya no deben repetirlo — repetir una transición a un estado en el que ya se está
    // es `INVALID_TRANSITION` en el servidor.
    startReviewDone = useRef(requisition.status !== "enviada");
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  // RF-308 (A9): `role` es la lente de sesión (auth-guard elige UN rol por prioridad, y al maestro
  // revisor+aprobador le toca «Revisor»), no el conjunto de roles: se leen los del visor que manda el
  // servidor. Sin ese dato no se ofrece nada que dependa de ellos.
  const viewerRoles: string[] = data.viewerRoles ?? [];
  /**
   * QA H3: el maestro con lente «Revisor» no veía «Aprobar»/«Devolver» en lo que tiene asignado. Lo que
   * decide es la misma pregunta que se hace approve(): ¿figura como aprobador de la cabecera o de algún
   * ítem? Con quién mira conocido, un aprobador NO asignado tampoco ve acciones (el servidor se las
   * rechazaría); sin él, la lente «Aprobador» se comporta como siempre.
   */
  const esAprobadorAsignado =
    Boolean(data.viewerId) &&
    (requisition.approverId === data.viewerId || (requisition.items ?? []).some((item) => item.approverId === data.viewerId));
  const isReviewer = role === "Revisor" || role === "Administrador Sixteam",
    isApprover =
      role === "Administrador Sixteam" ||
      (data.viewerId
        ? esAprobadorAsignado && (role === "Aprobador" || viewerRoles.includes("aprobador"))
        : role === "Aprobador");
  // "Aprobar yo mismo" solo para quien de verdad tiene revisor + aprobador (o es admin Sixteam): nunca
  // se ofrece una acción que el servicio va a rechazar con FORBIDDEN.
  const canSelfApprove =
    Boolean(data.viewerId) &&
    (role === "Administrador Sixteam" || (viewerRoles.includes("revisor") && viewerRoles.includes("aprobador")));
  /**
   * Las líneas que decide QUIEN ESTÁ MIRANDO. La herencia es la misma del dominio (itemApproverId):
   * sin aprobador propio, manda el de la cabecera.
   *
   * El administrador Sixteam ve y decide todas — es el mismo portillo de M-5 que ya tiene el servicio,
   * y sin él no podría desatascar nada.
   *
   * SIN `viewerId` (payload viejo servido a una página nueva, o al revés, durante un despliegue) se
   * cae al comportamiento de siempre SOLO si nadie ha repartido ítems: entonces todas las líneas son
   * del aprobador de cabecera y mandarlas todas es exactamente lo que se hacía antes. Con reparto y
   * sin saber quién mira, no se adivina: se manda lo que se pueda justificar y nada más.
   */
  const hayReparto = lines.some((line) => line.approverId);
  const misLineas =
    role === "Administrador Sixteam" || (!hayReparto && !data.viewerId)
      ? lines
      : lines.filter((line) => (line.approverId ?? requisition.approverId) === data.viewerId);
  /** Ítems de esta requisición que decide otra persona: lo que explica por qué no se ven todos. */
  const lineasDeOtros = lines.length - misLineas.length;
  // RF: cabecera editable. Solo el revisor/admin y solo mientras la requisición aún admite cambios.
  const headerEditable = isReviewer && ["enviada", "en_revision", "devuelta"].includes(requisition.status);
  // Reunión 2026-08-31: obras de la empresa de la requisición (la obra la asigna el revisor).
  const workOptions = catalogs.works.filter((work) => work.societyId === requisition.societyId);
  /**
   * Ejecuta una o VARIAS acciones EN ORDEN sobre la requisición, y no suelta el estado ocupado
   * hasta que la pantalla tiene los datos nuevos.
   *
   * Acepta una secuencia por un motivo concreto, no por generalidad: la pantalla separaba "guardar"
   * de "actuar", y actuar sin haber guardado usaba el estado VIEJO del servidor. Eso produjo dos
   * fallos que Ernesto vivió el mismo día:
   *
   *   - "Enviar a aprobación" con todo lleno en pantalla respondía REVIEW_INCOMPLETE ("valor cotizado
   *     mayor a cero"), porque el precio tecleado no se había guardado y en el servidor seguía en 0.
   *   - El aprobador declinaba un ítem, escribía el motivo, pulsaba el botón grande — y la
   *     requisición quedaba aprobada CON ese ítem vigente, porque las decisiones nunca se
   *     persistieron y `approve()` trata "pendiente" como vigente (lib/domain/rules.ts).
   *
   * El segundo es el grave: el silencio se interpretaba como aprobación. Con la secuencia, la
   * decisión que hay en pantalla se guarda ANTES de aprobar, y si ese guardado falla NO se aprueba.
   *
   * Y se espera a `refresh()`. Antes se llamaba sin `await` y `busy` se soltaba en el `finally`, así
   * que el botón se rehabilitaba con el estado anterior todavía en pantalla: "no cambia de estado ni
   * dice ok, ya aprobaste".
   *
   * `options.pendingOthersAsSuccess`: solo la primaria del aprobador la usa. `approve()` responde
   * `APPROVAL_PENDING_OTHERS` cuando `decide_items` (la primera llamada de la secuencia) SÍ se
   * guardó y lo único que falta son los ítems de otro aprobador — eso no es un fallo del usuario que
   * acaba de decidir los suyos, es el flujo normal de un reparto por ítem. Antes eso salía como un
   * error rojo aunque las decisiones ya estuvieran guardadas.
   */
  const run = async (
    bodies: Record<string, unknown> | Array<Record<string, unknown>>,
    successMessage?: string,
    options?: { pendingOthersAsSuccess?: boolean },
  ) => {
    const secuencia = Array.isArray(bodies) ? bodies : [bodies];
    setBusy(true);
    setFeedback("");
    setSuccess("");
    try {
      // En serie y cortando al primer fallo: si `decide_items` rechaza un declinado sin motivo, no
      // puede aprobarse la requisición a continuación.
      for (const body of secuencia) {
        await mutate(`/api/requisitions/${requisition.id}/actions`, "POST", body);
      }
      // RF-1105: sin esto, tras aprobar/declinar/devolver esta misma pantalla seguía
      // mostrando el estado anterior de la requisición hasta que el usuario navegara
      // fuera y volviera. `refresh` ya no vacía la vista (stale-while-revalidate): sigue
      // mostrando lo que había mientras trae el estado real.
      await refresh();
      if (successMessage) setSuccess(successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Acción no completada.";
      const pendientes = options?.pendingOthersAsSuccess ? /Faltan (\d+) aprobador/.exec(message) : null;
      if (pendientes) {
        await refresh();
        const n = pendientes[1];
        setSuccess(
          `Tus ${misLineas.length} ítem${misLineas.length === 1 ? "" : "s"} quedaron decididos; falta${n === "1" ? "" : "n"} ${n} aprobador${n === "1" ? "" : "es"}.`,
        );
      } else {
        setFeedback(message);
      }
    } finally {
      setBusy(false);
    }
  };
  /**
   * La revisión TAL COMO ESTÁ EN PANTALLA. Extraído para que la primaria "Enviar a aprobación" y el
   * autoguardado manden exactamente lo mismo: si se construyera dos veces, volverían a poder
   * divergir, que es de donde venía el REVIEW_INCOMPLETE con el formulario lleno.
   */
  const reviewBody = (overrides: { approverId?: string } = {}) => ({
    action: "review",
    tagId,
    ...((overrides.approverId ?? approverId) ? { approverId: overrides.approverId ?? approverId } : {}),
    ...(workId ? { workId } : {}),
    // Centros de costo: igual que workId/approverId arriba, "" omite la clave (el servidor hereda el
    // de la obra vía resolveCostCenter, lib/domain/rules.ts) en vez de mandar un vacío explícito.
    ...(costCenterId ? { costCenterId } : {}),
    ...(billedCompanyId ? { billedCompanyId } : {}),
    ...(paymentTerms.trim() ? { paymentTerms: paymentTerms.trim() } : {}),
    items: lines.map(({ id, itemId, description, quantity, unit, possibleSupplier, productLink, finalSupplierId, unitBase, status, declineReason, ivaRate, discountRate, approverId }) => ({
      id,
      ...(itemId ? { itemId } : {}),
      ...(description ? { description } : {}),
      quantity,
      unit,
      ...(possibleSupplier ? { possibleSupplier } : {}),
      ...(productLink ? { productLink } : {}),
      ...(finalSupplierId ? { finalSupplierId } : {}),
      // Aprobador por ítem: solo viaja cuando lo hay. Ausente = hereda el de la cabecera, que es la
      // misma regla del dominio (itemApproverId) — mandar "" lo rechazaría el servicio por no elegible.
      ...(approverId ? { approverId } : {}),
      unitBase: Math.round(unitBase ?? 0),
      ...(status ? { status } : {}),
      ...(status === "declinado" && declineReason ? { declineReason } : {}),
      ...(ivaRate !== undefined ? { ivaRate } : {}),
      ...(discountRate !== undefined ? { discountRate } : {}),
    })),
  });

  /**
   * Las decisiones del aprobador TAL COMO ESTÁN EN PANTALLA, pero SOLO LAS SUYAS.
   *
   * Antes mandaba todas las líneas, porque una requisición tenía un solo aprobador. Con aprobadores
   * por ítem el servicio rechaza decidir lo ajeno (NOT_ASSIGNED_APPROVER) y mandar el lote entero
   * habría roto "Completar aprobación" en cuanto alguien repartiera ítems — sin tocar esta pantalla.
   *
   * `misLineas` resuelve la herencia igual que el dominio: sin aprobador propio, decide el de
   * cabecera. El administrador Sixteam puede con todo (M-5), como en el servicio.
   */
  const decisionsBody = () => ({
    action: "decide_items",
    decisions: misLineas.map((line) => {
      const status = line.status === "declinado" ? "declinado" : "aprobado";
      return {
        itemId: line.id,
        status,
        ...(status === "declinado" ? { declineReason: (line.declineReason ?? "").trim() } : {}),
        quantity: Number(line.quantity),
      };
    }),
  });

  const updateLine = (id: string, patch: Partial<RequisitionItem>) =>
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  // Reunión 2026-09: el IVA del 19 % se repetía a mano en cada ítem, y ese tecleo repetido
  // era la mayor parte del coste de revisar. Las acciones masivas solo tocan las líneas
  // vigentes: aplicar un proveedor o una tasa a una línea ya declinada no significa nada.
  // Reunión 2026-09 (rediseño de acciones): antes vivían en una barra fija ("Aplicar a todos")
  // encima de la tabla; ahora cuelgan de un botón "⋯ a todos" en la cabecera de su propia columna
  // (mapeo/proximidad: el control vive junto a lo que afecta).
  const applyToAllLines = (patch: Partial<RequisitionItem>) =>
    setLines((current) =>
      current.map((line) => (line.status === "declinado" ? line : { ...line, ...patch })),
    );
  /**
   * "Aprobador para todos": rellena los ítems SIN aprobador propio y NO pisa los que ya tienen uno.
   *
   * Es lo contrario de las otras acciones masivas, y a propósito. Aplicar un IVA de más a una línea se
   * ve en el total y se corrige; pisar un aprobador que alguien eligió a conciencia manda el ítem a
   * decidir a otra persona, y eso no se nota hasta que llega el WhatsApp equivocado. Cuando hay algo
   * que pisar se pregunta, diciendo cuántos son.
   */
  const aplicarAprobadorATodos = (nuevo: string) => {
    const yaAsignados = lines.filter((line) => line.status !== "declinado" && line.approverId && line.approverId !== nuevo);
    const pisar =
      yaAsignados.length === 0 ||
      window.confirm(
        `${yaAsignados.length} ítem(s) ya tienen un aprobador distinto. ¿Reemplazarlo también en esos? Aceptar los cambia todos; cancelar deja solo los que estaban sin asignar.`,
      );
    setLines((current) =>
      current.map((line) =>
        line.status === "declinado" || (!pisar && line.approverId) ? line : { ...line, approverId: nuevo },
      ),
    );
  };
  // Cotización del comprador: sube directo (la requisición ya existe) y refresca para que
  // aparezca en "Cotizaciones del comprador", separada de los adjuntos del solicitante. Ya no
  // hay botón "Subir cotización": se dispara en cuanto `AttachmentPicker` entrega el archivo.
  const uploadQuote = async (file: File) => {
    setQuoteBusy(true);
    setQuoteFeedback("");
    try {
      await uploadOperationalAttachment({
        entity: "requisicion",
        entityId: requisition.id,
        type: "cotizacion",
        file,
      });
      setQuoteFile(null);
      refresh();
    } catch (error) {
      setQuoteFeedback(error instanceof Error ? error.message : "No fue posible cargar la cotización.");
    } finally {
      setQuoteBusy(false);
    }
  };
  const closeQuickSupplier = () => {
    const trigger = quickSupplierTriggerRef.current;
    setQuickSupplierItemId(null);
    queueMicrotask(() => trigger?.focus());
  };
  // Guardas del autoguardado (cliente, nunca un toast rojo por estar tecleando): sin etiqueta no
  // hay nada que guardar todavía (review() la exige); una línea vigente con cantidad ≤ 0, precio
  // < 0 o descuento > 1 (100 %) es un valor a medio teclear, no uno a persistir. Una línea
  // declinada sin motivo NO bloquea (review() no lo exige; solo lo exige `decide_items`, más abajo).
  const reviewGuardMessage = (): string | null => {
    if (!tagId) return "Elige la etiqueta para empezar a guardar.";
    const invalida = lines.some(
      (line) =>
        line.status !== "declinado" &&
        (Number(line.quantity) <= 0 || Number(line.unitBase ?? 0) < 0 || (line.discountRate ?? 0) > 1),
    );
    if (invalida) return "Corrige la cantidad, el precio o el descuento antes de guardar.";
    return null;
  };
  // Para el aprobador: `decide_items` SÍ exige motivo en cada declinado (COMMENT_REQUIRED) y una
  // cantidad > 0; mientras falte, no se autoguarda (ni ese ítem ni los demás: `decisionsBody()` es
  // una sola llamada atómica en el servidor, así que no hay forma de "guardar las demás" sin
  // reconstruir el body a mano — se prefiere no mandar nada antes que mandar una decisión a medias).
  const decisionsGuardMessage = (): string | null => {
    const invalida = misLineas.some((line) =>
      line.status === "declinado" ? !(line.declineReason ?? "").trim() : Number(line.quantity) <= 0,
    );
    if (invalida) return "Corrige la cantidad o el motivo de declinación antes de guardar.";
    return null;
  };
  const actionsUrl = `/api/requisitions/${requisition.id}/actions`;
  const reviewGuard = reviewGuardMessage();
  const reviewAutosave = useAutosave({
    enabled: isReviewer && ["enviada", "en_revision", "devuelta"].includes(requisition.status),
    blockedReason: reviewGuard,
    buildBody: () => reviewBody(),
    // Estado `enviada`: el PRIMER autoguardado manda `[start_review, review]` — review() exige
    // `en_revision`, y por eso hace falta la transición antes. Los siguientes (y cualquier
    // guardado tras esta misma sesión) ya solo mandan `review`.
    send: async (body) => {
      if (requisition.status === "enviada" && !startReviewDone.current) {
        await mutate(actionsUrl, "POST", { action: "start_review" });
        startReviewDone.current = true;
      }
      return mutate(actionsUrl, "POST", body);
    },
  });
  const reviewAutosaveMounted = useRef(false);
  useEffect(() => {
    if (!reviewAutosaveMounted.current) {
      reviewAutosaveMounted.current = true;
      return;
    }
    reviewAutosave.scheduleDebounced();
    // Deliberado: NO se listan `reviewAutosave`/`reviewBody` (objetos/funciones nuevas cada
    // render) — solo los valores de formulario cuyo cambio debe programar un guardado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId, approverId, workId, costCenterId, billedCompanyId, paymentTerms, JSON.stringify(lines)]);

  const decisionsGuard = decisionsGuardMessage();
  const decisionsAutosave = useAutosave({
    enabled: isApprover && requisition.status === "en_aprobacion",
    blockedReason: decisionsGuard,
    buildBody: () => decisionsBody(),
    send: (body) => mutate(actionsUrl, "POST", body),
  });
  const decisionsAutosaveMounted = useRef(false);
  useEffect(() => {
    if (!decisionsAutosaveMounted.current) {
      decisionsAutosaveMounted.current = true;
      return;
    }
    decisionsAutosave.scheduleDebounced();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(lines)]);

  // Cabecera: fecha requerida/observaciones, autoguardadas vía PATCH /api/requisitions/:id — sin
  // guarda propia (a diferencia de la revisión, un PATCH de cabecera nunca deja datos a medias).
  const headerAutosave = useAutosave({
    enabled: headerEditable,
    blockedReason: null,
    buildBody: () => ({
      requiredDate: headerForm.requiredDate || undefined,
      observations: headerForm.observations.trim() || null,
    }),
    send: (body) => mutate(`/api/requisitions/${requisition.id}`, "PATCH", body),
  });
  const headerAutosaveMounted = useRef(false);
  useEffect(() => {
    if (!headerAutosaveMounted.current) {
      headerAutosaveMounted.current = true;
      return;
    }
    headerAutosave.scheduleDebounced();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerForm.requiredDate, headerForm.observations]);

  if (!requisition?.id)
    return (
      <div className="panel state-panel" role="alert">
        Requisición no disponible.
      </div>
    );
  const openQuickSupplier = (
    itemId: string,
    trigger: HTMLElement,
  ) => {
    quickSupplierTriggerRef.current = trigger;
    setSupplierStatus("");
    setQuickSupplierItemId(itemId);
  };
  const assignQuickSupplier = (created: QuickSupplier) => {
    setSupplierOptions((current) =>
      current.some((supplier) => supplier.id === created.id)
        ? current
        : [...current, { id: created.id, name: created.name }],
    );
    if (quickSupplierItemId) {
      updateLine(quickSupplierItemId, { finalSupplierId: created.id });
    }
    setSupplierStatus(`${created.name} quedó asignado al ítem.`);
    closeQuickSupplier();
  };
  const supplierGroups = [
    ...new Set(
      lines
        .map((item) => item.finalSupplierId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  // Insumos del bloque "Generar órdenes": ítems aprobados (todo lo que no esté declinado) de la
  // requisición ya guardada en el servidor (no de `lines`, que es el borrador editable local),
  // agrupados por proveedor final; los que faltan quedan aparte para anticipar SUPPLIER_REQUIRED.
  const approvedForOrders = requisition.items.filter((item) => item.status !== "declinado");
  const missingSupplierItems = approvedForOrders.filter((item) => !item.finalSupplierId);
  const orderSupplierGroupsMap = new Map<string, RequisitionItem[]>();
  for (const item of approvedForOrders) {
    if (!item.finalSupplierId) continue;
    orderSupplierGroupsMap.set(item.finalSupplierId, [...(orderSupplierGroupsMap.get(item.finalSupplierId) ?? []), item]);
  }
  const orderSupplierGroups = [...orderSupplierGroupsMap.entries()];
  // GRAVE 4: "—" en vez del UUID crudo cuando el proveedor no aparece en ninguna de las dos fuentes.
  const supplierName = (id: string) => supplierOptions.find((s) => s.id === id)?.name ?? catalogs.suppliers.find((s) => s.id === id)?.name ?? "—";
  // Adjuntos del solicitante (soportes/fotos) vs. cotizaciones del comprador: dos cosas
  // distintas para quien aprueba, antes mezcladas en una sola lista.
  const requesterAttachments = attachments.filter((attachment) => attachment.type !== "cotizacion");
  const quoteAttachments = attachments.filter((attachment) => attachment.type === "cotizacion");
  const quickSupplierItem = quickSupplierItemId
    ? lines.find((line) => line.id === quickSupplierItemId)
    : undefined;

  const MISSING_FIELD_MESSAGES: Record<Exclude<MissingField, null>, string> = {
    tag: "Falta elegir la etiqueta.",
    work:
      workOptions.length === 0
        ? "Falta asignar la obra. Esta empresa no tiene obras registradas: pídele a un administrador que la cree."
        : "Falta asignar la obra.",
    approver: "Falta elegir el aprobador.",
    price: "Cada ítem vigente necesita un valor cotizado mayor a cero.",
  };
  /** Al pulsar la primaria con algo faltante, se enfoca y marca el primer campo faltante en vez de
   *  solo deshabilitar el botón — el mensaje de al lado ya explicaba QUÉ faltaba; esto además lleva
   *  el foco A donde falta. */
  const validateReviewComplete = (effectiveApproverId = approverId): MissingField => {
    if (!tagId) return "tag";
    if (!workId) return "work";
    if (!effectiveApproverId) return "approver";
    if (lines.some((line) => line.status !== "declinado" && estimateLineTotal(line) <= 0)) return "price";
    return null;
  };
  /** Marca y enfoca lo que falta; devuelve true si había algo que enfocar (y no se debe continuar). */
  const focusMissingField = (missing: MissingField): boolean => {
    setMissingField(missing);
    if (missing === "tag") { tagSelectRef.current?.focus(); return true; }
    if (missing === "work") { workSelectRef.current?.focus(); return true; }
    if (missing === "approver") { approverSelectRef.current?.focus(); return true; }
    if (missing === "price") {
      const invalidLine = lines.find((line) => line.status !== "declinado" && estimateLineTotal(line) <= 0);
      if (invalidLine) priceInputRefs.current[invalidLine.id]?.focus();
      return true;
    }
    return false;
  };
  // Estado `enviada`: si el usuario pulsa la primaria ANTES de que el debounce del autoguardado
  // dispare, la secuencia completa (`start_review` + `review` + acción) va en un solo `run()` — ver
  // el comentario de `run`, arriba, sobre por qué no puede saltarse el orden.
  const reviewThen = (body: Record<string, unknown>, action: string) => {
    const actions =
      requisition.status === "enviada" && !startReviewDone.current
        ? [{ action: "start_review" }, body, { action }]
        : [body, { action }];
    startReviewDone.current = true;
    return actions;
  };
  const handleSendForApproval = () => {
    if (busy) return;
    if (focusMissingField(validateReviewComplete())) return;
    void run(reviewThen(reviewBody(), "send_for_approval"), "Requisición enviada a aprobación.");
  };
  /**
   * RF-308 (A9): enviar a aprobación Y aprobar en un solo paso. `sendAndApproveAsMaster` exige que el
   * actor figure como aprobador asignado, así que la revisión se guarda PRIMERO con `approverId` =
   * quien está mirando (sin tocar el <select>: si la secuencia falla, la pantalla queda como estaba)
   * y solo después se llama `send_and_approve`. Quedan dos eventos en la trazabilidad.
   */
  const handleSelfApprove = async () => {
    if (busy || !data.viewerId) return;
    if (focusMissingField(validateReviewComplete(data.viewerId))) return;
    const result = await confirm({
      title: "Aprobar yo mismo",
      description: `La requisición ${requisition.consecutive} se enviará a aprobación y quedará aprobada en un solo paso, contigo como aprobador. Quedarán dos eventos en la trazabilidad y no se podrá regresar a revisión.`,
      confirmLabel: "Aprobar yo mismo",
    });
    if (!result.ok) return;
    void run(reviewThen(reviewBody({ approverId: data.viewerId }), "send_and_approve"), "Requisición aprobada en un solo paso.");
  };
  const handleDeclineWhole = async () => {
    const result = await confirm({
      title: "Declinar toda la requisición",
      description: `La requisición ${requisition.consecutive} quedará declinada de forma definitiva y no se podrá reactivar.`,
      confirmLabel: "Declinar toda la requisición",
      danger: true,
      reason: { label: "Motivo para declinar", required: true, rows: 3 },
    });
    if (!result.ok) return;
    void run({ action: "decline", reason: result.reason ?? "" }, "Requisición declinada.");
  };
  const otherPending = lineasDeOtros > 0;
  const handleApprovePrimary = async () => {
    const declinados = misLineas.filter((line) => line.status === "declinado").length;
    const aprobados = misLineas.length - declinados;
    const result = await confirm({
      title: otherPending ? "Aprobar tus ítems" : "Aprobar requisición",
      description: `Se guardarán las decisiones de esta pantalla (${aprobados} ${aprobados === 1 ? "ítem aprobado" : "ítems aprobados"}, ${declinados} ${declinados === 1 ? "declinado" : "declinados"})${
        otherPending
          ? ". Faltan ítems que decide otro aprobador: la requisición sigue en aprobación hasta que todos terminen."
          : ` y la requisición ${requisition.consecutive} quedará aprobada de forma definitiva, sin poder regresar a revisión. Genera las órdenes después, desde el bloque "Generar órdenes".`
      }`,
      confirmLabel: otherPending ? "Aprobar mis ítems" : "Aprobar requisición",
    });
    if (!result.ok) return;
    void run(
      [decisionsBody(), { action: "approve" }],
      otherPending ? undefined : "Requisición aprobada.",
      { pendingOthersAsSuccess: true },
    );
  };
  const handleReturn = async () => {
    const result = await confirm({
      title: "Devolver a revisión",
      description: `La requisición ${requisition.consecutive} volverá a revisión para que el revisor la corrija.`,
      confirmLabel: "Devolver a revisión",
      reason: { label: "Comentario de devolución", required: true, rows: 3 },
    });
    if (!result.ok) return;
    void run({ action: "return", comment: result.reason ?? "" }, "Requisición devuelta a revisión.");
  };
  const closeReassign = () => {
    setReassignOpen(false);
    queueMicrotask(() => reassignTriggerRef.current?.focus());
  };
  const reassignMenuItem = {
    label: "Reasignar aprobador",
    onSelect: () => {
      reassignTriggerRef.current = document.activeElement as HTMLElement | null;
      setReassignOpen(true);
    },
  };
  const handleGenerateOrders = async () => {
    if (busy) return;
    const stillMissing = missingSupplierItems.filter((item) => !assignSupplierChoice[item.id]);
    if (stillMissing.length > 0) {
      document.getElementById(`assign-supplier-${stillMissing[0].id}`)?.focus();
      return;
    }
    if (orderSupplierGroups.length === 0) return;
    const result = await confirm({
      title: "Generar órdenes",
      description: `Se generará${orderSupplierGroups.length === 1 ? "" : "n"} ${orderSupplierGroups.length} orden(es), una por proveedor. Esta acción no se puede deshacer.`,
      confirmLabel: "Generar órdenes",
    });
    if (!result.ok) return;
    const assignments = missingSupplierItems
      .filter((item) => assignSupplierChoice[item.id])
      .map((item) => ({ itemId: item.id, supplierId: assignSupplierChoice[item.id] }));
    const actions = assignments.length
      ? [{ action: "assign_suppliers", assignments }, { action: "generate_orders" }]
      : [{ action: "generate_orders" }];
    void run(actions, "Órdenes generadas.");
  };
  const reviewLineTotals = summarizeLines(lines);
  // RF-307/D5 ("el maestro puso 100 millones"): en un pago el valor original es el que pidió el
  // solicitante — el `montoAntes` de la PRIMERA `revisada` que cambió el valor (sobrevive a recargas)
  // o, si nadie lo ha tocado aún, el total tal como llegó del servidor.
  const originalPaymentTotal = (() => {
    if (requisition.type !== "pago") return null;
    const firstChange = history
      .filter((entry) => entry.event === "revisada" && typeof entry.data?.montoAntes === "number")
      .sort((a, b) => a.at.localeCompare(b.at))[0];
    return typeof firstChange?.data?.montoAntes === "number" ? firstChange.data.montoAntes : summarizeLines(requisition.items).total;
  })();
  const billedCompanyName = (id: string | undefined) =>
    id ? ((catalogs.societies ?? []).find((society) => society.id === id)?.name ?? "—") : "Sin empresa facturada";
  const beneficiaryId = pendingBeneficiaryId(requisition);
  return (
    <>
      <SectionTitle
        eyebrow="Detalle conectado"
        title={requisition.consecutive}
        description={`${requisition.type} · ${requisition.channel} · ${requisition.requiredDate || "sin fecha"}`}
        action={
          <div className="title-actions">
            {/* Cabecera de pantalla: "Actualizar" ya no es un botón de texto (competía con la
                primaria por atención) — queda un icono ⟳ pequeño, mismo nombre accesible. */}
            <button className="icon-button" type="button" aria-label="Actualizar" onClick={refresh}>
              <RotateCw aria-hidden="true" size={16} />
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() =>
                go(role === "Aprobador" ? "/aprobaciones" : "/revision")
              }
            >
              Volver
            </button>
          </div>
        }
      />
      <div className="connected-detail-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              {/* Pendiente que dejó otro agente: en una requisición tipo "pago" no hay ítems de
                  catálogo, hay UN concepto de pago — "Ítems" ahí confundía al revisor. */}
              <h2>{requisition.type === "pago" ? "Concepto" : "Ítems"} y cotización</h2>
              <p className="panel-sub">
                Obra{" "}
                {requisition.workId
                  ? (catalogs.works.find((work) => work.id === requisition.workId)?.name ?? requisition.workId)
                  : "por asignar en la revisión"}
              </p>
            </div>
            <Tone tone="muted">
              <span data-testid="requisition-status">
                {estadoLabel(requisition.status)}
              </span>
            </Tone>
          </div>
          {isReviewer &&
          ["enviada", "en_revision", "devuelta"].includes(requisition.status) ? (
            <div className="connected-review" onBlur={reviewAutosave.onBlurCapture}>
              {requisition.status === "enviada" && (
                <p className="muted-copy" role="status">
                  Al editar, la requisición pasa a revisión.
                </p>
              )}
              <label className="field">
                {/* Reunión 2026-09: la etiqueta ya solo clasifica el gasto (alimenta el reporte por
                    etiqueta) — quién aprueba se elige aparte, abajo. */}
                <span>Etiqueta</span>
                <select
                  ref={tagSelectRef}
                  required
                  aria-invalid={missingField === "tag"}
                  value={tagId}
                  onChange={(event) => {
                    const nextTagId = event.target.value;
                    setTagId(nextTagId);
                    if (missingField === "tag") setMissingField(null);
                    // Sugerencia por defecto: solo prerellena si el revisor aún no eligió aprobador —
                    // nunca pisa una elección ya hecha, y el select de abajo sigue siendo editable.
                    if (!approverId) {
                      const suggested = catalogs.tags.find((tag) => tag.id === nextTagId)?.approverId;
                      if (suggested) setApproverId(suggested);
                    }
                  }}
                >
                  <option value="">Selecciona una etiqueta</option>
                  {catalogs.tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Aprobador</span>
                <select
                  ref={approverSelectRef}
                  required
                  value={approverId}
                  aria-invalid={missingField === "approver"}
                  onChange={(event) => {
                    setApproverId(event.target.value);
                    if (missingField === "approver") setMissingField(null);
                  }}
                >
                  <option value="">Selecciona un aprobador</option>
                  {(catalogs.approvers ?? []).map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {/* Reunión 2026-08-31: la obra la asigna el revisor, filtrada por la empresa de la
                    requisición; obligatoria para enviar a aprobación.
                    GRAVE 3: si la empresa no tiene obras, `workOptions` queda vacío y antes el
                    <select> se veía con una sola opción fantasma ("Selecciona una obra") sin
                    explicar por qué el flujo estaba atascado — un callejón sin salida absoluto. */}
                <span>Obra</span>
                <select
                  ref={workSelectRef}
                  required
                  value={workId}
                  disabled={workOptions.length === 0}
                  aria-invalid={missingField === "work"}
                  aria-describedby={workOptions.length === 0 ? "work-empty-reason" : undefined}
                  onChange={(event) => {
                    const nextWorkId = event.target.value;
                    setWorkId(nextWorkId);
                    if (missingField === "work") setMissingField(null);
                    // Reunión 2026-09-12 (dueño del producto): "sale PREDETERMINADO el centro
                    // asociado a la obra" — precarga SOLO si el revisor aún no había elegido uno
                    // (mismo criterio que etiqueta -> aprobador, arriba: nunca pisa una elección
                    // ya hecha), y solo cuando la obra elegida sí tiene un centro por defecto.
                    if (!costCenterId) {
                      const suggested = catalogs.works.find((work) => work.id === nextWorkId)?.costCenterId;
                      if (suggested) setCostCenterId(suggested);
                    }
                  }}
                >
                  <option value="">
                    {workOptions.length === 0 ? "Sin obras registradas" : "Selecciona una obra"}
                  </option>
                  {workOptions.map((work) => (
                    <option key={work.id} value={work.id}>
                      {work.name}
                    </option>
                  ))}
                </select>
                {workOptions.length === 0 && (
                  <small className="field-error" role="alert" id="work-empty-reason">
                    Esta empresa no tiene obras registradas: pídele a un administrador que cree
                    al menos una antes de poder enviar la requisición a aprobación.
                  </small>
                )}
              </label>
              <label className="field">
                {/* Reunión 2026-09-12: centro de costo EDITABLE — la precarga de arriba (al elegir
                    obra) es solo una sugerencia por defecto, nunca una imposición. */}
                <span>Centro de costo</span>
                <select
                  value={costCenterId}
                  onChange={(event) => setCostCenterId(event.target.value)}
                >
                  <option value="">
                    {(catalogs.costCenters ?? []).length === 0 ? "Sin centros de costo registrados" : "Selecciona un centro de costo"}
                  </option>
                  {(catalogs.costCenters ?? []).map((costCenter) => (
                    <option key={costCenter.id} value={costCenter.id}>
                      {costCenter.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {/* RF-009: la sociedad a cuyo nombre viene el soporte (lo que contabiliza el contador),
                    independiente del centro de costo. Solo sociedades activas (GET /api/catalogs). */}
                <span>Empresa facturada</span>
                <select
                  value={billedCompanyId}
                  disabled={(catalogs.societies ?? []).length === 0}
                  onChange={(event) => setBilledCompanyId(event.target.value)}
                >
                  <option value="">
                    {(catalogs.societies ?? []).length === 0 ? "Sin empresas registradas" : "Selecciona la empresa facturada"}
                  </option>
                  {(catalogs.societies ?? []).map((society) => (
                    <option key={society.id} value={society.id}>
                      {society.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Forma de pago</span>
                <input
                  maxLength={240}
                  value={paymentTerms}
                  onChange={(event) => setPaymentTerms(event.target.value)}
                />
              </label>
              {/* Reunión 2026-09 (QA UX): la revisión era un <fieldset> por ítem en rejilla de
                  5 columnas — 7 controles + 1 botón cada uno, que envolvían a dos filas y
                  dejaban celdas huecas. Con 5 ítems eran 43 elementos y ~1.750px de scroll, y
                  el tabulado pasaba por un botón entre el precio de un ítem y el del siguiente.
                  Daniel comparaba eso contra escribir un WhatsApp, así que la densidad no era
                  cosmética: decidía la adopción. Ahora es una fila por ítem; las acciones masivas
                  (el 19 % se teclaba cinco veces) cuelgan de un «⋯ a todos» en la cabecera de su
                  propia columna en vez de una barra fija aparte. */}
              <div className="review-table-scroll">
                <table className="review-table">
                  <thead>
                    <tr>
                      <th scope="col">Ítem</th>
                      <th scope="col" className="align-right">Cant.</th>
                      <th scope="col">Und.</th>
                      <th scope="col" className="align-right">{requisition.type === "pago" ? "Valor" : "Precio unit."}</th>
                      <th scope="col">
                        <span className="th-with-menu">
                          <span>IVA %</span>
                          <ActionMenu
                            label="⋯ a todos"
                            ariaLabel="Aplicar un IVA a todos los ítems vigentes"
                            items={[0, 0.05, 0.19].map((rate) => ({
                              label: `${Math.round(rate * 100)} % a todos`,
                              onSelect: () => applyToAllLines({ ivaRate: rate }),
                            }))}
                          />
                        </span>
                      </th>
                      <th scope="col" className="align-right">Desc %</th>
                      <th scope="col">
                        <span className="th-with-menu">
                          <span>Proveedor</span>
                          <ActionMenu
                            label="⋯ a todos"
                            ariaLabel="Aplicar un proveedor a todos los ítems vigentes"
                            items={supplierOptions.map((supplier) => ({
                              label: `${supplier.name} a todos`,
                              onSelect: () => applyToAllLines({ finalSupplierId: supplier.id }),
                            }))}
                          />
                        </span>
                      </th>
                      <th scope="col">
                        <span className="th-with-menu">
                          <span>Aprobador</span>
                          <ActionMenu
                            label="⋯ a todos"
                            ariaLabel="Aplicar un aprobador a todos los ítems vigentes"
                            items={(catalogs.approvers ?? []).map((user) => ({
                              label: `${user.name} a todos`,
                              onSelect: () => aplicarAprobadorATodos(user.id),
                            }))}
                          />
                        </span>
                      </th>
                      <th scope="col" className="align-right">Total</th>
                      <th scope="col"><span className="sr-only">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const nombre =
                        line.description ||
                        catalogs.items.find((item) => item.id === line.itemId)?.name ||
                        "Ítem";
                      const declinado = line.status === "declinado";
                      const priceMissing = missingField === "price" && !declinado && estimateLineTotal(line) <= 0;
                      return (
                        <Fragment key={line.id}>
                          <tr className={declinado ? "review-row-declined" : undefined}>
                            <th scope="row" className="review-row-name">
                              {nombre}
                              {declinado && <Tone tone="danger" dot>Declinado</Tone>}
                            </th>
                            <td>
                              <input
                                className="cell-input align-right"
                                type="number"
                                step="0.001"
                                min="0.001"
                                disabled={declinado}
                                aria-label={`Cantidad de ${nombre}`}
                                value={line.quantity}
                                onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) })}
                              />
                            </td>
                            <td>
                              <input
                                className="cell-input cell-narrow"
                                disabled={declinado}
                                aria-label={`Unidad de ${nombre}`}
                                value={line.unit}
                                onChange={(event) => updateLine(line.id, { unit: event.target.value })}
                              />
                            </td>
                            <td>
                              <input
                                ref={(el) => { priceInputRefs.current[line.id] = el; }}
                                className="cell-input align-right"
                                type="number"
                                min="0"
                                step="1"
                                disabled={declinado}
                                aria-label={`Precio unitario de ${nombre}`}
                                aria-invalid={priceMissing}
                                value={line.unitBase ?? 0}
                                onChange={(event) => {
                                  updateLine(line.id, { unitBase: Number(event.target.value) });
                                  if (missingField === "price") setMissingField(null);
                                }}
                              />
                            </td>
                            <td>
                              <select
                                className="cell-input cell-narrow"
                                disabled={declinado}
                                aria-label={`IVA de ${nombre}`}
                                value={String(line.ivaRate ?? 0)}
                                onChange={(event) => updateLine(line.id, { ivaRate: Number(event.target.value) })}
                              >
                                <option value="0">0</option>
                                <option value="0.05">5</option>
                                <option value="0.19">19</option>
                              </select>
                            </td>
                            <td>
                              <input
                                className="cell-input cell-narrow align-right"
                                type="number"
                                min="0"
                                max="100"
                                step="1"
                                disabled={declinado}
                                aria-label={`Descuento de ${nombre}`}
                                value={line.discountRate !== undefined ? Math.round(line.discountRate * 100) : 0}
                                onChange={(event) => updateLine(line.id, { discountRate: Number(event.target.value) / 100 })}
                              />
                            </td>
                            <td>
                              <select
                                className="cell-input"
                                id={`supplier-${line.id}`}
                                disabled={declinado}
                                aria-label={`Proveedor de ${nombre}`}
                                value={line.finalSupplierId ?? ""}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  // "+ Crear proveedor…" es la última opción de ESTA fila (antes era
                                  // un botón único en la barra masiva que siempre usaba `lines[0].id`
                                  // — el proveedor nuevo terminaba asignado al primer ítem sin
                                  // importar en cuál fila se hubiera pulsado. Ahora vive en el select
                                  // de cada fila y abre el modal con el `line.id` de ESA fila.
                                  if (value === "__nuevo__") {
                                    openQuickSupplier(line.id, event.currentTarget);
                                    return;
                                  }
                                  updateLine(line.id, { finalSupplierId: value || undefined });
                                }}
                              >
                                <option value="">Por definir</option>
                                {supplierOptions.map((supplier) => (
                                  <option key={supplier.id} value={supplier.id}>
                                    {supplier.name}
                                  </option>
                                ))}
                                <option value="__nuevo__">+ Crear proveedor…</option>
                              </select>
                            </td>
                            {/* Ernesto, 11-sep-2026: «se puede designar un aprobador para todo o
                                aprobadores por ítems». Vacío = lo decide el de la cabecera, y eso se
                                dice con todas las letras en la opción por defecto: un "—" dejaría
                                pensando que ese ítem no tiene quien lo apruebe. */}
                            <td>
                              <select
                                className="cell-input"
                                id={`approver-${line.id}`}
                                disabled={declinado}
                                aria-label={`Aprobador de ${nombre}`}
                                value={line.approverId ?? ""}
                                onChange={(event) => updateLine(line.id, { approverId: event.target.value || undefined })}
                              >
                                <option value="">El de la requisición</option>
                                {(catalogs.approvers ?? []).map((user) => (
                                  <option key={user.id} value={user.id}>
                                    {user.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="align-right money">
                              {declinado ? "—" : money.format(estimateLineTotal(line))}
                            </td>
                            <td>
                              <button
                                className={`button button-secondary cell-action ${declinado ? "decision-approve" : "decision-decline"}`}
                                type="button"
                                onClick={() =>
                                  updateLine(line.id, {
                                    status: declinado ? undefined : "declinado",
                                    declineReason: declinado ? undefined : line.declineReason,
                                  })
                                }
                              >
                                {declinado
                                  ? <><Check aria-hidden="true" size={15} /> Reactivar</>
                                  : <><X aria-hidden="true" size={15} /> Declinar</>}
                              </button>
                            </td>
                          </tr>
                          {declinado && (
                            <tr className="review-row-declined">
                              <td colSpan={10}>
                                <label className="field field-wide">
                                  <span>Motivo por el que se declina {nombre}</span>
                                  <textarea
                                    required
                                    rows={2}
                                    value={line.declineReason ?? ""}
                                    onChange={(event) => updateLine(line.id, { declineReason: event.target.value })}
                                  />
                                </label>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {supplierStatus && (
                <p className="field-success" role="status">
                  {supplierStatus}
                </p>
              )}
              {missingField && (
                <p className="field-error" role="alert">
                  {MISSING_FIELD_MESSAGES[missingField]}
                </p>
              )}
              {/* Barra pegajosa al pie del panel de ítems: totales, indicador de autoguardado,
                  «Más ⋯» (Declinar toda la requisición) y la primaria "Enviar a aprobación". Ya
                  no hay "Guardar revisión" — el autoguardado hace ese trabajo. */}
              <div className="connected-actions">
                <div className="connected-actions-totals" data-testid="line-summary">
                  <span>Subtotal <b className="money">{money.format(reviewLineTotals.base)}</b></span>
                  <span>IVA <b className="money">{money.format(reviewLineTotals.iva)}</b></span>
                  <span className="connected-line-summary-total">Total <b className="money">{money.format(reviewLineTotals.total)}</b></span>
                  {originalPaymentTotal !== null && originalPaymentTotal !== reviewLineTotals.total && (
                    <span data-testid="original-amount">Valor original <b className="money">{money.format(originalPaymentTotal)}</b></span>
                  )}
                </div>
                <AutosaveIndicator autosave={reviewAutosave} blockedReason={reviewGuard} />
                <ActionMenu
                  items={[
                    { label: "Declinar toda la requisición", tone: "danger", onSelect: () => void handleDeclineWhole() },
                  ]}
                />
                {canSelfApprove && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    type="button"
                    onClick={() => void handleSelfApprove()}
                  >
                    Aprobar yo mismo
                  </button>
                )}
                <button
                  className="button button-dark"
                  disabled={busy}
                  type="button"
                  // GUARDA Y ENVÍA, en ese orden. Antes solo enviaba, y el servidor evaluaba el
                  // estado guardado: con el precio recién tecleado y sin haber pasado por un
                  // guardado, respondía "valor cotizado mayor a cero es obligatorio" con el
                  // formulario lleno delante. Si el guardado falla, `run` corta y no envía.
                  onClick={handleSendForApproval}
                >
                  Enviar a aprobación
                </button>
              </div>
            </div>
          ) : isApprover && requisition.status === "en_aprobacion" ? (
            <div className="connected-review" data-testid="approval-decisions" onBlur={decisionsAutosave.onBlurCapture}>
              {/* SOLO SUS ÍTEMS. Con aprobadores por ítem, enseñarle los demás sería invitarle a
                  decidir lo que el servicio le va a rechazar — y de paso enseñarle cifras que no le
                  tocan. Cuando hay ítems de otros se dice cuántos: si no, el aprobador cuenta tres
                  materiales en el WhatsApp del solicitante y aquí ve uno, y piensa que algo se perdió. */}
              {lineasDeOtros > 0 && (
                <p className="muted-copy" role="status">
                  Ves {misLineas.length} de {lines.length} ítems: los demás los decide otro aprobador.
                </p>
              )}
              {misLineas.map((line) => (
                <fieldset className={`review-line${line.status === "declinado" ? " review-line-declined" : ""}`} key={line.id}>
                  <legend>
                    {line.description ||
                      catalogs.items.find((item) => item.id === line.itemId)?.name ||
                      "Ítem"}
                  </legend>
                  <label className="field">
                    <span>Cantidad aprobada</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) })}
                    />
                  </label>
                  {/* Dos botones en vez de un desplegable: con el <select> decidir un ítem eran tres
                      gestos (abrir, elegir, cerrar) y el estado actual no se veía sin abrirlo. */}
                  <div className="field">
                    <span className="field-label" id={`decision-${line.id}`}>Decisión</span>
                    {/* Solo símbolos: rotularlos "Aprobar"/"Declinar" pondría un segundo botón
                        "Aprobar" al lado del que aprueba la requisición entera, y decidir un ítem
                        no es lo mismo que aprobarla. El nombre accesible sí lo dice completo. */}
                    <div className="decision-toggle" role="group" aria-labelledby={`decision-${line.id}`}>
                      <button
                        aria-label="Aprobar este ítem"
                        aria-pressed={line.status !== "declinado"}
                        className="decision-approve"
                        title="Aprobar este ítem"
                        type="button"
                        onClick={() => updateLine(line.id, { status: "aprobado", declineReason: undefined })}
                      >
                        <Check aria-hidden="true" size={18} />
                      </button>
                      <button
                        aria-label="Declinar este ítem"
                        aria-pressed={line.status === "declinado"}
                        className="decision-decline"
                        title="Declinar este ítem"
                        type="button"
                        onClick={() => updateLine(line.id, { status: "declinado", declineReason: line.declineReason })}
                      >
                        <X aria-hidden="true" size={18} />
                      </button>
                    </div>
                  </div>
                  {line.status === "declinado" && (
                    <label className="field field-wide">
                      <span>Motivo de declinación</span>
                      <textarea
                        required
                        value={line.declineReason ?? ""}
                        onChange={(event) => updateLine(line.id, { declineReason: event.target.value })}
                      />
                    </label>
                  )}
                  <strong>{money.format(estimateLineTotal(line))}</strong>
                </fieldset>
              ))}
              {missingField && (
                <p className="field-error" role="alert">
                  {MISSING_FIELD_MESSAGES[missingField]}
                </p>
              )}
              {/* Barra pegajosa: totales, indicador de autoguardado (reemplaza "Guardar
                  decisiones"), «Más ⋯» (Devolver a revisión) y la primaria de aprobar. */}
              <div className="connected-actions">
                <div className="connected-actions-totals" data-testid="line-summary">
                  <span>Subtotal <b className="money">{money.format(reviewLineTotals.base)}</b></span>
                  <span>IVA <b className="money">{money.format(reviewLineTotals.iva)}</b></span>
                  <span className="connected-line-summary-total">Total <b className="money">{money.format(reviewLineTotals.total)}</b></span>
                </div>
                <AutosaveIndicator autosave={decisionsAutosave} blockedReason={decisionsGuard} />
                {/* El maestro asignado sigue siendo revisor: que ver sus acciones de aprobación no le
                    quite «Reasignar aprobador», que tenía desde la vista de solo lectura. */}
                <ActionMenu
                  items={[
                    { label: "Devolver a revisión", onSelect: () => void handleReturn() },
                    ...(isReviewer ? [reassignMenuItem] : []),
                  ]}
                />
                <button
                  className="button button-dark"
                  disabled={busy || lines.some((line) => line.status === "declinado" && !line.declineReason?.trim())}
                  type="button"
                  onClick={() => void handleApprovePrimary()}
                >
                  <Check aria-hidden="true" size={16} />{" "}
                  {otherPending ? `Aprobar mis ítems (${misLineas.length})` : "Aprobar requisición"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ítem</th>
                      <th>Cantidad</th>
                      <th>Unidad</th>
                      <th>Base unit.</th>
                      <th>IVA %</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requisition.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.description ||
                            catalogs.items.find(
                              (option) => option.id === item.itemId,
                            )?.name ||
                            "Ítem de catálogo"}
                        </td>
                        <td>{item.quantity}</td>
                        <td>{item.unit}</td>
                        <td>{money.format(item.unitBase ?? 0)}</td>
                        <td>{item.ivaRate !== undefined ? `${Math.round(item.ivaRate * 100)} %` : money.format(item.unitIva ?? 0)}</td>
                        <td>
                          {item.status === "declinado" ? (
                            <Tone tone="danger" dot>
                              Declinado{item.declineReason ? ` · ${item.declineReason}` : ""}
                            </Tone>
                          ) : (
                            <Tone tone="muted" dot>Vigente</Tone>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* en_aprobacion · revisor: sin primaria (la decide el aprobador); solo queda
                  "Reasignar aprobador" detrás de «Más ⋯» — el bloque lateral fijo de siempre
                  desaparece de la vista. */}
              {isReviewer && requisition.status === "en_aprobacion" && (
                <div className="connected-actions connected-actions-menu-only">
                  <ActionMenu items={[reassignMenuItem]} />
                </div>
              )}
              {/* aprobada sin órdenes · revisor: la primaria "Generar órdenes (K)" vive aquí,
                  al pie del panel de ítems, igual que las demás. "Asignar proveedores" ya no es
                  un botón aparte: la primaria hace `assign_suppliers` + `generate_orders` en una
                  sola secuencia, y si falta algún proveedor enfoca el primer select faltante en
                  vez de intentarlo. */}
              {isReviewer && requisition.status === "aprobada" && orders.length === 0 && (
                <div className="connected-actions">
                  <span />
                  <span />
                  <span />
                  <button
                    className="button button-dark"
                    type="button"
                    disabled={busy || (orderSupplierGroups.length === 0 && missingSupplierItems.length === 0)}
                    onClick={() => void handleGenerateOrders()}
                  >
                    Generar órdenes ({orderSupplierGroups.length})
                  </button>
                </div>
              )}
            </>
          )}
        </section>
        <aside className="connected-side">
          <section className="panel connected-summary">
            <h3>Control</h3>
            <dl>
              <div>
                <dt>Estado</dt>
                <dd>{estadoLabel(requisition.status)}</dd>
              </div>
              <div>
                {/* RF-404: requesterId/externalRequester ya viajaban en el payload de
                    /api/requisitions/:id/detail; solo faltaba mostrarlos en el detalle. */}
                <dt>Solicitante</dt>
                <dd data-testid="requisition-requester">
                  {requisition.externalRequester
                    ? `${requisition.externalRequester.name}${
                        requisition.externalRequester.phone
                          ? ` · ${requisition.externalRequester.phone}`
                          : ""
                      }`
                    : // HUECO 2: el nombre ya viaja en catalogs.users (GET /api/catalogs, id+nombre
                      // solamente); "Solicitante interno" se conserva como fallback honesto — nunca se
                      // muestra el UUID crudo si el id no aparece en esa lista.
                      resolveUserName(catalogs, requisition.requesterId, "Solicitante interno")}
                </dd>
              </div>
              <div>
                {/* Reunión 2026-09: el aprobador ya no se deriva de la etiqueta — lo elige el revisor en
                    la revisión (ver el <select> "Aprobador", arriba). Se muestra aquí para toda la
                    ficha, incluida la vista de solo lectura de roles que no revisan. */}
                <dt>Aprobador</dt>
                <dd data-testid="requisition-approver">
                  {resolveUserName(catalogs, requisition.approverId, "Sin aprobador asignado")}
                </dd>
              </div>
              <div>
                {/* Reunión 2026-09-12: cabecera de solo lectura — el <select> editable vive arriba,
                    junto a Obra, solo mientras la requisición admite cambios (headerEditable). */}
                <dt>Centro de costo</dt>
                <dd data-testid="requisition-cost-center">
                  {requisition.costCenterId
                    ? (catalogs.costCenters ?? []).find((costCenter) => costCenter.id === requisition.costCenterId)?.name ?? "—"
                    : "Sin centro asignado"}
                </dd>
              </div>
              <div>
                <dt>Empresa facturada</dt>
                <dd data-testid="requisition-billed-company">
                  {billedCompanyName((requisition as BilledCompanyAware).billedCompanyId)}
                </dd>
              </div>
              {originalPaymentTotal !== null && originalPaymentTotal !== summarizeLines(requisition.items).total && (
                <div>
                  <dt>Valor original</dt>
                  <dd data-testid="requisition-original-amount">{money.format(originalPaymentTotal)}</dd>
                </div>
              )}
              <div>
                <dt>{requisition.type === "pago" ? "Fecha del gasto" : "Fecha requerida"}</dt>
                <dd>{requisition.requiredDate ? formatIsoDate(requisition.requiredDate) : "—"}</dd>
              </div>
              <div>
                <dt>Observaciones</dt>
                <dd>{requisition.observations || "—"}</dd>
              </div>
            </dl>
            {/* QA H5: llega así del portal o de WhatsApp (solo identificación y nombre); sin esta marca
                el revisor solo se enteraba entrando a Proveedores. */}
            {requisition.beneficiaryPendingNormalization && (
              <p data-testid="beneficiary-pending">
                <Tone tone="warning" dot>Beneficiario pendiente de completar</Tone>{" "}
                {isReviewer && beneficiaryId && (
                  <a
                    className="text-link"
                    href={supplierFichaPath(beneficiaryId)}
                    onClick={(event) => {
                      event.preventDefault();
                      go(supplierFichaPath(beneficiaryId));
                    }}
                  >
                    Completar ficha
                  </a>
                )}
              </p>
            )}
            {/* Cabecera editable: ya no hay toggle "Editar cabecera"/Cancelar/Guardar cambios —
                los campos son inline y se autoguardan solos (PATCH /api/requisitions/:id). */}
            {headerEditable && (
              <div className="connected-header-edit" onBlur={headerAutosave.onBlurCapture}>
                <label className="field">
                  <span>{requisition.type === "pago" ? "Fecha del gasto" : "Fecha requerida"}</span>
                  <input
                    type="date"
                    value={headerForm.requiredDate}
                    onChange={(event) => setHeaderForm({ ...headerForm, requiredDate: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Observaciones</span>
                  <textarea
                    maxLength={1024}
                    value={headerForm.observations}
                    onChange={(event) => setHeaderForm({ ...headerForm, observations: event.target.value })}
                  />
                </label>
                <AutosaveIndicator autosave={headerAutosave} blockedReason={null} />
              </div>
            )}
            {requisition.returnReason && (
              <p data-testid="return-reason">
                <b>Motivo de devolución:</b> {requisition.returnReason}
              </p>
            )}
            {requisition.declineReason && (
              <p data-testid="decline-reason">
                <b>Motivo de declinación:</b> {requisition.declineReason}
              </p>
            )}
            {feedback && (
              <p className="field-error" role="alert">
                {feedback}
              </p>
            )}
            {/* La señal que faltaba. Sin esto, la única confirmación de que la acción ocurrió era el
                chip de estado — y como `refresh()` no se esperaba, ni siquiera eso llegaba a tiempo:
                "no cambia de estado ni dice ok, ya aprobaste". Aparece DESPUÉS de la recarga, así que
                cuando se lee, lo que hay en pantalla ya es el estado nuevo. */}
            {success && (
              <p className="field-success" role="status">
                {success}
              </p>
            )}
          </section>
          {/* Reunión 2026-08-31: "Generar órdenes" es su propio paso — el cliente dijo literalmente
              que no la veía. Reutiliza el resumen de asignación por proveedor como preview; muestra
              qué grupos saldrán y qué falta antes de intentarlo. El botón que dispara la acción
              vive en la barra pegajosa del panel de ítems (arriba), no aquí. */}
          {isReviewer && requisition.status === "aprobada" && orders.length === 0 ? (
            <section className="panel connected-summary" data-testid="generate-orders-panel">
              <h3>Generar órdenes</h3>
              <p className="panel-sub">Ítems aprobados agrupados por proveedor; se genera una orden por grupo.</p>
              {orderSupplierGroups.map(([supplierId, items]) => (
                <p key={supplierId} data-testid="order-supplier-group">
                  <b>{supplierName(supplierId)}</b> · {items.length} ítem{items.length === 1 ? "" : "s"} ·{" "}
                  {money.format(items.reduce((sum, item) => sum + estimateLineTotal(item), 0))}
                </p>
              ))}
              {missingSupplierItems.length > 0 && (
                <div className="missing-supplier-assign" data-testid="missing-supplier-warning">
                  <p className="field-error" role="alert">
                    {missingSupplierItems.length} ítem{missingSupplierItems.length === 1 ? "" : "s"} aprobado{missingSupplierItems.length === 1 ? "" : "s"} sin proveedor asignado: elígelo abajo y pulsa &ldquo;Generar órdenes&rdquo;.
                  </p>
                  {missingSupplierItems.map((item) => (
                    <label className="field" key={item.id}>
                      <span>{item.description || item.itemId || "Ítem sin descripción"}</span>
                      <select
                        id={`assign-supplier-${item.id}`}
                        value={assignSupplierChoice[item.id] ?? ""}
                        onChange={(event) =>
                          setAssignSupplierChoice((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                      >
                        <option value="">Selecciona un proveedor</option>
                        {supplierOptions.map((supplier) => (
                          <option key={supplier.id} value={supplier.id}>
                            {supplier.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              {/* GRAVE 3: todo `disabled` lleva texto adyacente con la razón y el siguiente
                  paso, no solo un `title` — antes, si el aprobador declinaba todos los ítems,
                  este botón quedaba muerto y mudo (el `title` solo cubría el caso de proveedor
                  faltante). */}
              {orderSupplierGroups.length === 0 && missingSupplierItems.length === 0 && (
                <p className="field-error" role="alert">
                  No hay ítems aprobados con proveedor asignado: el aprobador declinó todos los
                  ítems o ninguno tiene proveedor todavía. No hay nada que generar.
                </p>
              )}
            </section>
          ) : (
            supplierGroups.length > 0 && (
              <section className="panel connected-summary">
                <h3>Asignación por proveedor</h3>
                {supplierGroups.map((supplierId) => (
                  <p key={supplierId} data-testid="supplier-allocation">
                    {supplierName(supplierId)}
                  </p>
                ))}
              </section>
            )
          )}
          {orders.length > 0 && (
            <section className="panel connected-summary">
              <h3>Documentos generados</h3>
              {orders.map((order) => (
                <a
                  key={order.id}
                  href={`/api/orders/${order.id}/document`}
                  className="text-link"
                  data-testid={
                    order.type === "OP"
                      ? "payment-order"
                      : "purchase-order-document"
                  }
                >
                  <b>{order.consecutive}</b> · descargar PDF provisional
                </a>
              ))}
              {expenses.map((expense) => (
                <p
                  key={expense.id}
                  data-testid={
                    requisition.type === "pago"
                      ? "payment-expense"
                      : "expense-by-order"
                  }
                >
                  {money.format(expense.total)} · gasto automático
                </p>
              ))}
              {requisition.type === "pago" && requisition.tagId && (
                <p data-testid="payment-tag">
                  {catalogs.tags.find((tag) => tag.id === requisition.tagId)
                    ?.name ?? requisition.tagId}
                </p>
              )}
            </section>
          )}
          {/* Reunión 2026-08-31: separa visualmente los adjuntos del SOLICITANTE (soportes,
              fotos) de las COTIZACIONES del comprador — son dos cosas distintas para quien
              aprueba y antes se mezclaban en una sola lista. */}
          <section className="panel connected-summary">
            <h3>Adjuntos del solicitante</h3>
            {requesterAttachments.length ? (
              <div className="attachment-list">
                {requesterAttachments.map((attachment) => (
                  <a
                    className="attachment-link"
                    key={attachment.id}
                    href={`/api/attachments/${attachment.entity}/${encodeURIComponent(attachment.entityId)}/${encodeURIComponent(attachment.id)}/download`}
                    download={attachment.name}
                  >
                    <b>
                      {attachment.type === "foto"
                        ? `Foto del ítem ${
                            requisition.items.findIndex(
                              (item) => item.id === attachment.entityId,
                            ) + 1
                          }`
                        : "Soporte general"}
                    </b>{" "}· {attachment.name}
                  </a>
                ))}
              </div>
            ) : (
              <p>Sin soportes cargados para esta requisición.</p>
            )}
          </section>
          <section className="panel connected-summary">
            <h3>Cotizaciones del comprador</h3>
            {quoteAttachments.length ? (
              <div className="attachment-list">
                {quoteAttachments.map((attachment) => (
                  <a
                    className="attachment-link"
                    key={attachment.id}
                    href={`/api/attachments/${attachment.entity}/${encodeURIComponent(attachment.entityId)}/${encodeURIComponent(attachment.id)}/download`}
                    download={attachment.name}
                  >
                    <b>Cotización</b> · {attachment.name}
                  </a>
                ))}
              </div>
            ) : (
              <p>Sin cotizaciones cargadas para esta requisición.</p>
            )}
            {isReviewer && ["en_revision", "devuelta"].includes(requisition.status) && (
              <div className="connected-header-edit">
                <AttachmentPicker
                  id="requisition-quote"
                  label="Adjuntar cotización"
                  help="PDF, JPG, PNG o WebP · máximo 10 MB"
                  file={quoteFile}
                  onFile={(file) => {
                    setQuoteFile(file);
                    // Ya no hay botón "Subir cotización": se sube en cuanto se elige el archivo.
                    if (file) void uploadQuote(file);
                  }}
                  onError={setQuoteFeedback}
                  disabled={quoteBusy}
                />
                {quoteBusy && <p className="muted-copy" role="status">Cargando cotización…</p>}
                {quoteFeedback && (
                  <p className="field-error" role="alert">{quoteFeedback}</p>
                )}
              </div>
            )}
          </section>
          <section className="panel connected-summary">
            <h3>Historial de trazabilidad</h3>
            {history.length ? (
              history.map((entry, index) => (
                <p key={`${entry.at}-${index}`} data-testid="audit-event">
                  <b>{eventLabel(entry.event)}</b> ·{" "}
                  {new Date(entry.at).toLocaleString("es-CO")} ·{" "}
                  {/* RF-405: AuditEvent.actorId ya viajaba en el JSON del historial; sin
                      esto la trazabilidad no decía qué usuario ejecutó cada transición.
                      HUECO 2: el nombre ya viaja en catalogs.users; "Usuario interno" se conserva
                      como fallback honesto — nunca se muestra el UUID crudo. */}
                  <span data-testid="audit-actor">
                    {entry.actorId ? resolveUserName(catalogs, entry.actorId, "Usuario interno") : "Automático"}
                  </span>
                  {typeof entry.data?.comment === "string"
                    ? ` · ${entry.data.comment}`
                    : ""}
                </p>
              ))
            ) : (
              <p>Sin eventos visibles para esta requisición.</p>
            )}
          </section>
        </aside>
      </div>
      {isReviewer && (
        <SupplierQuickCreate
          open={Boolean(quickSupplierItemId)}
          description={`Se asignará a ${quickSupplierItem?.description || "este ítem"}.`}
          submitLabel="Crear y asignar"
          onClose={closeQuickSupplier}
          onCreated={assignQuickSupplier}
        />
      )}
      {/* en_aprobacion · revisor: "Reasignar aprobador" detrás de «Más ⋯» — mismo patrón de
          diálogo que la alta rápida de proveedor, con el <select> dentro. Reutiliza
          `approverId`/`setApproverId` (mismo estado que el <select> de la revisión): no
          colisionan porque nunca se muestran a la vez. */}
      {isReviewer && requisition.status === "en_aprobacion" && reassignOpen && (
        <div
          className="quick-supplier-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeReassign();
          }}
        >
          <div
            className="panel quick-supplier-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reassign-title"
            data-testid="reassign-approver"
          >
            <div className="panel-head">
              <div>
                <h2 id="reassign-title">Reasignar aprobador</h2>
              </div>
              <button className="icon-button" type="button" aria-label="Cerrar" onClick={closeReassign}>
                <X aria-hidden="true" size={16} />
              </button>
            </div>
            <div className="quick-supplier-body">
              <p className="muted-copy">Si el aprobador asignado no puede atenderla, reasígnala aquí.</p>
              <label className="field">
                <span>Reasignar aprobador</span>
                <select value={approverId} onChange={(event) => setApproverId(event.target.value)}>
                  <option value="">Selecciona un aprobador</option>
                  {(catalogs.approvers ?? []).map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-footer">
              <button className="button button-secondary" type="button" onClick={closeReassign}>
                Cancelar
              </button>
              <button
                className="button button-dark"
                type="button"
                disabled={busy || !approverId || approverId === requisition.approverId}
                onClick={() => {
                  void run({ action: "reassign_approver", approverId }, "Aprobador reasignado.");
                  closeReassign();
                }}
              >
                Reasignar aprobador
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </>
  );
}
