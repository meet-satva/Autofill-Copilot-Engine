import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';

// ── Build a GoogleAuth from the service account ──────────────────────────────
// Strategy (first match wins):
//   1. GOOGLE_SERVICE_ACCOUNT_JSON env var (full JSON string)
//   2. GOOGLE_APPLICATION_CREDENTIALS env var (path to JSON file)
//   3. next-app/service-account.json  (drop your JSON file here)
//   4. Downloads folder JSON fallback
//   5. GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY env vars


function getCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try { return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); } catch { return null; }
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const raw = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
      return JSON.parse(raw);
    } catch { return null; }
  }

  const localPath = path.join(process.cwd(), 'service-account.json');
  if (fs.existsSync(localPath)) {
    try { return JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch { return null; }
  }

  const downloadsDir = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
  if (fs.existsSync(downloadsDir)) {
    const files = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.json') && f.includes('adminsdk'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(downloadsDir, file), 'utf8'));
        if (data.private_key && data.client_email) return data;
      } catch { /* continue to next file */ }
    }
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';
  key = key.replace(/\\n/g, '\n').replace(/^"|"$/g, '').trim();
  if (email && key.includes('BEGIN')) {
    return { client_email: email, private_key: key };
  }

  throw new Error(
    'Google Drive credentials not found. Please do one of:\n' +
    '  A) Copy your service account JSON to next-app/service-account.json\n' +
    '  B) Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json in .env\n' +
    '  C) Set GOOGLE_SERVICE_ACCOUNT_JSON=<full JSON string> in .env'
  );
}

export const getDriveClient = () => {
  const creds = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: creds.client_email,
      private_key: creds.private_key,
    },
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

// Extract folder ID from a Google Drive URL
export function extractFolderId(url) {
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /^([a-zA-Z0-9_-]+)$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  throw new Error('Could not extract folder ID from URL: ' + url);
}

// Recursively list all files in a folder
export async function listAllFiles(folderId, path = '') {
  const drive = getDriveClient();
  const files = [];

  async function crawl(id, currentPath) {
    let pageToken = null;
    do {
      const res = await drive.files.list({
        q: `'${id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size, parents, webViewLink)',
        pageSize: 100,
        pageToken: pageToken || undefined,
      });
      for (const file of res.data.files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          await crawl(file.id, `${currentPath}/${file.name}`);
        } else {
          files.push({ ...file, path: `${currentPath}/${file.name}` });
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  await crawl(folderId, path);
  return files;
}

// Download file as base64 string
export async function downloadFileAsBase64(fileId, mimeType) {
  const drive = getDriveClient();

  const exportMap = {
    'application/vnd.google-apps.document': 'application/pdf',
    'application/vnd.google-apps.spreadsheet': 'application/pdf',
    'application/vnd.google-apps.presentation': 'application/pdf',
  };

  if (exportMap[mimeType]) {
    const res = await drive.files.export(
      { fileId, mimeType: exportMap[mimeType] },
      { responseType: 'arraybuffer' }
    );
    const buffer = Buffer.from(res.data);
    return { base64: buffer.toString('base64'), resolvedMime: exportMap[mimeType] };
  } else {
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const buffer = Buffer.from(res.data);
    return { base64: buffer.toString('base64'), resolvedMime: mimeType };
  }
}

