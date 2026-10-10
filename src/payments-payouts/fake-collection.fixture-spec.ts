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
          case "$lte":
            return (
              actual != null &&
              new Date(actual).getTime() <= new Date(v).getTime()
            );
          case "$gte":
            return (
              actual != null &&
              new Date(actual).getTime() >= new Date(v).getTime()
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
}

/** Chainable query result (select/lean/sort/limit return itself; awaitable). */
function query(value: () => any) {
  const q: any = {};
  for (const m of ["select", "lean", "sort", "limit", "populate", "exec"]) {
    q[m] = () => q;
  }
  q.then = (res: any, rej: any) => Promise.resolve().then(value).then(res, rej);
  q.catch = (rej: any) => Promise.resolve().then(value).catch(rej);
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

  updateOne = jest.fn((filter: any, update: any) =>
    query(() => {
      const doc = this.docs.find((d) => matches(d, filter));
      if (doc) applyUpdate(doc, update);
      return { acknowledged: true, modifiedCount: doc ? 1 : 0 };
    }),
  );
}
