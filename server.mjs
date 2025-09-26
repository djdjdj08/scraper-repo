import express from 'express';
import { chromium } from 'playwright';
import { google } from 'googleapis';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- ENV ----------
const SECRET       = process.env.WEBHOOK_SECRET || 'change-me';
const BB_USERNAME  = process.env.BB_USERNAME;
const BB_PASSWORD  = process.env.BB_PASSWORD;
const BASE         = process.env.BB_BASE || 'https://<your-subdomain>.myschoolapp.com/';
const LOGIN_URL    = process.env.BB_LOGIN_URL || BASE + 'app/login';
const ASSIGN_URL   = process.env.BB_ASSIGN_URL || BASE + 'app/student#assignment-center';

// DOM selectors (override via Render env if needed)
const CARD_SEL     = process.env.CARD_SELECTOR       || '.assignment-card';
const TITLE_SEL    = process.env.TITLE_SELECTOR      || '.assignment-title';
const COURSE_SEL   = process.env.COURSE_SELECTOR     || '.assignment-course';
const DUE_SEL      = process.env.DUE_SELECTOR        || '.assignment-due';
const DESC_SEL     = process.env.DESC_SELECTOR       || '.assignment-description';
const RES_LINK_SEL = process.env.RES_LINK_SELECTOR   || 'a.resource-link';

// Google Drive (service account JSON pasted into env)
const SA_JSON      = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // full JSON
const DRIVE_FOLDER = process.env.GDRIVE_FOLDER_ID || null;

function driveClient() {
  if (!SA_JSON) return null;
  const creds = JSON.parse(SA_JSON);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/drive']
  );
  return google.drive({ version: 'v3', auth: jwt });
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

    // Typical Blackbaud username/password form
    if (await page.locator('input[name="username"]').count()) {
      await page.fill('input[name="username"]', BB_USERNAME);
      await page.fill('input[name="password"]', BB_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle');
    } else {
      // SSO button (adjust if your portal shows different text)
      const ssoBtn = page.locator('text=Sign in with SSO');
      if (await ssoBtn.count()) {
        await ssoBtn.click();
        // If your school has extra SSO steps/MFA, this may need tweaks.
        await page.waitForLoadState('networkidle');
      }
    }

    // ----- ASSIGNMENTS -----
    await page.goto(ASSIGN_URL, { waitUntil: 'networkidle' });
    // Give the SPA a moment to render
    await page.waitForTimeout(1500);

    const cards = page.locator(CARD_SEL);
    const count = await cards.count();

    const drive = driveClient();
    const assignments = [];

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);

      const textOrEmpty = async (sel) =>
        ((await card.locator(sel).first().textContent().catch(()=>'') ) || '').trim();

      const title = await textOrEmpty(TITLE_SEL);
      const course = await textOrEmpty(COURSE_SEL);
      const due = await textOrEmpty(DUE_SEL);
      const description = await textOrEmpty(DESC_SEL);

      // --- Resources: click and upload to Drive if file download happens ---
      const anchors = card.locator(RES_LINK_SEL);
      const n = await anchors.count();
      const resources = [];

      for (let j = 0; j < n; j++) {
        const a = anchors.nth(j);
        const name = ((await a.textContent().catch(()=>'')) || 'resource').trim();

        const [dl] = await Promise.all([
          page.waitForEvent('download').catch(()=>null),
          a.click()
        ]);

        if (dl && drive) {
          const suggested = await dl.suggestedFilename().catch(()=> name);
          const buffer = await dl.createReadStream().then(rs => new Promise((resolve,reject)=>{
            const chunks=[]; rs.on('data',d=>chunks.push(d));
            rs.on('end',()=>resolve(Buffer.concat(chunks)));
            rs.on('error',reject);
          }));
          const up = await driveUploadBuffer(drive, suggested, buffer);
          resources.push({ name: up.name, href: up.href, mimeType: up.mimeType });
        } else {
          // Not a direct file (or Drive not configured): just capture href
          const href = await a.getAttribute('href');
          resources.push({ name, href, mimeType: 'text/html' });
        }
      }

      assignments.push({ title, course, due, description, resources });
    }

    await browser.close();
    return res.json({ scrapedAt: new Date().toISOString(), assignments });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get('/', (_, res) => res.send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('listening'));
