export type FieldType =
  | "text"
  | "textarea"
  | "url"
  | "number"
  | "select"
  | "multiselect"
  | "tags"
  | "date"
  | "yesno";

export interface FieldOption {
  value: string;
  label: string;
  /** Shown but not selectable — the option exists in the UI but the backend can't deliver it yet. */
  disabled?: boolean;
}

export type FormValues = Record<string, unknown>;

export interface FieldConfig {
  id: string;
  label: string;
  /** Plain-English explanation shown under the label. */
  help: string;
  /** A realistic example value, shown as placeholder/hint text. */
  example?: string;
  type: FieldType;
  /** Static options, or a function that derives options from the rest of the form (dynamic options). */
  options?: FieldOption[] | ((values: FormValues) => FieldOption[]);
  /** Adds an "Other / enter your own" option that reveals a free-text input. */
  allowCustom?: boolean;
  /** Adds a "Not sure / Let AI decide" option. */
  allowAI?: boolean;
  required?: boolean;
  /** Only render this field when the predicate returns true. */
  showIf?: (values: FormValues) => boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  /** Render two fields side-by-side (used for from/to number ranges). */
  pairWith?: string;
}

export interface SectionConfig {
  id: string;
  title: string;
  intro?: string;
  fields: FieldConfig[];
  showIf?: (values: FormValues) => boolean;
}

export const AI_DECIDE = "__ai_decide__";
export const NOT_SURE = "__not_sure__";
export const OTHER = "__other__";

export function opts(pairs: [string, string][]): FieldOption[] {
  return pairs.map(([value, label]) => ({ value, label }));
}

export function sameOpts(labels: string[]): FieldOption[] {
  return labels.map((l) => ({ value: l, label: l }));
}

/** Like sameOpts, but marks `unsupported` labels as disabled "coming soon" options. */
export function sameOptsWithSoon(labels: string[], unsupported: string[]): FieldOption[] {
  return labels.map((l) => ({ value: l, label: unsupported.includes(l) ? `${l} (coming soon)` : l, disabled: unsupported.includes(l) }));
}
