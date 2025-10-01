// server.mjs — Blackbaud → Assignments → (optional) Drive links
import express from "express";
import { chromium } from "playwright";
import { google } from "googleapis";

/* ===================== ENV ===================== */
const SECRET      = (process.env.WEBHOOK_SECRET || "HOMEWORKNEVEREVER").trim();
const BB_BASE     = (process.env.BB_BASE || "").replace(/\/+$/, "");
const BB_USERNAME = process.env.BB_USERNAME || "";
const BB_PASSWORD = process.env.BB_PASSWORD || "";

// Selectors (can be overridden via Render env)
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
const GDRIVE_FOLDERID = process.env.GDRIVE_FOLDER_ID || "";

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

/* ===================== LOGIN + NAV ===================== */
async function loginBlackbaud(page) {
  // Try a few starting points
  const candidates = [
    `${BB_BASE}/signin`,
    `${BB_BASE}/app/login`,
    "https://app.blackbaud.com/signin",
    `${BB_BASE}/`
  ];
  for (const url of candidates) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); break; }
    catch {}
  }

  // (1) “Sierra Canyon School” SSO button
  const ssoBtn = page.getByRole('button', { name: /sierra canyon school/i })
                     .or(page.getByRole('link', { name: /sierra canyon school/i }));
  if (await ssoBtn.count()) {
    await Promise.all([page.waitForLoadState('domcontentloaded'), ssoBtn.click()]);
  }

  // (2) BBID email page
  const emailInput = page.getByRole('textbox', { name: /bbid.*email/i })
                         .or(page.locator('input[type="email"], input[name*="email"], #Username'));
  if (await emailInput.count()) {
    await emailInput.fill(BB_USERNAME);
    const nextBtn = page.getByRole('button', { name: /next|continue/i });
    if (await nextBtn.count()) {
      await Promise.all([page.waitForLoadState('domcontentloaded'), nextBtn.click()]);
    }
  }

 // (3a) Microsoft login flow
if (page.url().includes("login.microsoftonline.com")) {
  // Email (sometimes shown again)
  const msEmail = page.locator('input[type="email"]');
  if (await msEmail.count()) {
    await msEmail.fill(BB_USERNAME);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole('button', { name: /next/i }).click()
    ]);
  }

  // Password
  const msPass = page.locator('input[type="password"]');
  if (await msPass.count()) {
    await msPass.fill(BB_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole('button', { name: /^sign in$/i }).click()
    ]);
  }

  // --- Stay signed in? (KMSI) dialog ---
  // We handle both the text prompt and buttons; also tick "Don't show this again" if present.
  for (let i = 0; i < 3; i++) { // give it a few seconds to appear
    const kmsiText = page.getByText(/stay signed in\?|keep me signed in/i);
    if (await kmsiText.count()) {
      const dontShow = page.getByRole('checkbox', { name: /don't show this again/i });
      if (await dontShow.count()) { await dontShow.check().catch(() => {}); }

      const yesBtn = page.getByRole('button', { name: /^yes$/i });
      const okBtn  = page.getByRole('button', { name: /^ok$/i });
      const noBtn  = page.getByRole('button', { name: /^no$/i });

      if (await yesBtn.count()) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          yesBtn.click()
        ]);
      } else if (await okBtn.count()) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          okBtn.click()
        ]);
      } else if (await noBtn.count()) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          noBtn.click()
        ]);
      }
      break;
    }
    await page.waitForTimeout(1000);
  }
} else {
  // (3b) Native BB password page
  const pass = page.locator('input[type="password"], input[name*="password"]');
  if (await pass.count()) {
    await pass.fill(BB_PASSWORD);
    const signIn = page.getByRole('button', { name: /sign in|submit|log in/i });
    if (await signIn.count()) {
      await Promise.all([page.waitForLoadState('domcontentloaded'), signIn.click()]);
    }
  }
}

  // Ensure we’re inside the student app
  await page.waitForTimeout(1500);
  if (!/\/app\/student/i.test(page.url())) {
    await page.goto(`${BB_BASE}/app/student`, { waitUntil: "domcontentloaded" });
  }
}

