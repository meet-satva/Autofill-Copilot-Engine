
import { verifyToken } from '../auth/verify.js';
import { createSyncJob, updateSyncJob, addIngestionFailure, addArchivedDocument, setVault, getVault } from '../../../db.js';
import { extractFolderId, listAllFiles, getDriveClient } from '../../../lib/driveClient.js';
import { deepEncryptObject, deepDecryptObject } from "../../../lib/encryptionUtils.js";
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';
import { parseDocumentWithVision } from '../../../lib/openRouterClient.js';
import {
  migrateLegacyVault,
  resolveTreeVault,
  buildAssignCandidates,
  matchNameToProfileKey,
  isGenericFolderName,
  extractPersonNameFromPath,
} from '../../../lib/familyTreeUtils.js';
const PARSE_PROMPTS = {
  aadhaar: `Extract from this Aadhaar card. Return ONLY valid JSON:
{
  "name": "full name",
  "dob": "DD/MM/YYYY",
  "gender": "Male|Female|Other",
  "aadhaarNumber": "XXXX XXXX XXXX",
  "address": "full address",
  "pincode": "6 digit PIN/ZIP from address or null",
  "email": "if visible or null"
}`,

  pan: `Extract from PAN card. Return ONLY valid JSON:
{
  "name": "full name",
  "fatherName": "or null",
  "dob": "DD/MM/YYYY",
  "panNumber": "10 char PAN"
}`,

  passport: `Extract from passport. Return ONLY valid JSON:
{
  "name": "full name",
  "dob": "DD/MM/YYYY",
  "gender": "Male|Female",
  "passportNumber": "number",
  "dateOfIssue": "DD/MM/YYYY",
  "dateOfExpiry": "DD/MM/YYYY",
  "placeOfIssue": "city or null",
  "nationality": "INDIAN"
}`,

  driving_licence: `Extract from driving licence. Return ONLY valid JSON:
{
  "name": "full name",
  "dob": "DD/MM/YYYY",
  "licenceNumber": "number",
  "dateOfIssue": "DD/MM/YYYY or null",
  "dateOfExpiry": "DD/MM/YYYY",
  "address": "or null",
  "vehicleClasses": ["LMV"]
}`,

  voter_id: `Extract from Voter ID. Return ONLY valid JSON:
{
  "name": "full name",
  "fatherOrHusbandName": "or null",
  "dob": "DD/MM/YYYY or null",
  "gender": "Male|Female|Other",
  "epicNumber": "number",
  "address": "or null"
}`,

  land_deed: `Extract from land deed. Return ONLY valid JSON:
{
  "registrationNumber": "number",
  "registrationDate": "DD/MM/YYYY",
  "ownerName": "primary owner",
  "coOwnerName": "or null",
  "propertyAddress": "full address",
  "surveyNumber": "or null",
  "area": "with unit or null",
  "marketValue": "or null"
}`,

  unknown: `You are an expert document parser. Extract ALL readable information from this document regardless of type (identity card, certificate, bank document, utility bill, government form, resume, contact list, etc.).
Return ONLY valid JSON with every field you can find. Use null for missing values.
{
  "documentType": "your best guess",
  "name": "full name or null",
  "fatherName": "or null",
  "motherName": "or null",
  "spouseName": "or null",
  "dob": "DD/MM/YYYY or null",
  "gender": "Male|Female|Other or null",
  "idNumber": "primary ID/reference number or null",
  "aadhaarNumber": "or null",
  "panNumber": "or null",
  "passportNumber": "or null",
  "address": "full address or null",
  "pincode": "6-digit PIN/ZIP or null",
  "phone": "or null",
  "phoneNumber": "or null",
  "email": "email address if visible or null",
  "businessName": "company/business name or null",
  "website": "website URL or null",
  "dateOfIssue": "or null",
  "dateOfExpiry": "or null",
  "otherDetails": {}
}`,

  contact_info: `Parse this contact/business details text. The input may be key:value lines (e.g. email: x@y.com, BusinessName: Acme).
Return ONLY valid JSON. Extract every field present:
{
  "documentType": "contact_info",
  "name": "person name or null",
  "email": "email or null",
  "phone": "phone/mobile or null",
  "phoneNumber": "same as phone or null",
  "businessName": "business/company name or null",
  "website": "website URL or null",
  "address": "address or null",
  "pincode": "6-digit PIN/ZIP or null",
  "otherDetails": {}
}`,
};

// ✅ Extract PDF text
async function extractPdfText(pdfBuffer) {
  try {
    const parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText();
    const text = (result?.text || '').trim();
    if (text.length > 0) {
      console.log(`    ✅ PDF text: ${text.length} chars`);
      return text;
    }
  } catch (err) {
    console.warn(`    ⚠️  PDF extraction failed: ${err.message}`);
  }
  return null;
}

function shouldFallbackToImageOcr(text, documentType = '', fileName = '') {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;

  // Scanned identity PDFs often expose only a few OCR fragments. If the text
  // is tiny, incomplete, or missing the expected document signals, treat it as
  // low-confidence and render the PDF pages as images for vision parsing.
  if (normalized.length < 40) return true;

  const lower = normalized.toLowerCase();
  const doc = `${documentType} ${fileName}`.toLowerCase();

  if (doc.includes('pan')) {
    return !(
      /permanent account number|income tax|government of india|name\s*\/?\s*name|date of birth|[A-Z]{5}[0-9]{4}[A-Z]/i.test(normalized)
    );
  }

  if (doc.includes('aadhaar') || doc.includes('aadhar')) {
    return !(/aadhaar|aadhar|uidai|male|female|\b\d{4}\s?\d{4}\s?\d{4}\b/i.test(normalized));
  }

  if (doc.includes('passport')) {
    return !(/passport|nationality|date of issue|date of expiry/i.test(normalized));
  }

  return /^[\W_]*$/.test(normalized) || !/[0-9]/.test(normalized) && normalized.split(' ').length <= 4;
}

