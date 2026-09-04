"use client";

import { FileText, Image as ImageIcon, Upload, X } from "lucide-react";
import { useId, type ChangeEvent } from "react";
import { describeApiError, FriendlyApiError } from "../../lib/http/friendly-error";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type AttachmentMetadata = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  [key: string]: unknown;
};

export type SignedAttachmentResponse = {
  attachment?: { id?: unknown };
  upload?: {
    url: string;
    method: "PUT";
    multipart: {
      cacheControl: string;
      fileField: string;
    };
  };
};

export function validateAttachmentFile(
  file: File,
  options: { allowedMimeTypes?: readonly string[]; maxBytes?: number } = {},
) {
  const allowed = options.allowedMimeTypes ?? DOCUMENT_MIME_TYPES;
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  if (!allowed.includes(file.type)) {
    return `El archivo debe ser ${allowed.includes("application/pdf") ? "PDF, JPG, PNG o WebP" : "JPG, PNG o WebP"}.`;
  }
  if (file.size < 1 || file.size > maxBytes) {
    return `El archivo debe pesar como máximo ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  }
  return "";
}

export function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPicker({
  id,
  label,
  help,
  file,
  onFile,
  onError,
  allowedMimeTypes = DOCUMENT_MIME_TYPES,
  disabled = false,
}: {
  id?: string;
  label: string;
  help: string;
  file: File | null;
  onFile: (file: File | null) => void;
  onError: (message: string) => void;
  allowedMimeTypes?: readonly string[];
  disabled?: boolean;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!next) return;
    const error = validateAttachmentFile(next, { allowedMimeTypes });
    if (error) {
      onError(error);
      return;
    }
    onError("");
    onFile(next);
  };
  return (
    <div className="attachment-picker" style={{ gridColumn: "1 / -1" }}>
      <label className="upload-box attachment-picker-label" htmlFor={inputId}>
        {allowedMimeTypes.includes("application/pdf") ? <FileText aria-hidden="true" size={18} /> : <ImageIcon aria-hidden="true" size={18} />}
        <span>
          <b>{label}</b>
          <small>{file ? `${file.name} · ${formatAttachmentSize(file.size)}` : help}</small>
        </span>
        <span className="attachment-picker-action"><Upload aria-hidden="true" size={14} /> {file ? "Cambiar" : "Adjuntar"}</span>
        <input aria-label={label} id={inputId} type="file" accept={allowedMimeTypes.join(",")} onChange={onChange} disabled={disabled} />
      </label>
      {file && (
        <button className="attachment-remove" type="button" onClick={() => onFile(null)} disabled={disabled}>
          <X aria-hidden="true" size={13} /> Quitar archivo
        </button>
      )}
    </div>
  );
}

export async function uploadSignedAttachment({
  prepareUrl,
  completeUrl,
  file,
  metadata,
  fetcher = fetch,
  onProgress,
}: {
  prepareUrl: string;
  completeUrl: string | ((attachmentId: string) => string);
  file: File;
  metadata: AttachmentMetadata;
  fetcher?: typeof fetch;
  onProgress?: (stage: "preparing" | "uploading" | "completing") => void;
}) {
  onProgress?.("preparing");
  const prepareResponse = await fetcher(prepareUrl, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  const prepared = (await prepareResponse.json().catch(() => null)) as SignedAttachmentResponse | { message?: string } | null;
  if (!prepareResponse.ok) throw new FriendlyApiError(describeApiError(prepareResponse.status, prepared));
  if (!prepared || !("upload" in prepared) || !prepared.upload) {
    throw new Error("No fue posible preparar la carga del archivo. Intenta de nuevo.");
  }
  const attachmentId =
    prepared.attachment && typeof prepared.attachment.id === "string"
      ? prepared.attachment.id
      : "";
  if (!attachmentId) throw new Error("La preparación no devolvió el identificador del archivo.");
  const multipart = prepared.upload.multipart;
  if (
    !multipart ||
    typeof multipart.cacheControl !== "string" ||
    typeof multipart.fileField !== "string"
  ) {
    throw new Error("La carga no tiene un contrato multipart válido.");
  }
  const body = new FormData();
  body.append("cacheControl", multipart.cacheControl);
  body.append(multipart.fileField, file);
  onProgress?.("uploading");
  const uploadResponse = await fetcher(prepared.upload.url, {
    method: prepared.upload.method,
    body,
  });
  if (!uploadResponse.ok) throw new Error("La carga del archivo falló. Verifica tu conexión e intenta nuevamente.");
  onProgress?.("completing");
  const completeResponse = await fetcher(
    typeof completeUrl === "function" ? completeUrl(attachmentId) : completeUrl,
    {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
    },
  );
  const completed = await completeResponse.json().catch(() => null);
  if (!completeResponse.ok) throw new FriendlyApiError(describeApiError(completeResponse.status, completed));
  return completed;
}
