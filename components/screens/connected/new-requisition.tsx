"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedNewRequisition y
// DemoRequisitionScreen, partidos de components/screens/connected.tsx. Misma lógica, mismos
// nombres. `DraftLine` es un tipo local de esta pantalla (no se reutiliza en otra);
// `AttachmentProgress`/`uploadOperationalAttachment` se movieron a shared.tsx porque
// detail.tsx (cotización del comprador) y expenses.tsx (soportes de caja menor) también los
// usan.
import { useState, type FormEvent } from "react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { SectionTitle } from "../screen-primitives";
import { AttachmentPicker, IMAGE_MIME_TYPES } from "../attachment-upload";
import {
  emptyCatalogs,
  localTodayISO,
  uploadOperationalAttachment,
  type AttachmentProgress,
  type CatalogData,
  type RequisitionRow,
} from "./shared";
import { mutate } from "./data";

type DraftLine = {
  key: string;
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  possibleSupplier: string;
  productLink: string;
  photo: File | null;
};
const newLine = (): DraftLine => ({
  key: crypto.randomUUID(),
  itemId: "",
  description: "",
  quantity: "1",
  unit: "unidad",
  possibleSupplier: "",
  productLink: "",
  photo: null,
});

export function ConnectedNewRequisition({
  catalogs = emptyCatalogs,
  go,
}: {
  catalogs: CatalogData;
  go: (path: string) => void;
}) {
  // Reunión 2026-08-31: el solicitante elige EMPRESA, no obra (la asigna el revisor en la
  // revisión); la fecha requerida pasa a opcional (sin default de hoy ni validación de fecha
  // pasada) para no bloquear a quien no la conoce todavía.
  const [type, setType] = useState<"compra" | "pago">("compra"),
    [societyId, setSocietyId] = useState(catalogs.societies?.[0]?.id ?? ""),
    [requiredDate, setRequiredDate] = useState("");
  const [observations, setObservations] = useState(""),
    [supportFile, setSupportFile] = useState<File | null>(null),
    [lines, setLines] = useState<DraftLine[]>([newLine()]),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [uploadProgress, setUploadProgress] = useState<AttachmentProgress | null>(null),
    [success, setSuccess] = useState(""),
    [createdId, setCreatedId] = useState("");
  const updateLine = (key: string, patch: Partial<DraftLine>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (createdId) {
      setFeedback("La requisición ya fue creada; consulta el detalle para gestionar los soportes pendientes.");
      return;
    }
    const invalidLine = lines.find(
      (line) =>
        (!line.itemId && !line.description.trim()) ||
        !line.unit.trim() ||
        !Number.isFinite(Number(line.quantity)) ||
        Number(line.quantity) <= 0 ||
        (line.productLink.trim() &&
          !/^https:\/\//i.test(line.productLink.trim())),
    );
    if (!societyId || invalidLine) {
      setFeedback(
        !societyId
          ? "Selecciona la empresa."
          : "Completa cada ítem con descripción o catálogo, cantidad, unidad y un link HTTPS válido.",
      );
      return;
    }
    setBusy(true);
    setFeedback("");
    setSuccess("");
    let createdEntityId = "";
    try {
      const created = (await mutate("/api/requisitions", "POST", {
        type,
        societyId,
        ...(requiredDate ? { requiredDate } : {}),
        ...(observations.trim() ? { observations: observations.trim() } : {}),
        items: lines.map((line) => ({
          ...(line.itemId
            ? { itemId: line.itemId }
            : { description: line.description.trim() }),
          quantity: Number(line.quantity),
          unit: line.unit.trim(),
          ...(line.possibleSupplier.trim()
            ? { possibleSupplier: line.possibleSupplier.trim() }
            : {}),
          ...(line.productLink.trim()
            ? { productLink: line.productLink.trim() }
            : {}),
        })),
      })) as RequisitionRow;
      createdEntityId = created.id;
      setCreatedId(created.id);
      const uploads: Array<{
        entity: "requisicion" | "requisicion_item";
        entityId: string;
        type: "soporte" | "foto";
        file: File;
      }> = [];
      let pendingWithoutItemId = 0;
      if (supportFile) {
        uploads.push({
          entity: "requisicion",
          entityId: created.id,
          type: "soporte",
          file: supportFile,
        });
      }
      lines.forEach((line, index) => {
        const itemId = created.items?.[index]?.id;
        if (line.photo && itemId) {
          uploads.push({
            entity: "requisicion_item",
            entityId: itemId,
            type: "foto",
            file: line.photo,
          });
        } else if (line.photo) {
          pendingWithoutItemId += 1;
        }
      });
      if (!uploads.length) {
        if (pendingWithoutItemId) {
          setFeedback(
            `La requisición fue creada; ${pendingWithoutItemId} foto quedó pendiente porque el servicio no devolvió el ítem.`,
          );
          return;
        }
        setSuccess("Requisición creada correctamente.");
        go(`/requisiciones/${created.id}`);
        return;
      }
      setUploadProgress({ completed: 0, total: uploads.length, stage: "preparing" });
      for (const [index, upload] of uploads.entries()) {
        await uploadOperationalAttachment({
          ...upload,
          onProgress: (stage) =>
            setUploadProgress({ completed: index, total: uploads.length, stage }),
        });
        setUploadProgress({
          completed: index + 1,
          total: uploads.length,
          stage: "completing",
        });
      }
      if (pendingWithoutItemId) {
        setFeedback(
          `La requisición fue creada y ${uploads.length} soporte(s) cargaron; ${pendingWithoutItemId} foto(s) quedaron pendientes porque el servicio no devolvió el ítem.`,
        );
        return;
      }
      setSuccess(
        `Requisición creada y ${uploads.length === 1 ? "archivo cargado" : `${uploads.length} archivos cargados`} correctamente.`,
      );
    } catch (error) {
      setFeedback(
        createdEntityId
          ? `La requisición sí fue creada; el soporte quedó pendiente. ${
              error instanceof Error ? error.message : "No fue posible completar la carga."
            }`
          : error instanceof Error
            ? error.message
            : "No fue posible crear la requisición.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="Captura interna"
        title="Nueva requisición"
        // MENOR (QA 2026-08-31): "pendientes de normalización" es vocabulario de base de
        // datos, no del cliente — se explica qué significa para quien lo lee.
        description="Los ítems que no estén en el catálogo quedan a la espera de que un administrador los agregue."
      />
      <form className="panel connected-form" onSubmit={submit} noValidate>
        <div className="form-section">
          <div className="field-grid">
            <label className="field">
              <span>Tipo</span>
              <select
                value={type}
                onChange={(event) =>
                  setType(event.target.value as "compra" | "pago")
                }
              >
                <option value="compra">Compra</option>
                <option value="pago">Pago</option>
              </select>
            </label>
            <label className="field">
              <span>Empresa</span>
              {/* GRAVE 3: sin empresas registradas el <select> antes se veía con una sola
                  opción fantasma ("Selecciona una empresa") y el formulario parecía completo
                  aunque el botón "Crear requisición" nunca fuera a habilitarse. */}
              <select
                required
                value={societyId}
                disabled={!(catalogs.societies ?? []).length}
                aria-invalid={Boolean(feedback && !societyId)}
                aria-describedby={
                  (catalogs.societies ?? []).length ? "requisition-form-error" : "society-empty-reason"
                }
                onChange={(event) => setSocietyId(event.target.value)}
              >
                <option value="">
                  {(catalogs.societies ?? []).length ? "Selecciona una empresa" : "Sin empresas registradas"}
                </option>
                {(catalogs.societies ?? []).map((society) => (
                  <option key={society.id} value={society.id}>
                    {society.name}
                  </option>
                ))}
              </select>
              {!(catalogs.societies ?? []).length && (
                <small className="field-error" role="alert" id="society-empty-reason">
                  No hay empresas registradas todavía: pídele a un Administrador Mizar que cree
                  al menos una antes de poder crear la requisición.
                </small>
              )}
            </label>
            <label className="field">
              {/* RF reunión 2026-08-31: fecha opcional, sin default de hoy ni bloqueo por fecha pasada. */}
              <span>Fecha requerida (opcional)</span>
              <input
                type="date"
                value={requiredDate}
                onChange={(event) => setRequiredDate(event.target.value)}
              />
            </label>
            <label className="field field-wide">
              {/* RF reunión 2026-08-31: "Frente o actividad" se elimina y se fusiona aquí. */}
              <span>Observaciones <small>di a dónde va la compra</small></span>
              <textarea
                maxLength={3000}
                placeholder="Ej. Frente norte, bodega 3, torre B piso 4…"
                value={observations}
                onChange={(event) => setObservations(event.target.value)}
              />
            </label>
            <AttachmentPicker
              id="requisition-support"
              label="Soporte general (opcional)"
              help="PDF, JPG, PNG o WebP · máximo 10 MB"
              file={supportFile}
              onFile={setSupportFile}
              onError={setFeedback}
              disabled={busy}
            />
          </div>
        </div>
        <div className="form-section">
          <div className="panel-head connected-head">
            <div>
              <h2>Ítems</h2>
              <p className="panel-sub">
                Selecciona catálogo o describe una propuesta nueva.
              </p>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setLines((current) => [...current, newLine()])}
            >
              <Plus aria-hidden="true" size={14} /> Agregar ítem
            </button>
          </div>
          <div className="connected-lines">
            {lines.map((line, index) => (
              <fieldset className="connected-line" key={line.key}>
                <legend>Ítem {index + 1}</legend>
                <label className="field">
                  <span>Catálogo</span>
                  <select
                    value={line.itemId}
                    onChange={(event) => {
                      const selected = catalogs.items.find(
                        (item) => item.id === event.target.value,
                      );
                      updateLine(line.key, {
                        itemId: event.target.value,
                        unit: selected?.unit ?? line.unit,
                        description: "",
                      });
                    }}
                  >
                    <option value="">Proponer nuevo</option>
                    {catalogs.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.status !== "activo" ? " · pendiente" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {!line.itemId && (
                  <label className="field">
                    <span>Descripción nueva</span>
                    <input
                      required
                      maxLength={500}
                      value={line.description}
                      aria-invalid={Boolean(
                        feedback && !line.description.trim(),
                      )}
                      aria-describedby="requisition-form-error"
                      onChange={(event) =>
                        updateLine(line.key, {
                          description: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
                <label className="field">
                  <span>Cantidad</span>
                  <input
                    required
                    type="number"
                    min="0.001"
                    max="1000000"
                    step="0.001"
                    value={line.quantity}
                    aria-invalid={Boolean(
                      feedback &&
                        (!Number.isFinite(Number(line.quantity)) ||
                          Number(line.quantity) <= 0),
                    )}
                    aria-describedby="requisition-form-error"
                    onChange={(event) =>
                      updateLine(line.key, { quantity: event.target.value })
                    }
                  />
                </label>
                <AttachmentPicker
                  id={`requisition-item-photo-${line.key}`}
                  label="Foto del ítem (opcional)"
                  help="JPG, PNG o WebP · máximo 10 MB"
                  allowedMimeTypes={IMAGE_MIME_TYPES}
                  file={line.photo}
                  onFile={(photo) => updateLine(line.key, { photo })}
                  onError={setFeedback}
                  disabled={busy}
                />
                <label className="field">
                  <span>Unidad</span>
                  <input
                    required
                    maxLength={40}
                    value={line.unit}
                    aria-invalid={Boolean(feedback && !line.unit.trim())}
                    aria-describedby="requisition-form-error"
                    onChange={(event) =>
                      updateLine(line.key, { unit: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Proveedor sugerido</span>
                  <input
                    maxLength={240}
                    value={line.possibleSupplier}
                    onChange={(event) =>
                      updateLine(line.key, {
                        possibleSupplier: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Link HTTPS</span>
                  <input
                    type="url"
                    pattern="https://.*"
                    title="Usa una URL HTTPS o deja el campo vacío."
                    placeholder="https://"
                    value={line.productLink}
                    aria-invalid={Boolean(
                      feedback &&
                        line.productLink.trim() &&
                        !/^https:\/\//i.test(line.productLink.trim()),
                    )}
                    aria-describedby="requisition-form-error"
                    onChange={(event) =>
                      updateLine(line.key, { productLink: event.target.value })
                    }
                  />
                </label>
                <button
                  className="icon-button connected-remove"
                  type="button"
                  aria-label={`Quitar ítem ${index + 1}`}
                  disabled={lines.length === 1}
                  onClick={() =>
                    setLines((current) =>
                      current.filter((item) => item.key !== line.key),
                    )
                  }
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              </fieldset>
            ))}
          </div>
        </div>
        <div className="form-footer">
          {feedback ? (
            <p className="field-error" role="alert" id="requisition-form-error">
              {feedback}
            </p>
          ) : success ? (
            <p className="field-success" role="status">
              {success} {uploadProgress && `(${uploadProgress.completed}/${uploadProgress.total})`}
            </p>
          ) : uploadProgress && busy ? (
            <p className="muted-copy" role="status">
              {uploadProgress.stage === "preparing"
                ? "Preparando soporte…"
                : uploadProgress.stage === "uploading"
                  ? "Cargando soporte…"
                  : "Confirmando soporte…"}{" "}
              ({uploadProgress.completed}/{uploadProgress.total})
            </p>
          ) : !(catalogs.societies ?? []).length ? (
            // GRAVE 3: el solicitante veía un formulario completo y un botón que nunca
            // respondía; el remedio (crear una empresa) requiere rol Administrador Mizar, así
            // que el texto se lo dice en vez de dejarlo adivinar.
            <p className="field-error" role="alert">
              No hay empresas registradas: no es posible crear una requisición todavía. Pídele a
              un Administrador Mizar que registre al menos una empresa.
            </p>
          ) : (
            <span>Los valores cotizados se completan durante la revisión.</span>
          )}
          {createdId && (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => go(`/requisiciones/${createdId}`)}
            >
              Ver requisición <ArrowRight aria-hidden="true" size={14} />
            </button>
          )}
          <button
            className="button button-dark"
            disabled={busy || Boolean(createdId) || !(catalogs.societies ?? []).length}
            type="submit"
          >
            {busy ? "Guardando…" : "Crear requisición"} <ArrowRight aria-hidden="true" size={14} />
          </button>
        </div>
      </form>
    </>
  );
}

export function DemoRequisitionScreen() {
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [feedback, setFeedback] = useState("");
  const save = () =>
    setFeedback(
      supportFile || photoFile
        ? "Borrador demo guardado; los archivos cumplen la validación de carga."
        : "Borrador demo guardado.",
    );
  return (
    <>
      <SectionTitle
        eyebrow="Captura interna"
        title="Nueva requisición"
        description="Adjunta un soporte general y una foto opcional por ítem. Esta pantalla demo no persiste datos."
      />
      <div className="panel connected-form">
        <div className="field-grid">
          <label className="field">
            <span>Obra</span>
            <select defaultValue="Torre Norte"><option>Torre Norte</option><option>Casa 18</option></select>
          </label>
          <label className="field">
            <span>Fecha requerida</span>
            <input type="date" defaultValue={localTodayISO()} />
          </label>
          <label className="field field-wide">
            <span>Observaciones</span>
            <textarea placeholder="Indica el frente o la necesidad…" />
          </label>
          <AttachmentPicker
            id="demo-requisition-support"
            label="Soporte general (opcional)"
            help="PDF, JPG, PNG o WebP · máximo 10 MB"
            file={supportFile}
            onFile={setSupportFile}
            onError={setFeedback}
          />
        </div>
        <fieldset className="connected-line">
          <legend>Ítem 1</legend>
          <label className="field"><span>Descripción</span><input defaultValue="Material de obra" /></label>
          <label className="field"><span>Cantidad</span><input type="number" min="1" defaultValue="1" /></label>
          <AttachmentPicker
            id="demo-requisition-item-photo"
            label="Foto del ítem (opcional)"
            help="JPG, PNG o WebP · máximo 10 MB"
            allowedMimeTypes={IMAGE_MIME_TYPES}
            file={photoFile}
            onFile={setPhotoFile}
            onError={setFeedback}
          />
        </fieldset>
        {feedback && <p className={feedback.includes("guardado") ? "field-success" : "field-error"} role={feedback.includes("guardado") ? "status" : "alert"}>{feedback}</p>}
        <div className="form-footer"><span className="muted-copy">Demo sin persistencia</span><button className="button button-dark" type="button" onClick={save}>Guardar borrador</button></div>
      </div>
    </>
  );
}