async function renderPdfPagesAsImages(pdfBuffer, maxPages = 4) {
  try {
    const metadata = await sharp(pdfBuffer, { density: 300 }).metadata();
    const pageCount = Math.max(1, metadata.pages || 1);
    const count = Math.min(pageCount, maxPages);
    const images = [];
    for (let page = 0; page < count; page++) {
      const pageBuffer = await sharp(pdfBuffer, { density: 300, page })
        .jpeg({ quality: 85 })
        .resize({ width: 1600, withoutEnlargement: true })
        .toBuffer();
      images.push(pageBuffer);
      console.log(`    ✅ Rendered PDF page ${page + 1}/${count} as image (${(pageBuffer.length / 1024).toFixed(1)} KB)`);
    }
    return images;
  } catch (err) {
    console.warn(`    ⚠️  PDF render fallback failed: ${err.message}`);
    return [];
  }
}

// ✅ Extract TXT text
function extractTxtText(buffer) {
  try {
    const text = buffer.toString('utf-8').trim();
    if (text.length > 0) {
      console.log(`    ✅ Text file: ${text.length} chars`);
      return text;
    }
  } catch (err) {
    console.warn(`    ⚠️  Text extraction failed: ${err.message}`);
  }
  return null;
}

const KV_FIELD_MAP = {
  email: 'email',
  mail: 'email',
  emailaddress: 'email',
  phonenumber: 'phone',
  phone: 'phone',
  mobile: 'phone',
  mobilenumber: 'phone',
  tel: 'phone',
  telephone: 'phone',
  businessname: 'businessName',
  business: 'businessName',
  company: 'businessName',
  companyname: 'businessName',
  organisation: 'businessName',
  organization: 'businessName',
  website: 'website',
  url: 'website',
  site: 'website',
  pincode: 'pincode',
  pin: 'pincode',
  zip: 'pincode',
  zipcode: 'pincode',
  postalcode: 'pincode',
  name: 'name',
  fullname: 'name',
  address: 'address',
  dob: 'dob',
  dateofbirth: 'dob',
};

