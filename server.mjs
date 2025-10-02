// server.mjs — Blackbaud Assignments scraper with robust MS popup + KMSI handling
import express from "express";
import { chromium } from "playwright";
import { google } from "googleapis";

/* ===================== ENV ===================== */
const SECRET      = process.env.WEBHOOK_SECRET || "change-me";
const BB_BASE     = (process.env.BB_BASE || "").replace(/\/+$/, "");
const BB_USERNAME = process.env.BB_USERNAME || "";
const BB_PASSWORD = process.env.BB_PASSWORD || "";

// Force Microsoft flow for this school
const LOGIN_PROVIDER = (process.env.LOGIN_PROVIDER || "microsoft").toLowerCase();

// Selectors (overridable via env)
const LINK_CONTAINER_SELECTOR =
  process.env.LINK_CONTAINER_SELECTOR || '[role="main"], .main, #content, body';

const LIST_LINK_SELECTOR =
  process.env.LIST_LINK_SELECTOR
  || 'a[href*="/lms-assignment/assignment/assignment-student-view/"]';

const DETAIL_TITLE_SELECTOR =
  process.env.DETAIL_TITLE_SELECTOR
  || 'h1, h2, .page-title, [data-automation-id="assignment-title"]';

const DETAIL_COURSE_SELECTOR =
  process.env.DETAIL_COURSE_SELECTOR
  || '[class*="class"], [data-automation-id*="course"], .assignment-class';

const DETAIL_DUE_SELECTOR =
  process.env.DETAIL_DUE_SELECTOR
  || '[class*="due"], [data-automation-id*="due"], .assignment-due';

const DETAIL_DESC_SELECTOR =
  process.env.DETAIL_DESC_SELECTOR
  || '[class*="description"], [id*="description"], [data-automation-id*="description"]';

const DETAIL_RES_AREA_SEL =
  process.env.DETAIL_RES_AREA_SEL
  || 'section:has(:text("Links & downloads")), [class*="links"], [id*="links"]';

const DETAIL_RES_ANCH_SEL =
  process.env.DETAIL_RES_ANCH_SEL
  || `${DETAIL_RES_AREA_SEL} a, a[href*="/download/"], a[download]`;

const ASSIGN_FORCE_LIST_BUTTON =
  process.env.ASSIGN_FORCE_LIST_BUTTON
  || '[aria-label="List view"], [title*="List"], button:has(:text("List"))';

// Google Drive (optional)
const SA_JSON         = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const GDRIVE_FOLDERID = process.env.GOOGLE_FOLDER_ID || process.env.GDRIVE_FOLDER_ID || "";

/* ===================== DRIVE HELPERS ===================== */
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
const streamToBuffer = (rs) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    rs.on("data", d => chunks.push(d));
    rs.on("end", () => resolve(Buffer.concat(chunks)));
    rs.on("error", reject);
  });

async function uploadBufferToDrive(drive, name, buffer, mimeType = "application/octet-stream") {
  const create = await drive.files.create({
    requestBody: { name, parents: GDRIVE_FOLDERID ? [GDRIVE_FOLDERID] : undefined, mimeType },
    media: { mimeType, body: buffer }
  });
  const fileId = create.data.id;
  await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
  const meta = await drive.files.get({ fileId, fields: "name,mimeType,webViewLink,webContentLink" });
  return {
    id: fileId,
    name: meta.data.name,
    mimeType: meta.data.mimeType,
    href: meta.data.webViewLink || meta.data.webContentLink
  };
}

/* ===================== LOGIN HELPERS ===================== */
const isMsDomain  = (u) => /login\.microsoftonline\.com/i.test(u || "");
const onLoginHash = (u) => /#login\b/i.test(u || "");

async function waitForUrl(page, predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(page.url())) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function clickIfExists(page, locator) {
  try { if (await locator.count()) { await locator.first().click({ timeout: 5000 }).catch(() => {}); } }
  catch {}
}

// If MS opens in a popup, switch to it; otherwise keep current page
async function maybeSwitchToPopup(context, action) {
  let popupPromise = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
  await action();
  const p = await popupPromise;
  if (p) {
    try { await p.waitForLoadState("domcontentloaded", { timeout: 30000 }); } catch {}
    return p;
  }
  return null;
}