async function openAssignmentCenter(page) {
  // Try direct hash first
  await page.goto(`${BB_BASE}/app/student#assignment-center`, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  // Give the SPA time to hydrate
  await page.waitForTimeout(1500);

  // Try to force List view 3 ways (tenants differ)
  const candidateListButtons = [
    ASSIGN_FORCE_LIST_BUTTON,                                         // from env
    '[aria-label="List view"]', '[aria-label="List"]',
    '[title="List"]', 'button[title*="List"]', 'button[aria-label*="List"]',
    '.bb-icon-list', '.fa-list', '[data-automation-id*="list-view"]',
    '[data-view="list"]', '[data-testid*="listView"]',
  ].filter(Boolean);

  for (const sel of candidateListButtons) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        await btn.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(800);
        break; // assume it worked
      }
    } catch {}
  }

  // If no links yet, use the My Day menu → Assignment Center path once
  let haveLinks = false;
  for (let i = 0; i < 8; i++) {
    const c = await page.locator(LIST_LINK_SELECTOR).count().catch(() => 0);
    if (c > 0) { haveLinks = true; break; }
    await page.waitForTimeout(500);
  }
  if (!haveLinks) {
    const myDay = page.getByRole('button', { name: /^my day$/i })
                      .or(page.getByRole('link', { name: /^my day$/i }));
    if (await myDay.count()) await myDay.first().click().catch(() => {});
    const ac = page.getByRole('menuitem', { name: /assignment center/i })
                   .or(page.getByRole('link', { name: /assignment center/i }))
                   .or(page.getByText(/assignment center/i));
    if (await ac.count()) await ac.first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  // Wait for the main container to exist (best-effort)
  const containerSel = LINK_CONTAINER_SELECTOR || 'main, [role="main"], #content';
  await page.waitForSelector(containerSel, { timeout: 60000 }).catch(() => {});
}


  // Wait for container + poll for links
  await page.waitForSelector(LINK_CONTAINER_SELECTOR, { timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const c = await page.locator(LIST_LINK_SELECTOR).count().catch(() => 0);
    if (c > 0) return;
    await page.waitForTimeout(1000);
  }
  throw new Error("No assignments found after navigating to Assignment Center.");
}

/* ===================== SCRAPE ===================== */
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

// Collect links on the page (try precise selector, then broaden if needed)
let links = [];
try {
  links = await page.$$eval(LIST_LINK_SELECTOR, (as) =>
    as.map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
  );
} catch {
  links = [];
}

if (!links || links.length === 0) {
  // Calendar cards & alt tenants sometimes put anchors in different wrappers
  const BROAD1 =
    'a[href*="/lms-assignment/assignment/assignment-student-view/"],' +
    'a[href*="/lms-assignment/assignment/"],' +
    'a[href*="/assignment-student-view/"],' +
    '[data-automation-id*="assignment"] a,' +
    '.fsAssignment a';

  try {
    links = await page.$$eval(BROAD1, (as) =>
      as.map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
    );
  } catch {
    links = [];
  }
}

if (!links || links.length === 0) {
  // Nuclear fallback: any anchor that contains "assignment"
  const BROAD2 = 'a[href*="assignment"], a[data-url*="assignment"]';
  try {
    links = await page.$$eval(BROAD2, (as) =>
      as.map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
    );
  } catch {
    links = [];
  }
}

const unique = (links || []).filter(
  (v, i, arr) => v.href && arr.findIndex((x) => x.href === v.href) === i
);

if (unique.length === 0) {
  throw new Error(
    `No assignments found after navigating to Assignment Center. url=${page.url()}`
  );
}


if (!links || links.length === 0) {
  // Calendar cards & alt tenants sometimes put the anchor inside various wrappers
  const BROAD1 =
    'a[href*="/lms-assignment/assignment/assignment-student-view/"],' +
    'a[href*="/lms-assignment/assignment/"],' +
    'a[href*="/assignment-student-view/"],' +
    '[data-automation-id*="assignment"] a,' +
    '.fsAssignment a';

  links = await page.$$eval(BROAD1, as =>
    as.map(a => ({ href: a.href, text: a.textContent?.trim() || "" }))
  ).catch(() => []);
}

if (!links || links.length === 0) {
  // Nuclear fallback: any anchor that contains "assignment"
  const BROAD2 = 'a[href*="assignment"], a[data-url*="assignment"]';
  links = await page.$$eval(BROAD2, as =>
    as.map(a => ({ href: a.href, text: a.textContent?.trim() || "" }))
  ).catch(() => []);
}

const unique = (links || []).filter((v, i, arr) =>
  v.href && arr.findIndex(x => x.href === v.href) === i
);

if (unique.length === 0) {
  // Provide a clearer error with the current URL for troubleshooting
  throw new Error(`No assignments found after navigating to Assignment Center. url=${page.url()}`);
}



    const assignments = [];
    for (const { href } of unique) {
      const detail = await context.newPage();
      try {
        await detail.goto(href, { waitUntil: "domcontentloaded", timeout: 120000 });
        await detail.waitForTimeout(500);

        const getText = async (sel) => {
          try { return ((await detail.locator(sel).first().textContent()) || "").trim(); }
          catch { return ""; }
        };

        const title       = await getText(DETAIL_TITLE_SELECTOR);
        const course      = await getText(DETAIL_COURSE_SELECTOR);
        const due         = await getText(DETAIL_DUE_SELECTOR);
        const description = await getText(DETAIL_DESC_SELECTOR);

        // Resources
        const resLoc = detail.locator(DETAIL_RES_ANCH_SEL);
        const rCount = await resLoc.count().catch(() => 0);
        const resources = [];

        for (let i = 0; i < rCount; i++) {
          const a = resLoc.nth(i);
          const label = ((await a.textContent().catch(() => "")) || "resource").trim();

          // Try to trigger a download; if no download, capture the href
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
            const href = await a.getAttribute("href");
            if (href) resources.push({ name: label, href, mimeType: "text/html" });
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
  // Be forgiving of casing/whitespace
  const provided = (req.get("X-Webhook-Secret") || req.get("x-webhook-secret") || "").trim();
  if (provided !== SECRET) {
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