function normalizeKvKey(key) {
  return (key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Fast local parser for key:value text files — no LLM needed */
export function parseKeyValueText(text) {
  const result = { documentType: 'contact_info', otherDetails: {} };
  if (!text?.trim()) return result;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    const rawKey = match[1].trim();
    const value = match[2].trim();
    if (!value) continue;

    const mapped = KV_FIELD_MAP[normalizeKvKey(rawKey)];
    if (mapped === 'pincode') {
      const digits = value.replace(/\D/g, '');
      result.pincode = digits.length >= 6 ? digits.slice(-6) : digits;
    } else if (mapped) {
      result[mapped] = value;
    } else {
      result.otherDetails[rawKey] = value;
    }
  }

  if (result.phone && !result.phoneNumber) result.phoneNumber = result.phone;
  if (result.phoneNumber && !result.phone) result.phone = result.phoneNumber;

  const emailInText = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (!result.email && emailInText) result.email = emailInText[0];

  if (!result.pincode && result.address) {
    const pinMatch = result.address.match(/\b(\d{6})\b/);
    if (pinMatch) result.pincode = pinMatch[1];
  }

  return result;
}

function countParsedFields(data) {
  if (!data || typeof data !== 'object') return 0;
  return Object.entries(data).filter(([k, v]) => {
    if (k === 'otherDetails') {
      return v && typeof v === 'object' && Object.keys(v).length > 0;
    }
    return v !== null && v !== undefined && v !== '';
  }).length;
}

function enrichParsedData(parsed, rawText = '') {
  const out = {
    ...parsed,
    otherDetails: { ...(parsed?.otherDetails && typeof parsed.otherDetails === 'object' ? parsed.otherDetails : {}) },
  };

  const kv = rawText ? parseKeyValueText(rawText) : {};
  for (const [key, value] of Object.entries(kv)) {
    if (key === 'otherDetails') {
      Object.assign(out.otherDetails, value);
      continue;
    }
    if (value && (out[key] === null || out[key] === undefined || out[key] === '')) {
      out[key] = value;
    }
  }

  for (const [key, value] of Object.entries(out.otherDetails)) {
    const mapped = KV_FIELD_MAP[normalizeKvKey(key)];
    if (mapped && value && !out[mapped]) {
      out[mapped] = mapped === 'pincode' ? String(value).replace(/\D/g, '').slice(-6) : value;
    }
  }

  if (!out.phone && out.phoneNumber) out.phone = out.phoneNumber;
  if (!out.phoneNumber && out.phone) out.phoneNumber = out.phone;
  if (!out.pincode && out.address) {
    const pinMatch = out.address.match(/\b(\d{6})\b/);
    if (pinMatch) out.pincode = pinMatch[1];
  }

  return out;
}

function hasUsefulParsedData(parsed) {
  if (!parsed || parsed.error) return false;
  const keys = ['name', 'email', 'phone', 'phoneNumber', 'businessName', 'website', 'address', 'pincode', 'aadhaarNumber', 'panNumber', 'dob'];
  return keys.some((k) => parsed[k]) || (parsed.otherDetails && Object.keys(parsed.otherDetails).length > 0);
}

function resolveProfileForDocument(doc, cleanParsed, familyTree) {
  if (doc.matchedRole) return doc.matchedRole;

  const sourceName = resolveSourceName(cleanParsed, doc);
  let profileKey = sourceName
    ? assignProfileOwner({ ...cleanParsed, name: sourceName }, familyTree)
    : assignProfileOwner(cleanParsed, familyTree);

  if (profileKey !== 'unknown') return profileKey;

  const folderGeneric = !doc.personName || doc.personName === 'unknown' || isGenericFolderName(doc.personName);
  if (folderGeneric && hasUsefulParsedData(cleanParsed) && familyTree?.primary) {
    console.log(`    ↪ Assigning to primary (${familyTree.primary}) — generic folder with contact/identity data`);
    return 'primary';
  }

  return 'unknown';
}

// Fetch Drive file as base64
async function fetchDriveFileAsBase64(fileId) {
  const drive = await getDriveClient();

  const metaRes = await drive.files.get({ fileId, fields: 'mimeType,name' });
  const { mimeType, name } = metaRes.data;

  const googleDocTypes = {
    'application/vnd.google-apps.document': 'application/pdf',
    'application/vnd.google-apps.spreadsheet': 'application/pdf',
    'application/vnd.google-apps.presentation': 'application/pdf',
  };

  const isGoogleDoc = !!googleDocTypes[mimeType];
  const exportMime = googleDocTypes[mimeType] || mimeType;

  let response;
  if (isGoogleDoc) {
    response = await drive.files.export(
      { fileId, mimeType: exportMime },
      { responseType: 'arraybuffer' }
    );
  } else {
    response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
  }

  let buffer = Buffer.from(response.data);
  let finalMime = exportMime;

  // Convert images to JPEG if needed
  if (exportMime !== 'application/pdf' && !exportMime.startsWith('text/')) {
    try {
      buffer = await sharp(buffer).jpeg({ quality: 95 }).toBuffer();
      finalMime = 'image/jpeg';
    } catch {
      console.warn(`    ⚠️  Conversion failed for ${name}`);
    }
  }

  // Resize large images
  let base64 = buffer.toString('base64');
  const sizeMB = (base64.length * 0.75) / (1024 * 1024);
  console.log(`    📏 ${name}: ${sizeMB.toFixed(2)} MB (${finalMime})`);

  if (sizeMB > 4 && finalMime === 'image/jpeg') {
    buffer = await sharp(buffer)
      .jpeg({ quality: 75 })
      .resize({ width: 1600, withoutEnlargement: true })
      .toBuffer();
    base64 = buffer.toString('base64');
  }

  return {
    base64,
    mimeType: finalMime,
    isImage: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(finalMime),
    isPDF: finalMime === 'application/pdf',
    isText: finalMime === 'text/plain',
    name,
  };
}

// ✅ Parse with images AND text
export async function parseDocumentGroup(group) {
  const { personName, documentType, files } = group;

  console.log(`    🔍 parseDocumentGroup: ${personName || 'unknown'} / ${documentType} / ${files.length} file(s)`);

  if (!personName || personName === 'unknown') {
    console.warn(`    ⚠️  WARNING: personName is undefined`);
  }

  try {
    const imageFiles = [];
    const textParts = [];

    // ✅ Process ALL file types
    for (const file of files) {
      try {
        const fetched = await fetchDriveFileAsBase64(file.id);

        // Images
        if (fetched.isImage) {
          console.log(`    ✅ Image: ${file.name}`);
          imageFiles.push(fetched);
        }
        // PDFs - extract text
        else if (fetched.isPDF) {
          console.log(`    📄 PDF: ${file.name}`);
          const pdfBuffer = Buffer.from(fetched.base64, 'base64');
          const text = await extractPdfText(pdfBuffer);
          const useImageFallback = shouldFallbackToImageOcr(text, documentType, file.name);

          if (text && !useImageFallback) {
            textParts.push(`[${file.name}]:\n${text}`);
          } else {
            console.log(`    🔄 PDF text is low-confidence or scanned; rendering pages as images`);
            if (text) {
              textParts.push(`[${file.name}] OCR text:\n${text}`);
            }
            const pageImages = await renderPdfPagesAsImages(pdfBuffer);
            for (let index = 0; index < pageImages.length; index++) {
              const buffer = pageImages[index];
              imageFiles.push({
                name: `${file.name} [page ${index + 1}]`,
                mimeType: 'image/jpeg',
                base64: buffer.toString('base64'),
                isImage: true,
              });
            }
          }
        }
        // Text files
        else if (fetched.isText || file.name.endsWith('.txt')) {
          console.log(`    📝 Text: ${file.name}`);
          const textBuffer = Buffer.from(fetched.base64, 'base64');
          const text = extractTxtText(textBuffer);
          if (text) {
            textParts.push(`[${file.name}]:\n${text}`);
          }
        } else {
          console.warn(`    ⚠️  Trying image conversion for: ${file.name} (${fetched.mimeType})`);
          try {
            const rawBuffer = Buffer.from(fetched.base64, 'base64');
            const imgBuffer = await sharp(rawBuffer).jpeg({ quality: 90 }).resize({ width: 1600, withoutEnlargement: true }).toBuffer();
            imageFiles.push({
              name: file.name,
              mimeType: 'image/jpeg',
              base64: imgBuffer.toString('base64'),
              isImage: true,
            });
            console.log(`    ✅ Converted to image: ${file.name}`);
          } catch {
            console.warn(`    ⚠️  Unsupported: ${file.name} (${fetched.mimeType})`);
          }
        }
      } catch (err) {
        console.error(`    ❌ Fetch failed ${file.name}:`, err.message);
      }
    }

    // ❌ No content at all
    if (imageFiles.length === 0 && textParts.length === 0) {
      return { error: 'NO_CONTENT', message: 'No processable files found' };
    }

    console.log(`    📤 Sending: ${imageFiles.length} images + ${textParts.length} text sources`);

    const combinedText = textParts.join('\n');
    const isTextOnly = imageFiles.length === 0 && textParts.length > 0;
    const kvParsed = isTextOnly ? parseKeyValueText(combinedText) : null;
    const kvFieldCount = kvParsed ? countParsedFields(kvParsed) : 0;

    if (isTextOnly && kvFieldCount >= 1) {
      console.log(`    ⚡ Key-value text parsed locally (${kvFieldCount} fields) — skipping LLM`);
      return enrichParsedData(kvParsed, combinedText);
    }

    const effectiveType = documentType === 'unknown' && isTextOnly && kvFieldCount >= 1
      ? 'contact_info'
      : documentType;

    const prompt = effectiveType === 'unknown'
      ? PARSE_PROMPTS.unknown
      : effectiveType === 'contact_info'
        ? PARSE_PROMPTS.contact_info
        : `${PARSE_PROMPTS[effectiveType] || PARSE_PROMPTS.unknown}\n\nAlso extract spouseName, fatherName, motherName, email, phone, businessName, website, pincode if visible.`;

    const rawText = await parseDocumentWithVision({
      prompt,
      imageFiles,
      textParts,
    });

    console.log(`    📝 Response: ${rawText.slice(0, 200)}`);

    const clean = rawText.replace(/```json|```/gi, '').trim();
    if (!clean) {
      if (kvParsed && kvFieldCount >= 1) {
        return enrichParsedData(kvParsed, combinedText);
      }
      return { error: 'EMPTY_RESPONSE', message: 'Model returned empty' };
    }

    try {
      const parsed = JSON.parse(clean);
      return enrichParsedData(parsed, combinedText);
    } catch {
      const jsonMatch = clean.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return enrichParsedData(parsed, combinedText);
      }
      if (kvParsed && kvFieldCount >= 1) {
        console.log(`    ⚡ LLM parse failed — using key-value fallback`);
        return enrichParsedData(kvParsed, combinedText);
      }
      return { error: 'JSON_PARSE_ERROR', message: clean.slice(0, 100) };
    }

  } catch (err) {
    console.error(`    ❌ Parse error:`, err.message);
    return { error: 'API_ERROR', message: err.message };
  }
}

