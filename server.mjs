// server.mjs
import express from "express";
import { chromium } from "playwright";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ----------------------------- ENV CONFIG ----------------------------- */
// Required
const SECRET      = process.env.WEBHOOK_SECRET || "change-me";
const BB_USERNAME = process.env.BB_USERNAME;
const BB_PASSWORD = process.env.BB_PASSWORD;
const BB_BASE     = (process.env.BB_BASE || "").trim().replace(/\/+$/, ""); // no trailing slash

// URLs (override if your school uses different paths)
const LOGIN_URL  = process.env.BB_LOGIN_URL  || `${BB_BASE}/app/login`;
const ASSIGN_URL = process.env.BB_ASSIGN_URL || `${BB_BASE}/app/student#assignment-center`;

// Selectors (override via env if your DOM differs)
const LIST_LINK_SELECTOR     = process.env.LIST_LINK_SELECTOR     || 'a[href*="Assignment"], a[href*="assignment"]';
const DETAIL_TITLE_SELECTOR  = process.env.DETAIL_TITLE_SELECTOR  || "h1, .assignment-title, .detail-title";
const DETAIL_COURSE_SELECTOR = process.env.DETAIL_COURSE_SELECTOR || ".assignment-course, .detail-course";
const DETAIL_DUE_SELECTOR    = process.env.DETAIL_DUE_SELECTOR    || ".assignment-due, .detail-due";
const DETAIL_DESC_SELECTOR   = process.env.DETAIL_DESC_SELECTOR   || ".assignment-description, .detail-description";
const DETAIL_RES_AREA_SEL    = process.env.DETAIL_RES_AREA_SEL    || ".assignment-resources, .detail-resources";
const DETAIL_RES_ANCH_SEL    = process.env.DETAIL_RES_ANCH_SEL    || `${DETAIL_RES_AREA_SEL} a, a.resource-link`;

// Google Drive (optional – enables public links for attachments)
const SA_JSON         = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // paste full JSON in Render env
const GDRIVE_FOLDERID = process.env.GDRIVE_FOLDER_ID || null;

/* --------------------------- HELPERS (Drive) -------------------------- */
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

function streamToBuffer(rs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    rs.on("data", d => chunks.push(d));
    rs.on("end", () => resolve(Buffer.concat(chunks)));
    rs.on("error", reject);
  });
}

/* --------------------------- SCRAPE ENDPOINT -------------------------- */
app.post("/scrape", async (req, res) => {
  if (req.header("X-Webhook-Secret") !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!BB_USERNAME || !BB_PASSWORD || !BB_BASE) {
    return res.status(400).json({ error: "missing required env (BB_USERNAME, BB_PASSWORD, BB_BASE)" });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    // -------- Login flow --------
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    if (await page.locator('input[name="username"]').count()) {
      await page.fill('input[name="username"]', BB_USERNAME);
      await page.fill('input[name="password"]', BB_PASSWORD);
      await Promise.all([
        page.waitForLoadState("networkidle"),
        page.click('button[type="submit"]')
      ]);
    } else {
      // SSO path (adjust if your page text differs)
      const ssoBtn = page.locator("text=Sign in with SSO");
      if (await ssoBtn.count()) {
        await Promise.all([
          page.waitForLoadState("networkidle"),
          ssoBtn.click()
        ]);
      }
    }

    // -------- Assignment list --------
    await page.goto(ASSIGN_URL, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1200); // give SPA time to render

    const listLinks = page.locator(LIST_LINK_SELECTOR);
    const listCount = await listLinks.count();
    const drive = driveClientOrNull();
    const assignments = [];

    for (let i = 0; i < listCount; i++) {
      const link = listLinks.nth(i);

      // Open in a new tab so we keep the list page intact
      const [detailPage] = await Promise.all([
        context.waitForEvent("page"),
        link.click()
      ]);

      try {
        await detailPage.waitForLoadState("networkidle", { timeout: 60000 });
        await detailPage.waitForTimeout(500);

        const getText = async (sel) =>
          ((await detailPage.locator(sel).first().textContent().catch(() => "")) || "").trim();

        const title       = await getText(DETAIL_TITLE_SELECTOR);
        const course      = await getText(DETAIL_COURSE_SELECTOR);
        const due         = await getText(DETAIL_DUE_SELECTOR);
        const description = await getText(DETAIL_DESC_SELECTOR);

        // Resources/attachments
        const resAnchors = detailPage.locator(DETAIL_RES_ANCH_SEL);
        const rCount = await resAnchors.count();
        const resources = [];

        for (let r = 0; r < rCount; r++) {
          const a = resAnchors.nth(r);
          const linkText = ((await a.textContent().catch(() => "")) || "resource").trim();

          // Click and see if a file download starts
          const [dl] = await Promise.all([
            detailPage.waitForEvent("download").catch(() => null),
            a.click()
          ]);

          if (dl && drive) {
            // Upload downloaded file to Drive -> return public link
            const suggested = (await dl.suggestedFilename().catch(() => linkText)) || linkText;
            const rs = await dl.createReadStream();
            const buf = await streamToBuffer(rs);
            const uploaded = await uploadBufferToDrive(drive, suggested, buf);
            resources.push({ name: uploaded.name, href: uploaded.href, mimeType: uploaded.mimeType });
          } else {
            // Not a real file download (or Drive not configured) -> just keep href
            const href = await a.getAttribute("href");
            if (href) resources.push({ name: linkText, href, mimeType: "text/html" });
          }
        }

        assignments.push({ title, course, due, description, resources });
      } finally {
        await detailPage.close().catch(() => {});
      }
    }

    await browser.close().catch(() => {});
    return res.json({ scrapedAt: new Date().toISOString(), assignments });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("SCRAPE_ERROR:", err?.message || err);
    return res.status(500).json({ error: String(err) });
  }
});

/* --------------------------- HEALTH CHECK ----------------------------- */
app.get("/", (_req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on " + port));
