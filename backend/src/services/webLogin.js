const puppeteer = require('puppeteer');

// Privy's OAuth2 login page (stg-oauth2.privypass.id and equivalents) is a
// client-rendered SPA whose login request body is encrypted in the browser
// (device fingerprinting + an obfuscated payload) — it cannot be replayed as
// a plain HTTP POST. A real headless browser is the only reliable way to
// drive it: type PrivyID, click Continue, type password, click Login, then
// read the session token back out of the cookie the app sets after the
// OAuth code/token exchange completes.
const TOKEN_COOKIE_NAME = 'oauth/token';
const NAV_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only a timeout/network hiccup is worth retrying — those are the ones that
// plausibly succeed a second time. Wrong credentials or a changed page
// layout will fail exactly the same way every time, so retrying those just
// burns 2 more of these ~30s attempts for nothing while the run sits there
// looking stuck.
function isRetryableLoginError(err) {
  return /timeout|net::ERR_/i.test(err.message);
}

function findButtonByText(page, text) {
  return page.evaluate((label) => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim().toLowerCase() === label);
    if (btn) { btn.click(); return true; }
    return false;
  }, text);
}

/**
 * Logs into a Privy OAuth2 login page with `cred.username` (PrivyID) and
 * `cred.password`, then returns the session token found in the
 * `oauth/token` cookie afterward. Throws with a descriptive message if the
 * login page's structure doesn't match what's expected, or the credentials
 * are rejected.
 */
async function fetchWebLoginToken(cred) {
  if (!cred.login_url) throw new Error('This credential has no Login URL configured.');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(cred.login_url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });

    await page.waitForSelector('input', { timeout: 15000 });
    await page.type('input', cred.username, { delay: 20 });
    if (!(await findButtonByText(page, 'continue'))) {
      throw new Error('Could not find the "Continue" button on the login page — its layout may have changed.');
    }

    await page.waitForSelector('input[type=password]', { timeout: 15000 }).catch(() => {
      throw new Error('Password field never appeared — PrivyID may be invalid, or the page layout changed.');
    });
    await page.type('input[type=password]', cred.password, { delay: 20 });
    if (!(await findButtonByText(page, 'login'))) {
      throw new Error('Could not find the "Login" button on the login page — its layout may have changed.');
    }

    await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20000 }).catch(() => {});

    const cookies = await page.cookies();
    const tokenCookie = cookies.find((c) => c.name === TOKEN_COOKIE_NAME);
    if (!tokenCookie) {
      const stillOnLoginPage = page.url().includes(new URL(cred.login_url).hostname);
      throw new Error(
        stillOnLoginPage
          ? 'Login did not complete — PrivyID/password were likely rejected.'
          : `Logged in, but no "${TOKEN_COOKIE_NAME}" cookie was found — the app may store the token differently now.`
      );
    }

    const expiresCookie = cookies.find((c) => c.name === 'oauth/expires');
    return { token: tokenCookie.value, expires: expiresCookie ? decodeURIComponent(expiresCookie.value) : null };
  } finally {
    await browser.close();
  }
}

// The real login (fetchWebLoginToken) takes ~15-20s since it's an actual
// headless browser session — too slow to pay on every single flow run when
// the JWT it returns is typically valid for ~24h. Cache per credential id
// and only log in again once the cached token is within REFRESH_MARGIN_MS of
// expiring (or was never fetched). In-memory only — resets on server
// restart, which just means the next run re-logs in, no worse than before.
const tokenCache = new Map(); // credential id -> { token, expiresAt }
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

// A single login attempt against the real site occasionally hits a plain
// timeout or network hiccup that a second try clears up on its own — one
// retry (not several) is enough to smooth that over without turning an
// already-broken login into a multi-minute wait before the run can even
// start on its actual steps.
const MAX_LOGIN_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;

// A Parallel Batch Run (or just two single runs landing close together) can
// have more than one caller ask for the SAME credential's token at once —
// without this, every one of them would see the same cache miss and each
// launch its own concurrent Puppeteer login for the same account, which is
// pure waste (only the first needed to actually log in) and risks the real
// login page rejecting/rate-limiting concurrent sessions for one account.
// Keyed by credential id -> the in-progress token Promise; later callers
// just await the same one instead of starting their own.
const inFlightLogins = new Map();

async function getWebLoginToken(cred) {
  const cached = tokenCache.get(cred.id);
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return cached.token;
  }

  const inFlight = inFlightLogins.get(cred.id);
  if (inFlight) return inFlight;

  const loginPromise = (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      try {
        const { token, expires } = await fetchWebLoginToken(cred);
        const expiresAt = expires ? Date.parse(expires) : NaN;
        tokenCache.set(cred.id, { token, expiresAt: Number.isNaN(expiresAt) ? Date.now() + 10 * 60 * 1000 : expiresAt });
        return token;
      } catch (err) {
        lastErr = err;
        console.error(`[webLogin] Login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS} for "${cred.name}" failed: ${err.message}`);
        if (attempt < MAX_LOGIN_ATTEMPTS && isRetryableLoginError(err)) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        break;
      }
    }
    throw lastErr;
  })();
  inFlightLogins.set(cred.id, loginPromise);

  try {
    return await loginPromise;
  } finally {
    inFlightLogins.delete(cred.id);
  }
}

// Lets a manual "Test Login" (always a real, uncached check) also prime the
// cache with its result, so the next real flow run doesn't pay for a second
// login right after someone just confirmed the credential works.
function primeTokenCache(credentialId, token, expires) {
  const expiresAt = expires ? Date.parse(expires) : NaN;
  tokenCache.set(credentialId, { token, expiresAt: Number.isNaN(expiresAt) ? Date.now() + 10 * 60 * 1000 : expiresAt });
}

// Called whenever a credential's username/password/login_url is edited or
// the credential itself is deleted — without this, a flow run would keep
// using the token from BEFORE the edit (still valid by expiry, just for the
// wrong account/page) until it happens to near-expire on its own.
function invalidateTokenCache(credentialId) {
  tokenCache.delete(credentialId);
}

module.exports = { fetchWebLoginToken, getWebLoginToken, primeTokenCache, invalidateTokenCache };