async function fillMicrosoftFlow(pageOrCtx) {
  // Accept either a Page or a BrowserContext (for popup handoff)
  let page = pageOrCtx.page ? pageOrCtx.page() : pageOrCtx;
  const context = page.context();

  // Email (sometimes repeated)
  if (isMsDomain(page.url())) {
    const box = page.locator('input[type="email"]');
    if (await box.count()) {
      await box.fill(BB_USERNAME);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: /next/i }).click()
      ]);
    }
  }

  // Password screen — your screenshot
  if (isMsDomain(page.url())) {
    const pass = page.locator('input[type="password"]');
    if (await pass.count()) {
      await pass.fill(BB_PASSWORD);

      // Sometimes the click opens a popup (rare); handle both
      const popped = await maybeSwitchToPopup(context, async () => {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
          page.getByRole("button", { name: /^sign in$/i }).click()
        ]);
      });

      if (popped) page = popped;
    }
  }

  // KMSI “Stay signed in?”
  for (let i = 0; i < 6; i++) {
    const kmsiText = page.getByText(/stay signed in\?/i);
    if (await kmsiText.count()) {
      const dontShow = page.getByRole("checkbox", { name: /don't show this again/i });
      if (await dontShow.count()) { await dontShow.check().catch(() => {}); }

      const yesBtn = page.getByRole("button", { name: /^yes$/i });
      const okBtn  = page.getByRole("button", { name: /^ok$/i });
      const noBtn  = page.getByRole("button", { name: /^no$/i });

      if (await yesBtn.count()) {
        await Promise.all([page.waitForLoadState("domcontentloaded"), yesBtn.click()]);
      } else if (await okBtn.count()) {
        await Promise.all([page.waitForLoadState("domcontentloaded"), okBtn.click()]);
      } else if (await noBtn.count()) {
        await Promise.all([page.waitForLoadState("domcontentloaded"), noBtn.click()]);
      }
      break;
    }
    await page.waitForTimeout(800);
  }

  return page;
}

async function startAtEntry(page) {
  const entries = [
    `${BB_BASE}/app/student?svcid=edu#login`,
    `${BB_BASE}/signin`,
    `${BB_BASE}/app/login`,
    "https://app.blackbaud.com/signin"
  ];
  for (const url of entries) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch {}
  }
}

async function tryKickToMicrosoft(page) {
  // Buttons/links that commonly lead to MS
  const ssoBtn = page.getByRole("button", { name: /sierra canyon school/i })
                .or(page.getByRole("link", { name: /sierra canyon school/i }));
  await clickIfExists(page, ssoBtn);

  // Backup: generic “Sign in with Microsoft” text/button if it appears
  const msAlt = page.getByRole("button", { name: /microsoft|office 365/i })
               .or(page.getByText(/sign in.*microsoft|office 365/i));
  await clickIfExists(page, msAlt);
}

