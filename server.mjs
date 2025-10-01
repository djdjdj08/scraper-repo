// server.mjs — Blackbaud Assignments Scraper (n8n-friendly)
// - Auth via BBID and/or Microsoft (handles KMSI + #login bounce)
// - Navigates to Assignment Center (forces List view)
// - Scrapes each assignment's detail page (title, course, due, description)
// - Collects resources (links, downloads) with optional Google Drive upload

import express from "express";
import { chromium } from "playwright";
import { google } from "googleapis";

/* ===================== ENV ===================== */
const SECRET       = (process.env.WEBHOOK_SECRET || "HOMEWORKNEVEREVER").trim();
const BB_BASE      = (process.env.BB_BASE || "").replace(/\/+$/, "");
const BB_USERNAME  = process.env.BB_USERNAME || "";
const BB_PASSWORD  = process.env.BB_PASSWORD || "";

// You can override any of these selectors from Render → Environment
const LINK_CONTAINER_SELECTOR =
  process.env.LINK_CONTAINER_SELECTOR ||
  "main, [role='main'], #content, .assignment-center, .lms-assignment, .fsAssignmentCenter, .fsCalendar, .bb-calendar";

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

// Keep resource selector simple & robust (no :text or complex :has)
const DETAIL_RES_ANCH_SEL =
  process.env.DETAIL_RES_ANCH_SEL ||
  "a[download], a[href*='/download/'], a[href^='http']:not([href^='mailto:'])";

const ASSIGN_FORCE_LIST_BUTTON =
  process.env.ASSIGN_FORCE_LIST_BUTTON ||
  "[aria-label='List view'], [aria-label='List'], [title='List'], [title*='List'], button[aria-label*='List'], button[title*='List'], .bb-icon-list, .fa-list, [data-automation-id*='list-view'], [data-view='list'], [data-testid*='listView']";

// Optional Google Drive upload
const SA_JSON          = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const GDRIVE_FOLDER_ID = process.env.GOOGLE_SERVICE_ACCOUNT_FOLDER_ID || process.env.GDRIVE_FOLDER_ID || "";

/* ===================== Helpers: Google Drive ===================== */
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
    requestBody: {
      name,
      parents: GDRIVE_FOLDER_ID ? [GDRIVE_FOLDER_ID] : undefined,
      mimeType
    },
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