// Assign to profile
function resolveSourceName(parsedData, doc) {
  for (const n of [parsedData?.name, doc?.personName]) {
    if (n && !isGenericFolderName(n)) return n;
  }
  return '';
}

function sanitizeParsedData(parsedData) {
  if (!parsedData || typeof parsedData !== 'object') return {};
  const out = { ...parsedData };
  if (isGenericFolderName(out.name)) delete out.name;
  return out;
}

export function assignProfileOwner(parsedData, familyTree) {
  const norm = (str) =>
    (str || '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const similarity = (a, b) => {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.startsWith(y) || y.startsWith(x)) return 0.92;

    const ax = x.split(' ').filter(Boolean);
    const by = y.split(' ').filter(Boolean);
    const overlap = ax.filter(t => by.includes(t)).length;
    return overlap / Math.max(ax.length, by.length, 1);
  };

  const aliasMatches = (candidateName, targetName) => {
    const c = norm(candidateName);
    const t = norm(targetName);
    if (!c || !t) return false;
    if (c === t) return true;
    if (c.startsWith(t) || t.startsWith(c)) return true;
    const firstC = c.split(' ')[0];
    const firstT = t.split(' ')[0];
    return firstC && firstT && (firstC.startsWith(firstT) || firstT.startsWith(firstC));
  };

  const extractedName = norm(parsedData.name || '');
  if (!extractedName || isGenericFolderName(extractedName)) {
    console.warn('    ⚠️  No valid person name in parsed data');
    return 'unknown';
  }

  const candidates = buildAssignCandidates(familyTree);

  // Exact match
  for (const candidate of candidates) {
    const normalizedNames = candidate.names.map((n) => norm(n));
    if (normalizedNames.some((n) => n === extractedName)) {
      console.log(`    ✅ Exact match → ${candidate.profileKey}`);
      return candidate.profileKey;
    }
  }

  // Fuzzy alias match, useful for files/folders that omit the last letter or use nickname variants.
  for (const candidate of candidates) {
    const normalizedNames = candidate.names.map((n) => norm(n));
    if (normalizedNames.some((n) => aliasMatches(n, extractedName))) {
      console.log(`    ✅ Alias match → ${candidate.profileKey}`);
      return candidate.profileKey;
    }
  }

  // All words match
  const extractedWords = extractedName.split(' ').filter(Boolean);
  for (const candidate of candidates) {
    for (const candidateName of candidate.names) {
      const candidateWords = candidateName.split(' ').filter(Boolean);
      if (extractedWords.every(w => candidateWords.includes(w))) {
        console.log(`    ✅ All-words match → ${candidate.profileKey}`);
        return candidate.profileKey;
      }
    }
  }

  // First + last
  const firstWord = extractedWords[0];
  const lastWord = extractedWords[extractedWords.length - 1];

  for (const candidate of candidates) {
    for (const candidateName of candidate.names) {
      const candidateWords = candidateName.split(' ').filter(Boolean);
      if (candidateWords.includes(firstWord) && (firstWord === lastWord || candidateWords.includes(lastWord))) {
        console.log(`    ✅ First+last match → ${candidate.profileKey}`);
        return candidate.profileKey;
      }
    }
  }

  // First name only
  for (const candidate of candidates) {
    for (const candidateName of candidate.names) {
      if (candidateName.split(' ')[0] === firstWord) {
        console.log(`    ⚠️  First-name match → ${candidate.profileKey}`);
        return candidate.profileKey;
      }
    }
  }

  // Similarity fallback
  let best = { profileKey: 'unknown', score: 0 };
  for (const candidate of candidates) {
    for (const candidateName of candidate.names) {
      const score = similarity(extractedName, candidateName);
      if (score > best.score) {
        best = { profileKey: candidate.profileKey, score };
      }
    }
  }

  if (best.score >= 0.72) {
    console.log(`    ✅ Fuzzy similarity match (${best.score.toFixed(2)}) → ${best.profileKey}`);
    return best.profileKey;
  }

  console.warn(`    ❌ No match for: "${parsedData.name}"`);
  return 'unknown';
}