async function loginBlackbaud(context) {
  const page = await context.newPage();

  // Enter through a login location
  await startAtEntry(page);

  // If we’re immediately on MS, do the flow
  if (isMsDomain(page.url())) {
    await fillMicrosoftFlow(page);
  } else {
    // We are on Blackbaud — try to push to MS; capture popup if it opens
    let popup = await maybeSwitchToPopup(context, async () => { await tryKickToMicrosoft(page); });
    const msPage = popup || (isMsDomain(page.url()) ? page : null);
    if (msPage) {
      await fillMicrosoftFlow(msPage);
    } else if (LOGIN_PROVIDER !== "microsoft") {
      // As a fallback, native BBID (rare for your school)
      const emailInput = page.getByRole('textbox', { name: /bbid.*email/i })
                             .or(page.locator('input[type="email"], input[name*="email"], #Username'));
      if (await emailInput.count()) {
        await emailInput.fill(BB_USERNAME);
        const nextBtn = page.getByRole('button', { name: /next|continue/i });
        if (await nextBtn.count()) {
          await Promise.all([page.waitForLoadState('domcontentloaded'), nextBtn.click()]);
        }
      }
      const pass = page.locator('input[type="password"], input[name*="password"]');
      if (await pass.count()) {
        await pass.fill(BB_PASSWORD);
        const signIn = page.getByRole('button', { name: /sign in|submit|log in/i });
        if (await signIn.count()) {
          await Promise.all([page.waitForLoadState('domcontentloaded'), signIn.click()]);
        }
      }
    }
  }

  // If we’re stuck on #login, try reloading without the hash
  if (onLoginHash(page.url())) {
    const noHash = page.url().replace(/#login\b/, "");
    try { await page.goto(noHash, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch {}
  }

  // One more kick at MS if we are still on a BB login surface
  if (onLoginHash(page.url())) {
    await tryKickToMicrosoft(page);
    if (isMsDomain(page.url())) {
      await fillMicrosoftFlow(page);
    } else {
      // Sometimes the click opened a popup and we missed it; poll for any MS pages
      const pages = context.pages();
      const ms = pages.find(p => isMsDomain(p.url()));
      if (ms) await fillMicrosoftFlow(ms);
    }
  }

  // Require that we’ve escaped #login
  const ok = await waitForUrl(page, (u) => !onLoginHash(u), 15000);
  if (!ok) throw new Error(`Login failed; still at #login after retries. url=${page.url()}`);

  // Land on student app
  if (!/\/app\/student/i.test(page.url())) {
    await page.goto(`${BB_BASE}/app/student`, { waitUntil: "domcontentloaded" });
  }

  return page; // return the logged-in Page
}

/* ===================== NAVIGATE + SCRAPE ===================== */
async function openAssignmentCenter(page) {
  // Go directly
  await page.goto(`${BB_BASE}/app/student#assignment-center`, { waitUntil: "domcontentloaded", timeout: 120000 });

  // Force List view so anchors render
  const listBtn = page.locator(ASSIGN_FORCE_LIST_BUTTON);
  if (await listBtn.count()) { await listBtn.first().click().catch(() => {}); await page.waitForTimeout(800); }

  // Poll for anchors
  for (let i = 0; i < 20; i++) {
    const c = await page.locator(LIST_LINK_SELECTOR).count().catch(() => 0);
    if (c > 0) return;

    // Try My Day ▸ Assignment Center once
    if (i === 6) {
      const myDay = page.getByRole('button', { name: /^my day$/i }).or(page.getByRole('link', { name: /^my day$/i }));
      await clickIfExists(page, myDay);
      const ac = page.getByRole('menuitem', { name: /assignment center/i })
                     .or(page.getByRole('link', { name: /assignment center/i }))
                     .or(page.getByText(/assignment center/i));
      await clickIfExists(page, ac);
    }

    await page.waitForTimeout(800);
  }

  // Last-chance: scan all anchors and filter
  const found = await page.$$eval('a[href]', as =>
    as.map(a => a.href).filter(h => /\/lms-assignment\/assignment\/assignment-student-view\//.test(h))
  ).catch(() => []);
  if (found && found.length) return;

  throw new Error(`No assignments found after navigating to Assignment Center. url=${page.url()}`);
}

async function scrapeAssignments() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  });
  const drive = driveClientOrNull();

  let page;
  try {
    if (!BB_BASE || !BB_USERNAME || !BB_PASSWORD) {
      throw new Error("Missing env: BB_BASE, BB_USERNAME, BB_PASSWORD are required.");
    }

    page = await loginBlackbaud(context);
    await openAssignmentCenter(page);

    // Collect unique detail links
    const links = await page.$$eval(LIST_LINK_SELECTOR, as =>
      as.map(a => ({ href: a.href, text: (a.textContent || "").trim() }))
    ).catch(() => []);

    const unique = (links || []).filter((v, i, arr) =>
      arr.findIndex(x => x.href === v.href) === i
    );

    const assignments = [];
    for (const { href } of unique) {
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

        // Resources: try download → Drive; else keep href
        const resLoc = detail.locator(DETAIL_RES_ANCH_SEL);
        const rCount = await resLoc.count().catch(() => 0);
        const resources = [];

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
            const href2 = await a.getAttribute("href").catch(() => null);
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

/* ===================== HTTP SERVER ===================== */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("OK"));

app.post("/scrape", async (req, res) => {
  if (req.header("X-Webhook-Secret") !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
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
