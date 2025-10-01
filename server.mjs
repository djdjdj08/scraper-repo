// server.mjs — Blackbaud Assignments Scraper (provider-aware SPA login + retries)
import express from "express";
import { chromium } from "playwright";
import { google } from "googleapis";

/* ============== ENV ============== */
const SECRET       = (process.env.WEBHOOK_SECRET || "HOMEWORKNEVEREVER").trim();
const BB_BASE      = (process.env.BB_BASE || "").replace(/\/+$/, "");
const BB_USERNAME  = process.env.BB_USERNAME || "";
const BB_PASSWORD  = process.env.BB_PASSWORD || "";

/** Choose which button to click on the SPA #login screen.
 *  microsoft | bbid | auto   (default: microsoft)
 */
const LOGIN_PROVIDER = (process.env.LOGIN_PROVIDER || "microsoft").toLowerCase();

/* Selectors (you can override via env if needed) */
const LINK_CONTAINER_SELECTOR =
  process.env.LINK_CONTAINER_SELECTOR ||
  "main, [role='main'], #content, .assignment-center, .fsAssignmentCenter";

const LIST_LINK_SELECTOR =
  process.env.LIST_LINK_SELECTOR ||
  "a[href*='/lms-assignment/assignment/assignment-student-view/']";

const DETAIL_TITLE_SELECTOR =
  process.env.DETAIL_TITLE_SELECTOR ||
  "h1, h2, .page-title, [data-automation-id='assignment-title']";

const DETAIL_COURSE_SELECTOR =
  process.env.DETAIL_COURSE_SELECTOR ||
  "[class*='class'], [data-automation-id*='course'], .assignment-class";

const DETAIL_DUE_SELECTOR =
  process.env.DETAIL_DUE_SELECTOR ||
  "[class*='due'], [data-automation-id*='due'], .assignment-due";

const DETAIL_DESC_SELECTOR =
  process.env.DETAIL_DESC_SELECTOR ||
  "[class*='description'], [id*='description'], [data-automation-id*='description']";

const DETAIL_RES_ANCH_SEL =
  process.env.DETAIL_RES_ANCH_SEL ||
  "a[download], a[href*='/download/'], a[href^='http']:not([href^='mailto:'])";

const ASSIGN_FORCE_LIST_BUTTON =
  process.env.ASSIGN_FORCE_LIST_BUTTON ||
  "[aria-label='List view'], [aria-label='List'], [title='List'], button[title*='List'], button[aria-label*='List'], [data-automation-id*='list-view'], [data-view='list']";

/* Optional Google Drive upload */
const SA_JSON          = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || "";

/* ============== Helpers ============== */
function logPhase(msg) { console.log(`[PHASE] ${msg}`); }

function driveClientOrNull() {
  try {
    if (!SA_JSON) return null;
    const creds = JSON.parse(SA_JSON);
    const jwt = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ["https://www.googleapis.com/auth/drive"]
    );
    return google.drive({ version: "v3", auth: jwt });
  } catch (e) {
    console.error("DRIVE_INIT_ERROR:", e?.message || e);
    return null;
  }
}

const streamToBuffer = (rs) => new Promise((resolve, reject) => {
  const chunks = [];
  rs.on("data", d => chunks.push(d));
  rs.on("end", () => resolve(Buffer.concat(chunks)));
  rs.on("error", reject);
});

async function uploadBufferToDrive(drive, name, buffer, mimeType = "application/octet-stream") {
  const create = await drive.files.create({
    requestBody: { name, parents: GDRIVE_FOLDER_ID ? [GDRIVE_FOLDER_ID] : undefined, mimeType },
    media: { mimeType, body: buffer }
  });
  const fileId = create.data.id;
  await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
  const meta = await drive.files.get({ fileId, fields: "name,mimeType,webViewLink,webContentLink" });
  return { id: fileId, name: meta.data.name, mimeType: meta.data.mimeType, href: meta.data.webViewLink || meta.data.webContentLink };
}

/* ============== SPA login helpers ============== */
async function clickSpaLogin(page) {
  // Order matters: try the explicit provider first
  const candidates = [];

  if (LOGIN_PROVIDER === "microsoft" || LOGIN_PROVIDER === "auto") {
    candidates.push(
      "button:has-text('Sign in with Microsoft')",
      "a:has-text('Sign in with Microsoft')",
      "button:has-text('Microsoft')",
      "a:has-text('Microsoft')"
    );
  }
  if (LOGIN_PROVIDER === "bbid" || LOGIN_PROVIDER === "auto") {
    candidates.push(
      "button:has-text('Sign in with Blackbaud ID')",
      "a:has-text('Sign in with Blackbaud ID')",
      "button:has-text('Blackbaud ID')",
      "a:has-text('Blackbaud ID')"
    );
  }

  // Generic fallbacks
  candidates.push(
    "button:has-text('Sign in')",
    "a:has-text('Sign in')",
    "button:has-text('Log in')",
    "a:has-text('Log in')",
    "[data-automation-id*='sign-in']",
    "[data-testid*='signin']"
  );

  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        logPhase(`SPA login control → ${sel}`);
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          el.click().catch(() => {})
        ]);
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {}
  }
  return false;
}