function detectDocumentType(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('aadhaar') || name.includes('aadhar') || name.includes('uid')) return 'aadhaar';
  if (name.includes('pan')) return 'pan';
  if (name.includes('passport')) return 'passport';
  if (name.includes('driving') || name.includes('licence') || name.includes('license') || name.includes('dl_')) return 'driving_licence';
  if (name.includes('voter') || name.includes('epic')) return 'voter_id';
  if (name.includes('land') || name.includes('deed') || name.includes('property') || name.includes('sale deed')) return 'land_deed';
  if (name.includes('birth')) return 'unknown';
  if (name.includes('ration')) return 'unknown';
  if (name.includes('bank') || name.includes('passbook') || name.includes('statement')) return 'unknown';
  if (name.includes('resume') || name.includes('cv')) return 'unknown';
  if (name.includes('bill') || name.includes('invoice') || name.includes('receipt')) return 'unknown';
  if (name.includes('certificate') || name.includes('cert')) return 'unknown';
  if (name.includes('other') || name.includes('contact') || name.includes('detail') || name.includes('info')) return 'contact_info';
  if (name.endsWith('.txt')) return 'contact_info';
  return 'unknown';
}


function groupDocumentsByFolderStructure(allFilesWithPaths) {
  console.log('\n📊 Grouping documents...');
  const groups = {};

  for (const { file, folderPath } of allFilesWithPaths) {
    if (file.mimeType === 'application/vnd.google-apps.folder') continue;

    const pathParts = folderPath.split('/').filter(p => p);
    const extracted = extractPersonNameFromPath(pathParts);
    const personName = extracted !== 'unknown' && !isGenericFolderName(extracted) ? extracted : 'unknown';

    // Detect doc type from filename, then parent folder
    const documentType = detectDocumentType(file.name) || detectDocumentType(pathParts[pathParts.length - 2]) || 'unknown';

    const parentId = file.parents?.[0] || 'root';
    const groupKey = personName !== 'unknown'
      ? (documentType === 'unknown' ? `${personName}__${documentType}__${file.id}` : `${personName}__${documentType}`)
      : `folder_${parentId}__${documentType}__${file.id}`;
    if (!groups[groupKey]) {
      groups[groupKey] = { personName, documentType, files: [] };
    }
    groups[groupKey].files.push(file);
  }

  const groupArray = Object.values(groups);
  console.log(`\n✅ Created ${groupArray.length} groups`);
  groupArray.forEach((g, idx) => {
    console.log(`   [${idx}] "${g.personName}" - ${g.documentType} (${g.files.length} files)`);
  });
  return groupArray;
}

