/**
 * In-memory stand-in for the Supabase client, used by the simulated-pipeline tests. It implements only the query
 * surface the sending code uses (select/insert/update/delete/upsert with eq/neq/gt/gte/lt/lte/in/is/not/like,
 * order, limit, single/maybeSingle, returns, head+count). Anything else throws, so a test can never pass by
 * silently ignoring a filter the real code relies on.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
type Result = { data: unknown; error: { message: string } | null; count?: number | null };

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
const isNil = (v: unknown) => v === null || v === undefined;

function likeToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${esc}$`, "s");
}

class Query implements PromiseLike<Result> {
  private mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private limitN: number | null = null;
  private returning = false;
  private head = false;
  private wantCount = false;
  private singleMode: "single" | "maybe" | null = null;
  private payload: Row | Row[] | null = null;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};

  private db: FakeDb;
  private table: string;
  constructor(db: FakeDb, table: string) { this.db = db; this.table = table; }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === "select") {
      this.head = Boolean(opts?.head);
      this.wantCount = Boolean(opts?.count);
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(rows: Row | Row[]) { this.mode = "insert"; this.payload = rows; return this; }
  update(patch: Row) { this.mode = "update"; this.payload = patch; return this; }
  delete() { this.mode = "delete"; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.mode = "upsert"; this.payload = rows; this.upsertOpts = opts ?? {}; return this;
  }

  eq(col: string, v: unknown) { this.filters.push((r) => !isNil(r[col]) && r[col] === v); return this; }
  neq(col: string, v: unknown) { this.filters.push((r) => isNil(r[col]) || r[col] !== v); return this; }
  gt(col: string, v: unknown) { this.filters.push((r) => !isNil(r[col]) && (r[col] as never) > (v as never)); return this; }
  gte(col: string, v: unknown) { this.filters.push((r) => !isNil(r[col]) && (r[col] as never) >= (v as never)); return this; }
  lt(col: string, v: unknown) { this.filters.push((r) => !isNil(r[col]) && (r[col] as never) < (v as never)); return this; }
  lte(col: string, v: unknown) { this.filters.push((r) => !isNil(r[col]) && (r[col] as never) <= (v as never)); return this; }
  in(col: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  ilike(col: string, pat: string) { this.filters.push((r) => typeof r[col] === "string" && new RegExp(likeToRegExp(pat).source, "is").test(r[col])); return this; }
  /** PostgREST `or`, e.g. "a.is.null,a.lte.2026-01-01": a row passes when ANY clause does. */
  or(expr: string) {
    const clauses = expr.split(",").map((c) => { const [col, op, ...rest] = c.split("."); return { col, op, val: rest.join(".") }; });
    this.filters.push((r) => clauses.some(({ col, op, val }) => {
      const x = r[col];
      if (op === "is") return val === "null" ? isNil(x) : String(x) === val;
      if (isNil(x)) return false;
      if (op === "eq") return String(x) === val;
      if (op === "lte") return String(x) <= val;
      if (op === "lt") return String(x) < val;
      if (op === "gte") return String(x) >= val;
      if (op === "gt") return String(x) > val;
      throw new Error(`FakeDb: unsupported or() operator ${op}`);
    }));
    return this;
  }
  like(col: string, pat: string) { this.filters.push((r) => typeof r[col] === "string" && likeToRegExp(pat).test(r[col])); return this; }
  is(col: string, v: null | boolean) {
    this.filters.push((r) => (v === null ? isNil(r[col]) : r[col] === v));
    return this;
  }
  not(col: string, op: string, v: unknown) {
    if (op === "is") this.filters.push((r) => (v === null ? !isNil(r[col]) : r[col] !== v));
    else if (op === "like") this.filters.push((r) => !(typeof r[col] === "string" && likeToRegExp(String(v)).test(r[col])));
    else if (op === "eq") this.filters.push((r) => r[col] !== v);
    else throw new Error(`FakeDb: unsupported not(${op})`);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  returns() { return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }

  // `.single()` after insert/select
  singleRow() { this.singleMode = "single"; return this; }

  then<R1 = Result, R2 = never>(
    onFulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.run()).then(onFulfilled, onRejected);
  }

  private matching(): Row[] {
    const rows = this.db.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
    for (const { col, asc } of [...this.orders].reverse()) {
      rows.sort((a, b) => {
        const x = a[col], y = b[col];
        if (isNil(x) && isNil(y)) return 0;
        if (isNil(x)) return 1;
        if (isNil(y)) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    return rows;
  }

  private shape(rows: Row[]): Result {
    const out = rows.map(clone);
    if (this.singleMode) {
      if (this.singleMode === "single" && out.length !== 1) return { data: null, error: { message: `expected 1 row, got ${out.length}` } };
      return { data: out[0] ?? null, error: null };
    }
    return { data: out, error: null };
  }

  private run(): Result {
    switch (this.mode) {
      case "select": {
        let rows = this.matching();
        const count = rows.length;
        if (this.limitN !== null) rows = rows.slice(0, this.limitN);
        if (this.head) return { data: null, error: null, count: this.wantCount ? count : null };
        const res = this.shape(rows);
        if (this.wantCount) res.count = count;
        return res;
      }
      case "insert": {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        // Unique constraints the real tables have (so "already processed" paths behave like Postgres: error 23505).
        const ucol = this.db.unique.get(this.table);
        if (ucol && list.some((r) => this.db.rows(this.table).some((e) => e[ucol] === r[ucol]))) {
          return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } } as unknown as Result;
        }
        const inserted = list.map((r) => this.db.insertRow(this.table, r));
        return this.returning ? this.shape(inserted) : { data: null, error: null };
      }
      case "update": {
        const rows = this.matching();
        // PostgREST drops undefined fields from the JSON body, so they never overwrite a column.
        const patch = Object.fromEntries(Object.entries(this.payload as Row).filter(([, v]) => v !== undefined));
        for (const r of rows) Object.assign(r, clone(patch));
        return this.returning ? this.shape(rows) : { data: null, error: null };
      }
      case "delete": {
        const rows = this.matching();
        this.db.remove(this.table, rows);
        return { data: null, error: null };
      }
      case "upsert": {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        const keys = (this.upsertOpts.onConflict ?? "id").split(",").map((k) => k.trim());
        const touched: Row[] = [];
        for (const r of list) {
          const existing = this.db.rows(this.table).find((e) => keys.every((k) => e[k] === r[k]));
          if (existing) {
            if (!this.upsertOpts.ignoreDuplicates) Object.assign(existing, clone(r));
            touched.push(existing);
          } else touched.push(this.db.insertRow(this.table, r));
        }
        return this.returning ? this.shape(touched) : { data: null, error: null };
      }
    }
  }
}

