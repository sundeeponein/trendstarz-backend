// After every deploy: is the live site answering the way it should? Read-only —
// GET requests and requests without a login only; nothing is created or changed.
//
// Usage (from trendstarz-backend/):
//   node cron/smokeTest.js
//   SMOKE_SITE=https://trendstarz.in SMOKE_API=https://…/api node cron/smokeTest.js
//
// What it checks:
// - site pages load (200);
// - public API endpoints answer 200;
// - endpoints that need a login answer 401 without one — a 403 or 500 there means a
//   guard is missing or broken (2026-10-26: a missing guard answered 403 to everyone).
// Exit code 1 if anything fails.

const axios = require('axios');

const SITE = (process.env.SMOKE_SITE || 'https://trendstarz.in').replace(/\/$/, '');
const API = (process.env.SMOKE_API || 'https://trendstarz-backend-production.up.railway.app/api').replace(/\/$/, '');
const SOME_ID = '000000000000000000000000';

const CHECKS = [
  // Site pages
  ['GET', `${SITE}/`, 200],
  ['GET', `${SITE}/login`, 200],
  ['GET', `${SITE}/search`, 200],
  ['GET', `${SITE}/privacy-policy`, 200],
  ['GET', `${SITE}/terms-and-conditions`, 200],
  // Public API (health = API + database answer)
  ['GET', `${API}/health`, 200],
  ['GET', `${API}/users/platform-stats`, 200],
  ['GET', `${API}/users/featured-profiles`, 200],
  ['GET', `${API}/users/influencers?limit=1`, 200],
  ['GET', `${API}/plans`, 200],
  // Needs a login: must be 401, never 403/500
  ['GET', `${API}/users/${SOME_ID}/profile-visibility`, 401],
  ['GET', `${API}/users/me/data-export`, 401],
  ['GET', `${API}/users/influencer-profile`, 401],
  ['GET', `${API}/notifications`, 401],
  ['GET', `${API}/campaign-transactions/my/history`, 401],
  // Admin only: must be 401 without a login
  ['GET', `${API}/admin/data-integrity`, 401],
  ['GET', `${API}/admin/influencers`, 401],
  ['GET', `${API}/admin/users/${SOME_ID}/actions`, 401],
];

// Security headers the website must send (vercel.json).
const HEADERS = [
  [`${SITE}/`, 'x-frame-options', 'DENY'],
  [`${SITE}/`, 'x-content-type-options', 'nosniff'],
  [`${SITE}/`, 'referrer-policy', 'strict-origin-when-cross-origin'],
  [`${SITE}/`, 'strict-transport-security', 'max-age='],
];

async function checkHeaders() {
  let failed = 0;
  for (const [url, name, want] of HEADERS) {
    let got = '';
    try {
      const res = await axios.get(url, { timeout: 20000, validateStatus: () => true });
      got = String(res.headers[name] || '');
    } catch {
      got = '';
    }
    const ok = got.includes(want);
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} header ${name}: ${got || '(missing)'}${ok ? '' : `  (expected ${want})`}`);
  }
  return failed;
}

async function run(checks = CHECKS) {
  let failed = 0;
  for (const [method, url, expected] of checks) {
    const started = Date.now();
    let status;
    try {
      const res = await axios.request({ method, url, timeout: 20000, validateStatus: () => true, maxRedirects: 3 });
      status = res.status;
    } catch (err) {
      status = err.code || 'error';
    }
    const ms = Date.now() - started;
    const ok = status === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(status).padEnd(5)} ${String(ms).padStart(5)}ms  ${method} ${url.replace(API, 'API').replace(SITE, 'SITE')}${ok ? '' : `  (expected ${expected})`}`);
  }
  failed += await checkHeaders();
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  return failed;
}

module.exports = { run, CHECKS };

if (require.main === module) {
  run().then((failed) => process.exit(failed ? 1 : 0));
}