export async function runSyncJob(jobId, folderUrl, userId, treeId) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 Sync Job: ${jobId}`);
  console.log(`${'='.repeat(80)}\n`);

  let folderId;
  try {
    folderId = extractFolderId(folderUrl);
  } catch (e) {
    await updateSyncJob(jobId, { status: 'failed', error: e.message });
    return;
  }

  let allFilesWithPaths = [];
  try {
    const allFiles = await listAllFiles(folderId);
    for (const file of allFiles) {
      allFilesWithPaths.push({ file, folderPath: file.path || file.name });
    }
  } catch (err) {
    await updateSyncJob(jobId, { status: 'failed', error: `Failed to list files: ${err.message}` });
    return;
  }

  await updateSyncJob(jobId, { progress: { total: allFilesWithPaths.length, processed: 0, failed: 0 } });

  let rootVault = await getVault(userId);
  rootVault = migrateLegacyVault(rootVault);
  const treeCtx = resolveTreeVault(rootVault, treeId);
  if (!treeCtx) {
    await updateSyncJob(jobId, { status: 'failed', error: 'Family tree not found. Create a family tree first.' });
    return;
  }

  const vaultData = {
    ownerId: userId,
    lastSynced: new Date().toISOString(),
    familyTree: { ...treeCtx.tree.familyTree },
    profiles: deepDecryptObject(treeCtx.tree.profiles || {}),
    assets: deepDecryptObject(treeCtx.tree.assets || {}),
  };

  for (const { profileKey } of buildAssignCandidates(vaultData.familyTree)) {
    if (!vaultData.profiles[profileKey]) {
      vaultData.profiles[profileKey] = { personalDetails: {}, identities: {}, documents: [] };
    }
  }

  let groups;
  try {
    groups = groupDocumentsByFolderStructure(allFilesWithPaths);
    groups = groups.map((g) => {
      const role = matchNameToProfileKey(g.personName, vaultData.familyTree);
      if (!role) return g;
      const ft = vaultData.familyTree;
      const canonical = {
        primary: ft.primary,
        spouse: ft.spouse,
        grandfather: ft.grandfather,
        grandmother: ft.grandmother,
        ...(ft.children || []).reduce((acc, c, i) => ({ ...acc, [`children_${i}`]: c }), {}),
      }[role];
      return { ...g, personName: canonical || g.personName, matchedRole: role };
    });
  } catch (err) {
    await updateSyncJob(jobId, { status: 'failed', error: `Failed to group: ${err.message}` });
    return;
  }

  if (groups.length === 0) {
    await updateSyncJob(jobId, { status: 'failed', error: 'No document groups found' });
    return;
  }

  let processed = 0;
  let failed = 0;

  const allParsedDocuments = [];

  for (const group of groups) {
    const folderRole = matchNameToProfileKey(group.personName, vaultData.familyTree);
    if (folderRole) {
      console.log(`  📁 Folder "${group.personName}" → tree role: ${folderRole}`);
    }
    console.log(`\n  📄 Parsing group: "${group.personName}" - ${group.documentType} (${group.files.length} file(s))`);
    const parsed = await parseDocumentGroup(group);

    if (parsed?.error) {
      failed++;
      console.error(`  ❌ Failed: ${parsed.error}`);
      await addIngestionFailure({
        jobId,
        person: group.personName,
        files: group.files.map(f => f.name),
        error: parsed.error,
        message: parsed.message,
        status: `Failed - ${parsed.error}`,
      });
      // Even if parsing failed, we preserve the document links in the vault/archived docs
      allParsedDocuments.push({
        ...group,
        parsedData: {
          documentType: group.documentType !== 'unknown' ? group.documentType : 'unknown',
          name: group.personName !== 'unknown' && !isGenericFolderName(group.personName) ? group.personName : null,
          parseError: parsed.error,
        },
      });
    } else {
      console.log(`  ✅ Parsed successfully`);
      allParsedDocuments.push({
        ...group,
        parsedData: parsed,
      });
      processed++;
    }
    await updateSyncJob(jobId, { progress: { total: allFilesWithPaths.length, processed: processed + failed, failed } });
  }

  // Group the parsed documents by owner profile and document type
  const profilesAndDocs = {};
  const assetDocuments = [];

  for (const doc of allParsedDocuments) {
    const { documentType, parsedData } = doc;

    if (documentType === 'land_deed') {
      assetDocuments.push(doc);
      continue;
    }

    const cleanParsed = sanitizeParsedData(parsedData);
    const profileKey = resolveProfileForDocument(doc, cleanParsed, vaultData.familyTree);
    const sourceName = resolveSourceName(cleanParsed, doc);
    console.log(`  👤 Assigned "${sourceName || cleanParsed.name || doc.personName || 'unknown'}" → ${profileKey}`);

    if (profileKey === 'unknown') {
      console.warn(`  ⚠️  Could not match owner — archiving without profile assignment`);
      const links = doc.files
        .filter(f => f.mimeType !== 'text/plain' && !f.name.endsWith('.txt'))
        .map(f => f.webViewLink)
        .filter(Boolean);
      if (links.length > 0) doc.parsedData.documentLinks = links;

      await addArchivedDocument({
        userId,
        documentType,
        parsedData: deepEncryptObject(doc.parsedData),
        driveFileIds: doc.files.map(f => f.id),
        driveFileNames: doc.files.map(f => f.name),
        status: 'archived_unknown_owner',
        determinedDate: null,
        dateSource: null,
      });
      continue;
    }

    if (!profilesAndDocs[profileKey]) {
      profilesAndDocs[profileKey] = {};
    }
    
    // Separate buckets per file for contact/unknown docs so nothing overwrites
    const uniqueType = (documentType === 'unknown' || documentType === 'contact_info')
      ? `${documentType}_${doc.files[0].id}`
      : documentType;
    if (!profilesAndDocs[profileKey][uniqueType]) {
      profilesAndDocs[profileKey][uniqueType] = [];
    }
    profilesAndDocs[profileKey][uniqueType].push(doc);
  }

  const resolveDocType = (uniqueType) => {
    if (uniqueType.startsWith('unknown_')) return 'unknown';
    if (uniqueType.startsWith('contact_info_')) return 'contact_info';
    return uniqueType;
  };

  const isIdentityDoc = (type) => ['aadhaar', 'pan', 'passport', 'driving_licence', 'voter_id'].includes(type);

  function upsertDocument(profileKey, record) {
    const docs = vaultData.profiles[profileKey].documents;
    const idx = docs.findIndex(
      d => d.documentType === record.documentType && JSON.stringify(d.driveFileIds || []) === JSON.stringify(record.driveFileIds || [])
    );
    if (idx === -1) {
      docs.push(record);
      return;
    }
    docs[idx] = { ...docs[idx], ...record };
  }

  function applyParsedToPersonalDetails(profileKey, parsedData, fullName) {
    const pd = vaultData.profiles[profileKey].personalDetails;
    const setIf = (key, val) => {
      if (val !== null && val !== undefined && val !== '') pd[key] = val;
    };

    const name = fullName || parsedData.name;
    if (name && !isGenericFolderName(name)) {
      const parts = name.split(' ').filter(Boolean);
      setIf('firstName', parts[0] || '');
      setIf('lastName', parts.length > 1 ? parts[parts.length - 1] : '');
      if (parts.length > 2) {
        setIf('middleName', parts.slice(1, -1).join(' '));
      }
      setIf('fullName', name);
      setIf('name', name);
    }
    setIf('dob', parsedData.dob);
    setIf('gender', parsedData.gender);
    setIf('address', parsedData.address);
    if (parsedData.pincode) {
      setIf('pincode', String(parsedData.pincode).replace(/\D/g, '').slice(-6));
    } else if (parsedData.address) {
      const pinMatch = parsedData.address.match(/\b(\d{6})\b/);
      if (pinMatch) setIf('pincode', pinMatch[1]);
    }
    setIf('email', parsedData.email);
    if (parsedData.phone || parsedData.mobile || parsedData.phoneNumber) {
      const phone = parsedData.phone || parsedData.mobile || parsedData.phoneNumber;
      setIf('phone', phone);
      setIf('phoneNumber', phone);
    }
    setIf('businessName', parsedData.businessName);
    setIf('website', parsedData.website);
    setIf('fatherName', parsedData.fatherName);
    setIf('motherName', parsedData.motherName);

    const od = parsedData.otherDetails;
    if (od && typeof od === 'object') {
      if (!pd.email && od.email) setIf('email', od.email);
      if (!pd.phone && (od.phone || od.phoneNumber || od.mobile)) {
        const phone = od.phone || od.phoneNumber || od.mobile;
        setIf('phone', phone);
        setIf('phoneNumber', phone);
      }
      if (!pd.businessName && (od.businessName || od.BusinessName || od.company)) {
        setIf('businessName', od.businessName || od.BusinessName || od.company);
      }
      if (!pd.website && (od.website || od.Website || od.url)) {
        setIf('website', od.website || od.Website || od.url);
      }
      if (!pd.pincode && od.pincode) setIf('pincode', String(od.pincode).replace(/\D/g, '').slice(-6));
    }
  }

  function normalizeIdentityRecord(docType, parsedData) {
    if (docType === 'aadhaar') {
      const pincode = parsedData.pincode || (parsedData.address?.match(/\b(\d{6})\b/)?.[1] ?? null);
      return {
        idNumber: parsedData.aadhaarNumber || parsedData.idNumber || null,
        aadhaarNumber: parsedData.aadhaarNumber || parsedData.idNumber || null,
        address: parsedData.address || null,
        pincode,
        fatherName: parsedData.fatherName || null,
        motherName: parsedData.motherName || null,
        determinedDate: parsedData.determinedDate || null,
        dateSource: parsedData.dateSource || null,
        name: parsedData.name || null,
        dob: parsedData.dob || null,
        gender: parsedData.gender || null,
        email: parsedData.email || null,
      };
    }
    if (docType === 'pan') {
      return {
        idNumber: parsedData.panNumber || parsedData.idNumber || null,
        name: parsedData.name || null,
        fatherName: parsedData.fatherName || null,
        dob: parsedData.dob || null,
      };
    }
    if (docType === 'passport') {
      return {
        idNumber: parsedData.passportNumber || parsedData.idNumber || null,
        name: parsedData.name || null,
        dob: parsedData.dob || null,
        dateOfIssue: parsedData.dateOfIssue || null,
        dateOfExpiry: parsedData.dateOfExpiry || null,
        nationality: parsedData.nationality || null,
      };
    }
    return {
      ...parsedData,
      idNumber: parsedData.idNumber || null,
    };
  }

  // Process and arbitrate identity documents per profile & type
  for (const profileKey of Object.keys(profilesAndDocs)) {
    for (const uniqueType of Object.keys(profilesAndDocs[profileKey])) {
      const docType = resolveDocType(uniqueType);
      const variants = profilesAndDocs[profileKey][uniqueType];
      const bestSourceName = variants[0]?.parsedData?.name || variants[0]?.personName || '';

      // Pick best variant by completeness
      const scored = variants.map(v => ({
        ...v,
        score: Object.values(v.parsedData).filter(val => val !== null && val !== '' && val !== undefined).length,
      }));
      scored.sort((a, b) => b.score - a.score);

      const best = scored[0];
      const rest = scored.slice(1);

      // Add document links to parsedData based on file type (if not .txt)
      const injectLinks = (variant) => {
        const links = variant.files
          .filter(f => f.mimeType !== 'text/plain' && !f.name.endsWith('.txt'))
          .map(f => f.webViewLink)
          .filter(Boolean);
        if (links.length > 0) {
          variant.parsedData.documentLinks = links;
        }
      };

      injectLinks(best);
      rest.forEach(injectLinks);

      const documentRecord = {
        documentType: docType,
        ...best.parsedData,
        driveFileIds: best.files.map(f => f.id),
        driveFileNames: best.files.map(f => f.name),
      };

      if (isIdentityDoc(docType) && vaultData.profiles[profileKey]) {
        const { parsedData } = best;
        applyParsedToPersonalDetails(profileKey, parsedData, bestSourceName);

        vaultData.profiles[profileKey].identities[docType] = {
          ...normalizeIdentityRecord(docType, { ...parsedData, name: bestSourceName }),
          driveFileIds: best.files.map(f => f.id),
          driveFileNames: best.files.map(f => f.name),
        };
      } else if (vaultData.profiles[profileKey]) {
        applyParsedToPersonalDetails(profileKey, best.parsedData, bestSourceName);
      }

      if (vaultData.profiles[profileKey]) {
        // Keep a canonical document list for every processed document type.
        upsertDocument(profileKey, documentRecord);
      }

      await addArchivedDocument({
        userId,
        documentType: docType,
        parsedData: deepEncryptObject(best.parsedData),
        driveFileIds: best.files.map(f => f.id),
        driveFileNames: best.files.map(f => f.name),
        status: 'processed_current_version',
        determinedDate: null,
        dateSource: null,
      });

      // Archive lower-score variants
      for (const variant of rest) {
        console.log(`  📦 Archiving lower-score variant for ${profileKey}: ${variant.personName}(${variant.score})`);
        await addArchivedDocument({
          userId,
          documentType: docType,
          parsedData: deepEncryptObject(variant.parsedData),
          driveFileIds: variant.files.map(f => f.id),
          driveFileNames: variant.files.map(f => f.name),
          status: 'archived_older_version',
          determinedDate: null,
          dateSource: null,
        });
      }
    }
  }

  // Process and group land deeds by registration number
  const assetsGroups = {};
  for (const doc of assetDocuments) {
    const regNum = doc.parsedData.registrationNumber || `temp_${doc.personName}_${Date.now()}`;
    if (!assetsGroups[regNum]) {
      assetsGroups[regNum] = [];
    }
    assetsGroups[regNum].push(doc);
  }

  for (const regNum of Object.keys(assetsGroups)) {
    const variants = assetsGroups[regNum];

    const scored = variants.map(v => ({
      ...v,
      score: Object.values(v.parsedData).filter(val => val !== null && val !== '' && val !== undefined).length,
    }));
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const rest = scored.slice(1);

    const injectLinks = (variant) => {
      const links = variant.files
        .filter(f => f.mimeType !== 'text/plain' && !f.name.endsWith('.txt'))
        .map(f => f.webViewLink)
        .filter(Boolean);
      if (links.length > 0) {
        variant.parsedData.documentLinks = links;
      }
    };
    injectLinks(best);
    rest.forEach(injectLinks);

    const assetKey = `asset_${best.parsedData.registrationNumber || Date.now()}`;
    vaultData.assets[assetKey] = {
      ...best.parsedData,
      driveFileIds: best.files.map(f => f.id),
      driveFileNames: best.files.map(f => f.name),
    };

    // Archive the rest
    for (const variant of rest) {
      console.log(`  📦 Archiving lower-score asset variant: ${variant.personName}(${variant.score})`);
      await addArchivedDocument({
        userId,
        documentType: 'land_deed',
        parsedData: deepEncryptObject(variant.parsedData),
        driveFileIds: variant.files.map(f => f.id),
        driveFileNames: variant.files.map(f => f.name),
        status: 'archived_older_version',
        determinedDate: null,
        dateSource: null,
      });
    }
  }

  // Promote identity & document fields into personalDetails when missing
  for (const profileKey of Object.keys(vaultData.profiles)) {
    const prof = vaultData.profiles[profileKey];
    const pd = prof.personalDetails || (prof.personalDetails = {});
    const aadhaar = prof.identities?.aadhaar;
    const pan = prof.identities?.pan;

    const setIf = (key, val) => {
      if ((pd[key] === null || pd[key] === undefined || pd[key] === '') && val) pd[key] = val;
    };

    if (aadhaar) {
      setIf('pincode', aadhaar.pincode || aadhaar.address?.match(/\b(\d{6})\b/)?.[1]);
      setIf('address', aadhaar.address);
      setIf('email', aadhaar.email);
      setIf('fatherName', aadhaar.fatherName);
      setIf('motherName', aadhaar.motherName);
      if (!aadhaar.pincode && pd.pincode) aadhaar.pincode = pd.pincode;
    }
    if (pan) {
      setIf('fatherName', pan.fatherName);
    }

    for (const doc of prof.documents || []) {
      setIf('email', doc.email);
      setIf('phone', doc.phone || doc.phoneNumber);
      setIf('phoneNumber', doc.phone || doc.phoneNumber);
      setIf('businessName', doc.businessName);
      setIf('website', doc.website);
      setIf('pincode', doc.pincode || doc.address?.match(/\b(\d{6})\b/)?.[1]);
      setIf('address', doc.address);
      setIf('fatherName', doc.fatherName);
      setIf('motherName', doc.motherName);
      if (!pd.middleName && doc.name) {
        const parts = String(doc.name).split(' ').filter(Boolean);
        if (parts.length > 2) setIf('middleName', parts.slice(1, -1).join(' '));
      }
      const od = doc.otherDetails;
      if (od && typeof od === 'object') {
        setIf('email', od.email);
        setIf('phone', od.phone || od.phoneNumber || od.mobile);
        setIf('phoneNumber', od.phone || od.phoneNumber || od.mobile);
        setIf('businessName', od.businessName || od.BusinessName || od.company);
        setIf('website', od.website || od.Website || od.url);
        setIf('pincode', od.pincode);
      }
    }
  }

  const encryptedTree = {
    ...treeCtx.tree,
    familyTree: vaultData.familyTree,
    profiles: deepEncryptObject(vaultData.profiles),
    assets: deepEncryptObject(vaultData.assets),
    lastSynced: new Date().toISOString(),
    driveFolderUrl: folderUrl,
  };

  rootVault.familyTrees[treeId] = encryptedTree;
  rootVault.activeTreeId = treeId;
  await setVault(userId, rootVault);

  console.log(`\n✅ COMPLETED - Processed: ${processed}, Failed: ${failed}`);

  await updateSyncJob(jobId, {
    status: 'completed',
    finished_at: new Date().toISOString(),
    progress: { total: allFilesWithPaths.length, processed, failed },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyToken(req, res);
  if (!user) return;

  const { folderUrl, treeId } = req.body;
  if (!folderUrl) return res.status(400).json({ error: 'folderUrl is required' });
  if (!treeId) return res.status(400).json({ error: 'treeId is required. Create a family tree first.' });

  const jobId = await createSyncJob({ userId: user.uid, folderUrl, treeId });

  runSyncJob(jobId, folderUrl, user.uid, treeId).catch(async err => {
    console.error('❌ Sync failed:', err);
    await updateSyncJob(jobId, { status: 'failed', error: err.message, finished_at: new Date().toISOString() });
  });

  return res.status(202).json({ jobId, message: 'Sync started' });
}
