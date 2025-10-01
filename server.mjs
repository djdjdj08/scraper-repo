// server.mjs — Blackbaud Assignments Scraper (handles SPA #login + BBID + Microsoft)
// n8n-friendly HTTP endpoint with X-Webhook-Secret

import express from "express";
import { chromium } from "playwright";
import { google } from "googleapis";

/* ===================== ENV ===================== */
const SECRET       = (process.env.WEBHOOK_SECRET || "HOMEWORKNEVEREVER").trim();
const BB_BASE      = (process.env.BB_BASE || "").replace(/\/+$/, "");
const BB_USERNAME  = process.env.BB_USERNAME || "";
const BB_PASSWORD  = process.env.BB_PASSWORD || "";

// Selectors (override via env if needed)
const LINK_CONTAINER_SELECTOR =
  process.env.LINK_CONTAINER_SELECTOR ||
  "main, [role='main'], #content, .assignment-center, .fsAssignmentCenter, .bb-calendar";

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

// Simplified resource targets (avoid :has/:text to keep compatibility)
const DETAIL_RES_ANCH_SEL =
  process.env.DETAIL_RES_ANCH_SEL ||
  "a[download], a[href*='/download/'], a[href^='http']:not([href^='mailto:'])";

const ASSIGN_FORCE_LIST_BUTTON =
  process.env.ASSIGN_FORCE_LIST_BUTTON ||
  "[aria-label='List view'], [aria-label='List'], [title='List'], button[title*='List'], button[aria-label*='List'], [data-automation-id*='list-view'], [data-view='list'], [data-testid*='listView']";

// Optional Google Drive upload
const SA_JSON          = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || process.env.GOOGLE_SERVICE_ACCOUNT_FOLDER_ID || "";

/* ===================== Helpers ===================== */
function logPhase(msg) {
  console.log(`[PHASE] ${msg}`);
}

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
    rs.on("data", (d) => chunks.push(d));
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
  return {
    id: fileId,
    name: meta.data.name,
    mimeType: meta.data.mimeType,
    href: meta.data.webViewLink || meta.data.webContentLink
  };
}

/* ===================== Login Flow ===================== */
/**
 * Clicks a visible Sign in / SSO button inside the SPA #login screen if present.
 */
async function clickSpaLoginIfPresent(page) {
  const candidates = [
    // Common SPA login UI bits
    "button:has-text('Sign in')",
    "a:has-text('Sign in')",
    "button:has-text('Log in')",
    "a:has-text('Log in')",
    "button:has-text('Sign in with')",
    "a:has-text('Sign in with')",
    "[data-automation-id*='sign-in']",
    "[data-testid*='signin']",
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        logPhase(`SPA login control found: ${sel}`);
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          el.click().catch(() => {})
        ]);
        await page.waitForTimeout(800);
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Full BBID + Microsoft flow with retries.
 */
async function loginBlackbaud(page) {
  if (!BB_BASE || !BB_USERNAME || !BB_PASSWORD) {
    throw new Error("Missing env: BB_BASE, BB_USERNAME, BB_PASSWORD are required.");
  }

  logPhase("Open entry page");
  const candidates = [
    `${BB_BASE}/signin`,
    `${BB_BASE}/app/login`,
    `${BB_BASE}/app/student`,
    "https://app.blackbaud.com/signin",
    `${BB_BASE}/`
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      break;
    } catch {}
  }

  // If SPA shows #login immediately, attempt to click its Sign in button
  if (/#login\b/i.test(page.url())) {
    logPhase(`SPA shows #login at ${page.url()}`);
    const clicked = await clickSpaLoginIfPresent(page);
    if (clicked) {
      await page.waitForTimeout(800);
    }
  }

  // Handle school SSO button (e.g., "Sierra Canyon School")
  const ssoBtn = page.getByRole("button", { name: /sierra canyon school/i })
                     .or(page.getByRole("link", { name: /sierra canyon school/i }));
  if (await ssoBtn.count()) {
    logPhase("Click school SSO button");
    await Promise.all([page.waitForLoadState("domcontentloaded"), ssoBtn.click()]);
  }

  // BBID email screen (app.blackbaud.com)
  const emailInput = page
    .locator("input[type='email'], input[name*='email'], #Username, #bbid-email")
    .first();
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

  // Microsoft flow
  if (page.url().includes("login.microsoftonline.com")) {
    // Sometimes they re-ask email
    const msEmail = page.locator("input[type='email']").first();
    if (await msEmail.count()) {
      logPhase("MS asks email again");
      await msEmail.fill(BB_USERNAME);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: /next/i }).click()
      ]);
    }

    // MS password
    const msPass = page.locator("input[type='password']").first();
    if (await msPass.count()) {
      logPhase("MS fill password");
      await msPass.fill(BB_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: /^sign in$/i }).click()
      ]);
    }

    // Stay signed in (KMSI)
    for (let i = 0; i < 5; i++) {
      const kmsiText = page.getByText(/stay signed in\?|keep me signed in/i);
      if (await kmsiText.count()) {
        logPhase("MS KMSI detected");
        const dontShow = page.getByRole("checkbox", { name: /don't show this again/i });
        if (await dontShow.count()) await dontShow.check().catch(() => {});
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
      await page.waitForTimeout(500);
    }
  } else {
    // Native Blackbaud password page
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
  logPhase("Ensure /app/student loads");
  await page.goto(`${BB_BASE}/app/student`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // If we still see #login, try one more SPA click and/or re-run BBID
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!/#login\b/i.test(page.url())) break;
    logPhase(`Still at #login (attempt ${attempt}) → try SPA button`);
    const clicked = await clickSpaLoginIfPresent(page);
    if (!clicked) {
      logPhase("SPA had no button → go directly to BBID signin");
      await page.goto("https://app.blackbaud.com/signin", { waitUntil: "domcontentloaded" });
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
      if (page.url().includes("login.microsoftonline.com")) {
        const msPass2 = page.locator("input[type='password']").first();
        if (await msPass2.count()) {
          await msPass2.fill(BB_PASSWORD);
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded" }),
            page.getByRole("button", { name: /^sign in$/i }).click()
          ]);
        }
        for (let k = 0; k < 4; k++) {
          const kmsi = page.getByText(/stay signed in\?|keep me signed in/i);
          if (await kmsi.count()) {
            const dontShow = page.getByRole("checkbox", { name: /don't show this again/i });
            if (await dontShow.count()) await dontShow.check().catch(() => {});
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
          await page.waitForTimeout(500);
        }
      } else {
        const pass2 = page.locator("input[type='password'], input[name*='password']").first();
        if (await pass2.count()) {
          await pass2.fill(BB_PASSWORD);
          const sign2 = page.getByRole("button", { name: /sign in|submit|log in/i }).first();
          if (await sign2.count()) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: "domcontentloaded" }),
              sign2.click()
            ]);
          }
        }
      }
    }
    await page.goto(`${BB_BASE}/app/student`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
  }

  if (/#login\b/i.test(page.url())) {
    throw new Error(`Login failed; still at #login after retries. url=${page.url()}`);
  }

  logPhase("Login complete");
}

