import * as fs from "fs";
import * as path from "path";

/**
 * Every app page a notification or email links to must exist in the frontend
 * router (a missing one silently lands on the homepage). Collects "/page"
 * literals used as url/link values in backend code and checks them against
 * frontend/src/app/app.routes.ts.
 */
describe("notification and email links point to real pages", () => {
  const frontendRoutes = path.resolve(__dirname, "../../../trendstarz-frontend/src/app/app.routes.ts");
  const run = fs.existsSync(frontendRoutes) ? it : it.skip;

  run("no link to a page the frontend doesn't have", () => {
    const routes = [...fs.readFileSync(frontendRoutes, "utf8").matchAll(/path:\s*'([^']*)'/g)].map((m) => m[1]);
    // A fixed link must be a fixed page: "/brand/campaigns" matching
    // "brand/:brandName" would open the profile of a brand called "campaigns".
    const fixedPages = new Set(
      routes.filter((r) => r && r !== "**" && !r.includes(":")).flatMap((r) => [r, `admin/${r}`]),
    );
    // A link ending in "/" continues with an id (`/admin/campaigns/${id}`): it must
    // start a parameterised page.
    const paramPrefixes = routes
      .filter((r) => r.includes(":"))
      .flatMap((r) => {
        const prefix = r.slice(0, r.indexOf(":"));
        return [prefix, `admin/${prefix}`];
      });
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".spec.ts")) files.push(p);
      }
    };
    walk(path.resolve(__dirname, ".."));
    const missing = new Set<string>();
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:url|link|Path|Url)\s*[:=]\s*["'`](\/[a-z][a-z0-9/-]*)/gi)) {
        const raw = m[1].replace(/^\//, "");
        if (raw.startsWith("api/") || raw.startsWith("assets/")) continue;
        const ok = raw.endsWith("/") ? paramPrefixes.includes(raw) : fixedPages.has(raw);
        if (!ok) missing.add(`${m[1]}  (${path.relative(path.resolve(__dirname, ".."), f)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