/* ============== Login Flow ============== */
async function doMicrosoft(page) {
  // Sometimes it asks email again
  const msEmail = page.locator("input[type='email']").first();
  if (await msEmail.count()) {
    logPhase("MS asks email");
    await msEmail.fill(BB_USERNAME);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole("button", { name: /next/i }).click()
    ]);
  }
  const msPass = page.locator("input[type='password']").first();
  if (await msPass.count()) {
    logPhase("MS fill password");
    await msPass.fill(BB_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole("button", { name: /^sign in$/i }).click()
    ]);
  }
  // Stay signed in dialog
  for (let i = 0; i < 5; i++) {
    const kmsi = page.getByText(/stay signed in\?|keep me signed in/i);
    if (await kmsi.count()) {
      logPhase("MS KMSI detected");
      const dontShow = page.getByRole("checkbox", { name: /don't show this again/i });
      if (await dontShow.count()) await dontShow.check().catch(() => {});
      const yes = page.getByRole("button", { name: /^yes$/i });
      const ok  = page.getByRole("button",  { name: /^ok$/i });
      const no  = page.getByRole("button",  { name: /^no$/i });
      const btn = (await yes.count()) ? yes : (await ok.count()) ? ok : (await no.count()) ? no : null;
      if (btn) {
        await Promise.all([page.waitForLoadState("domcontentloaded"), btn.click()]);
      }
      break;
    }
    await page.waitForTimeout(400);
  }
}

async function loginBlackbaud(page) {
  if (!BB_BASE || !BB_USERNAME || !BB_PASSWORD) {
    throw new Error("Missing env: BB_BASE, BB_USERNAME, BB_PASSWORD are required.");
  }

  // Use a stable UA to avoid odd A/B variants
  await page.context().setExtraHTTPHeaders({ "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36" });

  const startUrls = [
    `${BB_BASE}/app/student?svcid=edu#login`,
    `${BB_BASE}/app/student?svcid=edu`,
    `${BB_BASE}/signin`,
    `${BB_BASE}/app/login`,
    "https://app.blackbaud.com/signin",
    `${BB_BASE}/`
  ];

  logPhase("Open entry");
  for (const u of startUrls) {
    try { await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }); break; }
    catch {}
  }

  // If we are at SPA #login, click a provider button
  if (/#login\b/i.test(page.url())) {
    const clicked = await clickSpaLogin(page);
    if (clicked) await page.waitForTimeout(800);
  }

  // School SSO button (rare)
  const ssoBtn = page.getByRole("button", { name: /sierra canyon school/i })
                     .or(page.getByRole("link", { name: /sierra canyon school/i }));
  if (await ssoBtn.count()) {
    logPhase("Click school SSO");
    await Promise.all([page.waitForLoadState("domcontentloaded"), ssoBtn.click()]);
  }

  // BBID email page
  const emailInput = page.locator("input[type='email'], input[name*='email'], #Username, #bbid-email").first();
  if (await emailInput.count()) {
    logPhase("Fill BBID email");
    await emailInput.fill(BB_USERNAME);
    const nextBtn = page.getByRole("button", { name: /next|continue/i }).first();
    if (await nextBtn.count()) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        nextBtn.click()
      ]);
    }
  }

  // Branch on where we landed
  if (page.url().includes("login.microsoftonline.com")) {
    await doMicrosoft(page);
  } else {
    const pass = page.locator("input[type='password'], input[name*='password']").first();
    if (await pass.count()) {
      logPhase("Native BB password");
      await pass.fill(BB_PASSWORD);
      const signIn = page.getByRole("button", { name: /sign in|submit|log in/i }).first();
      if (await signIn.count()) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          signIn.click()
        ]);
      }
    }
  }

  // Land in student app
  await page.goto(`${BB_BASE}/app/student?svcid=edu`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // If still #login, try the SPA route once more
  if (/#login\b/i.test(page.url())) {
    logPhase("Retry SPA provider click");
    const clicked = await clickSpaLogin(page);
    if (clicked) {
      // Either go straight to MS or BBID now
      if (page.url().includes("login.microsoftonline.com")) {
        await doMicrosoft(page);
      } else {
        const email2 = page.locator("input[type='email'], input[name*='email'], #Username, #bbid-email").first();
        if (await email2.count()) {
          await email2.fill(BB_USERNAME);
          const next2 = page.getByRole("button", { name: /next|continue/i }).first();
          if (await next2.count()) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: "domcontentloaded" }),
              next2.click()
            ]);
          }
        }
      }
      await page.goto(`${BB_BASE}/app/student?svcid=edu`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);
    }
  }

  if (/#login\b/i.test(page.url())) {
    throw new Error(`Login failed; still at #login after retries. url=${page.url()}`);
  }
  logPhase("Login complete");
}

