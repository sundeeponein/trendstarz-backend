/**
 * Tiny in-memory stand-in for a Mongoose model, for tests that need guarded updates to
 * really apply (refund / payout races). Supports the operators the refund code uses:
 * equality, $in, $nin, $ne, $lte, $gte, $or, dot paths; updates $set, $push, $unset.
 * Excluded from the build (name ends in "spec.ts") and not a test suite itself.
 */
function getPath(doc: any, path: string): any {
  return path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
}

function setPath(doc: any, path: string, value: any) {
  const keys = path.split(".");
  let cur = doc;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function unsetPath(doc: any, path: string) {
  const keys = path.split(".");
  const parent = keys
    .slice(0, -1)
    .reduce((v, k) => (v == null ? undefined : v[k]), doc);
  if (parent) delete parent[keys[keys.length - 1]];
}

const same = (a: any, b: any) =>
  a instanceof Date || b instanceof Date
    ? new Date(a).getTime() === new Date(b).getTime()
    : String(a) === String(b) && (a == null) === (b == null);

function matchValue(actual: any, cond: any): boolean {
  if (
    cond &&
    typeof cond === "object" &&
    !(cond instanceof Date) &&
    !Array.isArray(cond)
  ) {
    const ops = Object.keys(cond);
    if (ops.some((o) => o.startsWith("$"))) {
      return ops.every((op) => {
        const v = cond[op];
        switch (op) {
          case "$in":
            return v.some((x: any) =>
              x == null ? actual == null : same(actual, x),
            );
          case "$nin":
            return !v.some((x: any) =>
              x == null ? actual == null : same(actual, x),
            );
          case "$ne":
            return v == null ? actual != null : !same(actual, v);
          case "$lt":
            return (
              actual != null &&
              new Date(actual).getTime() < new Date(v).getTime()
            );
          case "$lte":
            return (
              actual != null &&
              new Date(actual).getTime() <= new Date(v).getTime()
            );
          case "$gt":
            return (
              actual != null &&
              (typeof v === "number"
                ? Number(actual) > v
                : new Date(actual).getTime() > new Date(v).getTime())
            );
          case "$gte":
            return (
              actual != null &&
              (typeof v === "number"
                ? Number(actual) >= v
                : new Date(actual).getTime() >= new Date(v).getTime())
            );
          default:
            throw new Error(`fake-collection: unsupported operator ${op}`);
        }
      });
    }
  }
  if (cond == null) return actual == null;
  return same(actual, cond);
}

export function matches(doc: any, filter: any): boolean {
  return Object.entries(filter || {}).every(([key, cond]) => {
    if (key === "$or") return (cond as any[]).some((f) => matches(doc, f));
    if (key === "$and") return (cond as any[]).every((f) => matches(doc, f));
    return matchValue(getPath(doc, key), cond);
  });
}

function applyUpdate(doc: any, update: any) {
  for (const [path, value] of Object.entries(update.$set || {})) {
    setPath(doc, path, value);
  }
  for (const [path, value] of Object.entries(update.$push || {})) {
    const list = getPath(doc, path) || [];
    list.push(value);
    setPath(doc, path, list);
  }
  for (const path of Object.keys(update.$unset || {})) unsetPath(doc, path);
  for (const [path, value] of Object.entries(update.$inc || {})) {
    setPath(doc, path, Number(getPath(doc, path) || 0) + Number(value));
  }
}

/** Chainable query result (select/lean/limit return itself; sort applies; awaitable). */
function query(value: () => any) {
  const q: any = {};
  let sortSpec: Record<string, number> | null = null;
  let limitN: number | null = null;
  for (const m of ["select", "lean", "populate", "exec"]) {
    q[m] = () => q;
  }
  q.sort = (spec: Record<string, number>) => {
    sortSpec = spec;
    return q;
  };
  q.limit = (n: number) => {
    limitN = n;
    return q;
  };
  const run = () => {
    let out = value();
    if (Array.isArray(out) && sortSpec) {
      const [[key, dir]] = Object.entries(sortSpec);
      out = [...out].sort((a, b) => {
        const av = getPath(a, key);
        const bv = getPath(b, key);
        const an =
          av instanceof Date || typeof av === "string"
            ? new Date(av).getTime()
            : Number(av);
        const bn =
          bv instanceof Date || typeof bv === "string"
            ? new Date(bv).getTime()
            : Number(bv);
        return (an - bn) * (dir < 0 ? -1 : 1);
      });
    }
    if (Array.isArray(out) && limitN != null) out = out.slice(0, limitN);
    return out;
  };
  q.then = (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
  q.catch = (rej: any) => Promise.resolve().then(run).catch(rej);
  return q;
}

const clone = (d: any) => (d == null ? d : structuredClone(d));

export class FakeCollection {
  docs: any[] = [];
  /** Runs just before findOneAndUpdate matches — used to simulate a concurrent writer. */
  beforeFindOneAndUpdate: ((filter: any) => void) | null = null;

  constructor(docs: any[] = []) {
    this.docs = docs.map((d) => structuredClone(d));
  }

  get(id: any) {
    return this.docs.find((d) => String(d._id) === String(id));
  }

  find = jest.fn((filter: any = {}) =>
    query(() => this.docs.filter((d) => matches(d, filter)).map(clone)),
  );

  findOne = jest.fn((filter: any = {}) =>
    query(() => clone(this.docs.find((d) => matches(d, filter)) ?? null)),
  );

  findById = jest.fn((id: any) => query(() => clone(this.get(id) ?? null)));

  private seq = 0;

  create = jest.fn((data: any) => {
    const doc = {
      _id: data?._id ?? `auto${++this.seq}`,
      createdAt: new Date(),
      ...structuredClone(data),
    };
    this.docs.push(doc);
    return Promise.resolve(clone(doc));
  });

  countDocuments = jest.fn((filter: any = {}) =>
    query(() => this.docs.filter((d) => matches(d, filter)).length),
  );

  findOneAndUpdate = jest.fn((filter: any, update: any, opts: any = {}) =>
    query(() => {
      this.beforeFindOneAndUpdate?.(filter);
      const doc = this.docs.find((d) => matches(d, filter));
      if (!doc) return null;
      const before = clone(doc);
      applyUpdate(doc, update);
      return opts?.new === false ? before : clone(doc);
    }),
  );

  updateMany = jest.fn((filter: any, update: any) =>
    query(() => {
      const hit = this.docs.filter((d) => matches(d, filter));
      hit.forEach((d) => applyUpdate(d, update));
      return { acknowledged: true, modifiedCount: hit.length };
    }),
  );

  updateOne = jest.fn((filter: any, update: any, opts: any = {}) =>
    query(() => {
      let doc = this.docs.find((d) => matches(d, filter));
      if (!doc && opts?.upsert) {
        // Like Mongo: equality fields of the filter + $setOnInsert, then the update.
        doc = { _id: `upsert${this.docs.length + 1}` };
        for (const [k, v] of Object.entries(filter || {})) {
          if (!k.startsWith("$") && (v == null || typeof v !== "object")) {
            setPath(doc, k, v);
          }
        }
        applyUpdate(doc, { $set: update.$setOnInsert || {} });
        this.docs.push(doc);
      }
      if (doc) applyUpdate(doc, update);
      return {
        acknowledged: true,
        matchedCount: doc ? 1 : 0,
        modifiedCount: doc ? 1 : 0,
      };
    }),
  );
}
