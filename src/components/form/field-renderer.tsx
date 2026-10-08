"use client";

import { useState } from "react";
import { FieldConfig, FormValues, AI_DECIDE, NOT_SURE, OTHER, UploadedMedia } from "@/lib/form-schema/types";

function resolveOptions(field: FieldConfig, values: FormValues) {
  const raw = typeof field.options === "function" ? field.options(values) : field.options ?? [];
  return raw;
}

function Wrapper({ field, children }: { field: FieldConfig; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {field.label}
        {field.required && <span className="ml-1 text-red-500">*</span>}
        {!field.required && <span className="ml-1.5 text-xs font-normal text-zinc-400">optional</span>}
      </label>
      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{field.help}</p>
      <div className="mt-1.5">{children}</div>
      {field.example && (
        <p className="mt-1 text-xs italic text-zinc-400">e.g. {field.example}</p>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-zinc-200 px-3.5 py-2.5 text-sm outline-none focus:border-zinc-400 dark:border-zinc-800 dark:bg-transparent dark:focus:border-zinc-600";

export function FieldRenderer({
  field,
  values,
  onChange,
}: {
  field: FieldConfig;
  values: FormValues;
  onChange: (id: string, value: unknown) => void;
}) {
  const value = values[field.id];
  const [showCustom, setShowCustom] = useState(false);
  // Only used by the "tags" branch below, but must be called unconditionally
  // on every render — it was previously declared inside that branch, after
  // several early returns, which violates React's Rules of Hooks.
  const [draft, setDraft] = useState("");
  // Only used by the "file" branch, same reason.
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  if (field.type === "file") {
    const media = value as UploadedMedia | undefined;
    async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setUploading(true);
      setUploadError(null);
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch(field.uploadUrl ?? "/api/ads/upload-media", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        onChange(field.id, data as UploadedMedia);
      } catch (err) {
        setUploadError((err as Error).message);
      } finally {
        setUploading(false);
      }
    }
    return (
      <Wrapper field={field}>
        {media ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <div className="min-w-0">
              <p className="truncate font-medium">{media.filename}</p>
              <p className="text-xs text-zinc-500 capitalize">{media.mediaType} uploaded</p>
            </div>
            <button
              type="button"
              onClick={() => onChange(field.id, undefined)}
              className="shrink-0 text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              Remove
            </button>
          </div>
        ) : (
          <input
            type="file"
            accept={field.accept ?? "image/*,video/*"}
            disabled={uploading}
            onChange={handleFile}
            className="w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-3.5 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-[#383838] disabled:opacity-50 dark:file:bg-white dark:file:text-black dark:hover:file:bg-[#ccc]"
          />
        )}
        {uploading && <p className="mt-1.5 text-xs text-zinc-500">Uploading…</p>}
        {uploadError && <p className="mt-1.5 text-xs text-red-600">{uploadError}</p>}
      </Wrapper>
    );
  }

  if (field.type === "text" || field.type === "url") {
    return (
      <Wrapper field={field}>
        <input
          type={field.type === "url" ? "url" : "text"}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(field.id, e.target.value)}
          placeholder={field.placeholder ?? field.example}
          required={field.required}
          className={inputClass}
        />
      </Wrapper>
    );
  }

  if (field.type === "number") {
    return (
      <Wrapper field={field}>
        <input
          type="number"
          min={field.min}
          max={field.max}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(field.id, e.target.value)}
          placeholder={field.placeholder ?? field.example}
          required={field.required}
          className={inputClass}
        />
      </Wrapper>
    );
  }

  if (field.type === "date") {
    return (
      <Wrapper field={field}>
        <input
          type="date"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(field.id, e.target.value)}
          className={inputClass}
        />
      </Wrapper>
    );
  }

  if (field.type === "textarea") {
    return (
      <Wrapper field={field}>
        <textarea
          value={(value as string) ?? ""}
          onChange={(e) => onChange(field.id, e.target.value)}
          placeholder={field.placeholder ?? field.example}
          required={field.required}
          rows={3}
          className={inputClass}
        />
        {field.allowAI && (
          <button
            type="button"
            onClick={() => onChange(field.id, AI_DECIDE)}
            className="mt-1.5 text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Let AI write this for me
          </button>
        )}
      </Wrapper>
    );
  }

  if (field.type === "yesno") {
    return (
      <Wrapper field={field}>
        <div className="flex gap-2">
          {(["yes", "no"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange(field.id, v)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium capitalize ${
                value === v
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-black"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </Wrapper>
    );
  }

  if (field.type === "tags") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    function commit() {
      const v = draft.trim();
      if (v && !list.includes(v)) onChange(field.id, [...list, v]);
      setDraft("");
    }
    return (
      <Wrapper field={field}>
        <div className="flex flex-wrap gap-2 rounded-lg border border-zinc-200 p-2.5 focus-within:border-zinc-400 dark:border-zinc-800 dark:focus-within:border-zinc-600">
          {list.map((v) => (
            <span key={v} className="flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {v}
              <button type="button" onClick={() => onChange(field.id, list.filter((x) => x !== v))} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                ×
              </button>
            </span>
          ))}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
            placeholder="Type and press Enter"
            className="min-w-[140px] flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
          />
        </div>
      </Wrapper>
    );
  }

  // select / multiselect
  const options = resolveOptions(field, values);
  const isMulti = field.type === "multiselect";
  const selected: string[] = isMulti ? (Array.isArray(value) ? (value as string[]) : []) : value ? [value as string] : [];

  function toggle(v: string) {
    if (v === OTHER) {
      setShowCustom(true);
      return;
    }
    if (isMulti) {
      const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
      onChange(field.id, next);
    } else {
      onChange(field.id, v);
      setShowCustom(false);
    }
  }

  return (
    <Wrapper field={field}>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => toggle(o.value)}
            disabled={o.disabled}
            title={o.disabled ? "Not supported yet" : undefined}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
              o.disabled
                ? "cursor-not-allowed border-dashed border-zinc-200 text-zinc-400 opacity-60 dark:border-zinc-800"
                : selected.includes(o.value)
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-black"
                : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
            }`}
          >
            {o.label}
          </button>
        ))}
        {field.allowCustom && (
          <button
            type="button"
            onClick={() => toggle(OTHER)}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
              showCustom ? "border-zinc-900 dark:border-white" : "border-dashed border-zinc-300 text-zinc-500 dark:border-zinc-700"
            }`}
          >
            Other / enter your own
          </button>
        )}
        {field.allowAI && (
          <button
            type="button"
            onClick={() => toggle(AI_DECIDE)}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
              selected.includes(AI_DECIDE)
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-black"
                : "border-dashed border-zinc-300 text-zinc-500 dark:border-zinc-700"
            }`}
          >
            Not sure — let AI decide
          </button>
        )}
      </div>
      {(showCustom || selected.some((s) => s && !options.find((o) => o.value === s) && s !== AI_DECIDE && s !== NOT_SURE)) && (
        <input
          autoFocus
          placeholder="Enter your own…"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const v = (e.target as HTMLInputElement).value.trim();
              if (!v) return;
              if (isMulti) onChange(field.id, [...selected.filter((x) => x !== OTHER), v]);
              else onChange(field.id, v);
              (e.target as HTMLInputElement).value = "";
              setShowCustom(false);
            }
          }}
          className={`mt-2 ${inputClass}`}
        />
      )}
    </Wrapper>
  );
}
