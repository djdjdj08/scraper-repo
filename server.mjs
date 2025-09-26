import express from 'express';
import { chromium } from 'playwright';
import { google } from 'googleapis';

const app = express();
app.use(express.json({ limit: '1mb' }));

/* =======================
   ENV
   ======================= */
const SECRET       = process.env.WEBHOOK_SECRET || 'change-me';
const BB_USERNAME  = process.env.BB_USERNAME;
const BB_PASSWORD  = process.env.BB_PASSWORD;

// Point this to YOUR assignments tab URL/hash
const BASE         = process.env.BB_BASE || 'https://<your-subdomain>.myschoolapp.com/';
const LOGIN_URL    = process.env.BB_LOGIN_URL || BASE + 'app/login';
const ASSIGN_URL   = process.env.BB_ASSIGN_URL || BASE + 'app/student#assignment-center';

/* If your school’s DOM classes are different, override via env: */
const LIST_LINK_SEL   = process.env.LIST_LINK_SELECTOR   || 'a[href*="Assignment"], a[href*="assignment"]';
const DETAIL_TITLE    = process.env.DETAIL_TITLE_SELECTOR|| 'h1, .assignment-title, .detail-title';
const DETAIL_COURSE   = process.env.DETAIL_COURSE_SELECTOR|| '.assignment-course, .detail-course';
const DETAIL_DUE      = process.env.DETAIL_DUE_SELECTOR  || '.assignment-due, .detail-due';
const DETAIL_DESC     = process.env.DETAIL_DESC_SELECTOR || '.assignment-description, .detail-description';
const DETAIL_RES_AREA = process.env.DETAIL_RES_AREA_SEL  || '.assignment-resources, .detail-resources';
const DETAIL_RES_ANCH = process.env.DETAIL_RES_ANCH_SEL  || `${DETAIL_RES_AREA} a, a.resource-link`;

/* Google Drive (optional but recommended for attachments) */
const SA_JSON      = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // paste full JSON in Render env
const DRIVE_FOLDER = process.env.GDRIVE_FOLDER_ID || null;

function driveClientOrNull() {
  try {
    if (!SA_JSON) return null;
    const creds = JSON.parse(SA_JSON);
    const jwt = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ['https://www.googleapis.com/auth/drive']
    );
    return google.drive({ version: 'v3', auth: jwt });
  } catch {
    return null;
  }
}

async function driveUploadBuffer(drive, name, buffer, mimeType = 'application/octet-stream') {
  const res = await drive.files.create({
    requestBody: { name, parents: DRIVE_FOLDER ? [DRIVE_FOLDER] : undefined, mimeType },
    media: { mimeType, body: Buffer.from(buffer) }
  });
  const fileId = res.data.id;
  await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
  const { data } = await drive.files.get({ fileId, fields: 'webViewLink,webContentLink,mimeType,name' });
  return { id: fileId, href: data.webViewLink || data.webContentLink, mimeType: data.mimeType, name: data.name };
}

/* =======================
   SCRAPE ENDPOINT
   ======================= */
app.post('/scrape', async (req, res) => {
  try {
    if (req.header('X-Webhook-Secret') !== SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const browser = await chromium.launch(); // headless on Render
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    // ----- LOGIN -----
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    // Typical username/password flow
    if (await page.locator('input[name="username"]').count()) {
      await page.fill('input[name="username"]', BB_USERNAME);
      await page.fill('input[name="password"]', BB_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle');
    } else {
      // SSO button (adjust if your portal shows a different label)
      const ssoBtn = page.locator('text=Sign in with SSO');
      if (await ssoBtn.count()) {
        await ssoBtn.click();
        await page.waitForLoadState('networkidle');
        // If MFA prompts, you may need to extend this once you see the page
      }
    }

    // ----- ASSIGNMENT LIST (tab) -----
    await page.goto(ASSIGN_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500); // give SPA time to render

    // Grab ALL assignment links in the list
    const listLinks = page.locator(LIST_LINK_SEL);
    const listCount = await listLinks.count();

    const drive = driveClientOrNull();
    const assignments = [];

    for (let i = 0; i < listCount; i++) {
      const link = listLinks.nth(i);

      // Open each assignment in a NEW TAB so we don't lose the list
      const [detailPage] = await Promise.all([
        context.waitForEvent('page'),
        link.click()
      ]);

      await detailPage.waitForLoadState('networkidle');
      await detailPage.waitForTimeout(800);

      // ---- scrape detail fields ----
      const getText = async (sel) =>
        ((await detailPage.locator(sel).first().textContent().catch(() => '')) || '').trim();

      const title       = await getText(DETAIL_TITLE);
      const course      = await getText(DETAIL_COURSE);
      const due         = await getText(DETAIL_DUE);
      const description = await getText(DETAIL_DESC);

      // ---- resources / attachments ----
      const resAnchors = detailPage.locator(DETAIL_RES_ANCH);
      const rCount = await resAnchors.count();
      const resources = [];

      for (let r = 0; r < rCount; r++) {
        const a = resAnchors.nth(r);
        const name = ((await a.textContent().catch(() => '')) || 'resource').trim();

        // Try to click and capture a download
        const [dl] = await Promise.all([
          detailPage.waitForEvent('download').catch(() => null),
          a.click()
        ]);

        if (dl && drive) {
          // Upload downloaded file to Drive to get a public link
          const suggested = await dl.suggestedFilename().catch(() => name);
          const buffer = await dl.createReadStream().then(rs => new Promise((resolve, reject) => {
            const chunks = [];
            rs.on('data', d => chunks.push(d));
            rs.on('end', () => resolve(Buffer.concat(chunks)));
            rs.on('error', reject);
          }));
          const uploaded = await driveUploadBuffer(drive, suggested, buffer);
          resources.push({ name: uploaded.name, href: uploaded.href, mimeType: uploaded.mimeType });
        } else {
          // If it wasn't a file download (or Drive not configured), keep the href
          const href = await a.getAttribute('href');
          resources.push({ name, href, mimeType: 'text/html' });
        }
      }

      assignments.push({ title, course, due, description, resources });

      await detailPage.close();
    }

    await browser.close();
    return res.json({ scrapedAt: new Date().toISOString(), assignments });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

/* healthcheck */
app.get('/', (_, res) => res.send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('listening'));