// Supabase's builder exposes `.single()` as a method; alias it without clashing with the private field name.
(Query.prototype as unknown as { single: () => Query }).single = function (this: Query) { return this.singleRow(); };

export class FakeDb {
  private tables = new Map<string, Row[]>();
  /** Test hook: make the next N inserts into a table fail (simulates a database error). */
  failInsertsInto = new Map<string, number>();
  /** table -> unique column; a second insert of the same value returns Postgres error 23505. */
  unique = new Map<string, string>([["processed_provider_events", "id"], ["processed_inbound_messages", "message_id"]]);

  rows(table: string): Row[] {
    let t = this.tables.get(table);
    if (!t) { t = []; this.tables.set(table, t); }
    return t;
  }
  insertRow(table: string, row: Row): Row {
    const left = this.failInsertsInto.get(table) ?? 0;
    if (left > 0) { this.failInsertsInto.set(table, left - 1); throw new Error(`simulated database failure inserting into ${table}`); }
    const r: Row = { ...clone(row) };
    if (r.id === undefined) r.id = crypto.randomUUID();
    // Database defaults the real tables have.
    if (table === "outreach_log" && r.sent_at === undefined) r.sent_at = new Date().toISOString();
    if (r.created_at === undefined) r.created_at = new Date().toISOString();
    this.rows(table).push(r);
    return r;
  }
  remove(table: string, rows: Row[]) {
    const t = this.rows(table);
    for (const r of rows) { const i = t.indexOf(r); if (i >= 0) t.splice(i, 1); }
  }
  from(table: string) { return new Query(this, table); }
  /** Direct read for assertions (copy). */
  all(table: string): Row[] { return this.rows(table).map(clone); }
  clear() { this.tables.clear(); this.failInsertsInto.clear(); }
}