/* ============== Assignment Center ============== */
async function openAssignmentCenter(page) {
  logPhase("Open Assignment Center");
  await page.goto(`${BB_BASE}/app/student?svcid=edu#assignment-center`, {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });
  await page.waitForTimeout(1200);

  if (/#login\b/i.test(page.url())) {
    logPhase("Bounced to #login → re-login once");
    await loginBlackbaud(page);
    await page.goto(`${BB_BASE}/app/student?svcid=edu#assignment-center`, {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });
    await page.waitForTimeout(1200);
  }

  // Try to force list view
  const b = page.locator(ASSIGN_FORCE_LIST_BUTTON).first();
  if (await b.count()) {
    await b.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(700);
  }

  await page.waitForSelector(LINK_CONTAINER_SELECTOR, { timeout: 60000 }).catch(() => {});
}

/* ============== Scrape ============== */
async function scrapeAssignments() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const drive = driveClientOrNull();

  try {
    if (!BB_BASE || !BB_USERNAME || !BB_PASSWORD) {
      throw new Error("Missing env: BB_BASE, BB_USERNAME, BB_PASSWORD are required.");
    }

    await loginBlackbaud(page);
    await openAssignmentCenter(page);

    logPhase("Collect assignment links");
    let links = [];
    try {
      links = await page.$$eval(LIST_LINK_SELECTOR, as =>
        as.map(a => ({ href: a.href, text: (a.textContent || "").trim() }))
      );
    } catch { links = []; }

    if (!links || links.length === 0) {
      // broader sweep
      const BROAD =
        "a[href*='/lms-assignment/assignment/assignment-student-view/']," +
        "a[href*='/lms-assignment/assignment/']," +
        "a[href*='assignment-student-view']," +
        "[data-automation-id*='assignment'] a," +
        ".fsAssignment a," +
        "a[href*='assignment']";
      try {
        links = await page.$$eval(BROAD, as =>
          as.map(a => ({ href: a.href, text: (a.textContent || "").trim() }))
        );
      } catch { links = []; }
    }

    const uniqueLinks = (links || []).filter(
      (v, i, arr) => v.href && arr.findIndex(x => x.href === v.href) === i
    );

    if (uniqueLinks.length === 0) {
      throw new Error(`No assignments found after navigating to Assignment Center. url=${page.url()}`);
    }

    logPhase(`Found ${uniqueLinks.length} assignments`);
    const assignments = [];

    for (const { href } of uniqueLinks) {
      const detail = await context.newPage();
      try {
        await detail.goto(href, { waitUntil: "domcontentloaded", timeout: 120000 });
        await detail.waitForTimeout(400);

        const getText = async (sel) => {
          try { return ((await detail.locator(sel).first().textContent()) || "").trim(); }
          catch { return ""; }
        };

        const title       = await getText(DETAIL_TITLE_SELECTOR);
        const course      = await getText(DETAIL_COURSE_SELECTOR);
        const due         = await getText(DETAIL_DUE_SELECTOR);
        const description = await getText(DETAIL_DESC_SELECTOR);

        // Resources
        const resources = [];
        const resLoc = detail.locator(DETAIL_RES_ANCH_SEL);
        const rCount = await resLoc.count().catch(() => 0);

        for (let i = 0; i < rCount; i++) {
          const a = resLoc.nth(i);
          const label = ((await a.textContent().catch(() => "")) || "resource").trim();

          const [dl] = await Promise.all([
            detail.waitForEvent("download").catch(() => null),
            a.click().catch(() => null)
          ]);

          if (dl && drive) {
            const suggested = (await dl.suggestedFilename().catch(() => label)) || label;
            const rs = await dl.createReadStream();
            const buf = await streamToBuffer(rs);
            const uploaded = await uploadBufferToDrive(drive, suggested, buf);
            resources.push({ name: uploaded.name, href: uploaded.href, mimeType: uploaded.mimeType });
          } else {
            const href2 = await a.getAttribute("href");
            if (href2) resources.push({ name: label, href: href2, mimeType: "text/html" });
          }
        }

        assignments.push({ title, course, due, description, resources, url: href });
      } finally {
        await detail.close().catch(() => {});
      }
    }

    await browser.close().catch(() => {});
    return { scrapedAt: new Date().toISOString(), assignments };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

/* ============== HTTP ============== */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("OK"));

app.post("/scrape", async (req, res) => {
  const provided = (req.get("X-Webhook-Secret") || req.get("x-webhook-secret") || "").trim();
  if (provided !== SECRET) return res.status(401).json({ error: "unauthorized" });
  try {
    const data = await scrapeAssignments();
    res.json(data);
  } catch (err) {
    console.error("SCRAPE_ERROR:", err?.message || err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on " + port));