/* ===================== Assignment Center ===================== */
async function openAssignmentCenter(page) {
  logPhase("Open Assignment Center");
  await page.goto(`${BB_BASE}/app/student#assignment-center`, {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });
  await page.waitForTimeout(1000);

  // If SPA redirected back to #login (session not established), re-login once
  if (/#login\b/i.test(page.url())) {
    logPhase("Assignment Center bounced to #login → re-login once");
    await loginBlackbaud(page);
    await page.goto(`${BB_BASE}/app/student#assignment-center`, {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });
    await page.waitForTimeout(1200);
  }

  // Force "List view" if possible
  const listBtns = [
    ASSIGN_FORCE_LIST_BUTTON,
    "[aria-label='List view']",
    "[aria-label='List']",
    "[title='List']",
    "button[title*='List']",
    "button[aria-label*='List']",
    "[data-automation-id*='list-view']",
    "[data-view='list']",
    "[data-testid*='listView']"
  ].filter(Boolean);

  for (const sel of listBtns) {
    try {
      const b = page.locator(sel).first();
      if (await b.count()) {
        logPhase(`Click list view button: ${sel}`);
        await b.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(700);
        break;
      }
    } catch {}
  }

  // Wait for container to present
  await page.waitForSelector(LINK_CONTAINER_SELECTOR, { timeout: 60000 }).catch(() => {});
}

/* ===================== Scrape ===================== */
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

    logPhase("Collect list of assignments");
    let links = [];
    try {
      links = await page.$$eval(LIST_LINK_SELECTOR, (as) =>
        as.map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
      );
    } catch { links = []; }

    if (!links || links.length === 0) {
      const BROAD1 =
        "a[href*='/lms-assignment/assignment/assignment-student-view/']," +
        "a[href*='/lms-assignment/assignment/']," +
        "a[href*='/assignment-student-view/']," +
        "[data-automation-id*='assignment'] a," +
        ".fsAssignment a";
      try {
        links = await page.$$eval(BROAD1, (as) =>
          as.map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
        );
      } catch { links = []; }
    }

    if (!links || links.length === 0) {
      const BROAD2 = "a[href*='assignment'], a[data-url*='assignment']";
      try {
        links = await page.$$eval(BROAD2, (as) =>
          as.map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
        );
      } catch { links = []; }
    }

    const uniqueLinks = (links || []).filter(
      (v, i, arr) => v.href && arr.findIndex((x) => x.href === v.href) === i
    );

    if (uniqueLinks.length === 0) {
      throw new Error(`No assignments found after navigating to Assignment Center. url=${page.url()}`);
    }

    logPhase(`Found ${uniqueLinks.length} assignment links`);

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

        // Collect resources
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
    logPhase("Scrape complete");
    return { scrapedAt: new Date().toISOString(), assignments };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

/* ===================== HTTP Server ===================== */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("OK"));

app.post("/scrape", async (req, res) => {
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