/* ===================== Auth Flow ===================== */
async function loginBlackbaud(page) {
  if (!BB_BASE || !BB_USERNAME || !BB_PASSWORD) {
    throw new Error("Missing env: BB_BASE, BB_USERNAME, BB_PASSWORD are required.");
  }

  // Try a few starting points to land in an auth-able state
  const candidates = [
    `${BB_BASE}/signin`,
    `${BB_BASE}/app/login`,
    "https://app.blackbaud.com/signin",
    `${BB_BASE}/`
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      break;
    } catch { /* keep trying */ }
  }

  // School-specific SSO button (if shown)
  const ssoBtn = page
    .getByRole("button", { name: /sierra canyon school/i })
    .or(page.getByRole("link", { name: /sierra canyon school/i }));
  if (await ssoBtn.count()) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      ssoBtn.click()
    ]);
  }

  // BBID email screen
  const emailInput = page
    .getByRole("textbox", { name: /bbid.*email/i })
    .or(page.locator("input[type='email'], input[name*='email'], #Username"));
  if (await emailInput.count()) {
    await emailInput.fill(BB_USERNAME);
    const nextBtn = page.getByRole("button", { name: /next|continue/i });
    if (await nextBtn.count()) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        nextBtn.click()
      ]);
    }
  }

  if (page.url().includes("login.microsoftonline.com")) {
    // Microsoft email (sometimes re-asked)
    const msEmail = page.locator("input[type='email']");
    if (await msEmail.count()) {
      await msEmail.fill(BB_USERNAME);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: /next/i }).click()
      ]);
    }

    // Microsoft password
    const msPass = page.locator("input[type='password']");
    if (await msPass.count()) {
      await msPass.fill(BB_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: /^sign in$/i }).click()
      ]);
    }

    // KMSI dialog
    for (let i = 0; i < 3; i++) {
      const kmsiText = page.getByText(/stay signed in\?|keep me signed in/i);
      if (await kmsiText.count()) {
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
      await page.waitForTimeout(800);
    }
  } else {
    // Native Blackbaud password page
    const pass = page.locator("input[type='password'], input[name*='password']");
    if (await pass.count()) {
      await pass.fill(BB_PASSWORD);
      const signIn = page.getByRole("button", { name: /sign in|submit|log in/i });
      if (await signIn.count()) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          signIn.click()
        ]);
      }
    }
  }

  // Ensure Student app is open; if we see #login, drive the sign-in again
  await page.waitForTimeout(1200);
  if (!/\/app\/student/i.test(page.url())) {
    await page.goto(`${BB_BASE}/app/student`, { waitUntil: "domcontentloaded" });
  }

  for (let tries = 0; tries < 2; tries++) {
    if (!/#login\b/i.test(page.url())) break;

    // Try a visible "Sign in" control inside SPA
    const signInBtn = page
      .getByRole("button", { name: /sign in|log in/i })
      .or(page.getByRole("link", { name: /sign in|log in/i }))
      .or(page.getByText(/^sign in$/i));

    if (await signInBtn.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded"),
        signInBtn.first().click().catch(() => {})
      ]);
      await page.waitForTimeout(1000);
    } else {
      // Re-run BBID flow
      await page.goto("https://app.blackbaud.com/signin", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
      const email2 = page.locator("input[type='email'], input[name*='email'], #Username");
      if (await email2.count()) {
        await email2.fill(BB_USERNAME);
        const next2 = page.getByRole("button", { name: /next|continue/i });
        if (await next2.count()) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded" }),
            next2.click()
          ]);
        }
      }
      if (page.url().includes("login.microsoftonline.com")) {
        const msPass2 = page.locator("input[type='password']");
        if (await msPass2.count()) {
          await msPass2.fill(BB_PASSWORD);
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded" }),
            page.getByRole("button", { name: /^sign in$/i }).click()
          ]);
        }
        for (let k = 0; k < 3; k++) {
          const kmsiText = page.getByText(/stay signed in\?|keep me signed in/i);
          if (await kmsiText.count()) {
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
          await page.waitForTimeout(800);
        }
      } else {
        const pass2 = page.locator("input[type='password'], input[name*='password']");
        if (await pass2.count()) {
          await pass2.fill(BB_PASSWORD);
          const sign2 = page.getByRole("button", { name: /sign in|submit|log in/i });
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
}

/* ===================== Assignment Center ===================== */
async function openAssignmentCenter(page) {
  // Go to Assignment Center
  await page.goto(`${BB_BASE}/app/student#assignment-center`, {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });
  await page.waitForTimeout(1000);

  // If SPA bounced to #login, re-login once
  if (/#login\b/i.test(page.url())) {
    await loginBlackbaud(page);
    await page.goto(`${BB_BASE}/app/student#assignment-center`, {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });
    await page.waitForTimeout(1000);
  }

  // Try to force List view (various tenants differ)
  const listCandidates = [
    ASSIGN_FORCE_LIST_BUTTON,
    "[aria-label='List view']",
    "[aria-label='List']",
    "[title='List']",
    "button[title*='List']",
    "button[aria-label*='List']",
    ".bb-icon-list",
    ".fa-list",
    "[data-automation-id*='list-view']",
    "[data-view='list']",
    "[data-testid*='listView']"
  ].filter(Boolean);

  for (const sel of listCandidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        await btn.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(600);
        break;
      }
    } catch { /* continue */ }
  }

  // Wait for container presence (best effort)
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

    // Try specific selector, then broaden progressively
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

    // Visit each assignment detail
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

          // Try to download, else just capture href
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
