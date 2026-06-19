
import { GoogleGenerativeAI } from '@google/generative-ai';
import { verifyToken } from '../auth/verify.js';
import { createSyncJob, updateSyncJob, addIngestionFailure, addArchivedDocument, setVault } from '../../../db.js';
import { extractFolderId, listAllFiles, getDriveClient } from '../../../lib/driveClient.js';
import { deepEncryptObject } from "../../../lib/encryptionUtils.js";
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PARSE_PROMPTS = {
  aadhaar: `Extract from this Aadhaar card. Return ONLY valid JSON:
{
  "name": "full name",
  "dob": "DD/MM/YYYY",
  "gender": "Male|Female|Other",
  "aadhaarNumber": "XXXX XXXX XXXX",
  "address": "full address",
  "pincode": "6 digit or null"
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

  unknown: `Extract all readable information. Return ONLY valid JSON:
{
  "documentType": "best guess",
  "name": "or null",
  "dob": "or null",
  "idNumber": "or null",
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

async function renderPdfPagesAsImages(pdfBuffer, maxPages = 2) {
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
          console.warn(`    ⚠️  Unsupported: ${file.name} (${fetched.mimeType})`);
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

    // ✅ Build Gemini request
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const content = [
      {
        text: PARSE_PROMPTS[documentType] || PARSE_PROMPTS['unknown'],
      },
      // Add all images
      ...imageFiles.map(file => ({
        inlineData: {
          mimeType: file.mimeType,
          data: file.base64,
        },
      })),
      // Add extracted text
      ...(textParts.length > 0
        ? [
          {
            text: `\n\n--- Additional extracted text content ---\n${textParts.join('\n\n')}`,
          },
        ]
        : []),
    ];

    const response = await model.generateContent(content);
    const rawText = response.response.text();

    console.log(`    📝 Response: ${rawText.slice(0, 200)}`);

    const clean = rawText.replace(/```json|```/gi, '').trim();
    if (!clean) {
      return { error: 'EMPTY_RESPONSE', message: 'Model returned empty' };
    }

    try {
      return JSON.parse(clean);
    } catch {
      const jsonMatch = clean.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      return { error: 'JSON_PARSE_ERROR', message: clean.slice(0, 100) };
    }

  } catch (err) {
    console.error(`    ❌ Parse error:`, err.message);
    return { error: 'API_ERROR', message: err.message };
  }
}

// Assign to profile
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
  if (!extractedName) {
    console.warn('    ⚠️  No name in parsed data');
    return 'unknown';
  }

  const candidates = [
    { profileKey: 'primary', names: [norm(familyTree.primary)] },
    { profileKey: 'spouse', names: [norm(familyTree.spouse)] },
    { profileKey: 'mother', names: [norm(familyTree.mother)] },
    ...(familyTree.children || []).map((child, idx) => ({
      profileKey: `children_${idx}`,
      names: [norm(child)],
    })),
  ];

  // Exact match
  for (const candidate of candidates) {
    if (candidate.names.some(n => n === extractedName)) {
      console.log(`    ✅ Exact match → ${candidate.profileKey}`);
      return candidate.profileKey;
    }
  }

  // Fuzzy alias match, useful for files/folders that omit the last letter or use nickname variants.
  for (const candidate of candidates) {
    if (candidate.names.some(n => aliasMatches(n, extractedName))) {
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
  if (name.includes('aadhaar') || name.includes('aadhar')) return 'aadhaar';
  if (name.includes('pan')) return 'pan';
  if (name.includes('passport')) return 'passport';
  if (name.includes('driving') || name.includes('licence') || name.includes('license')) return 'driving_licence';
  if (name.includes('voter')) return 'voter_id';
  if (name.includes('land') || name.includes('deed') || name.includes('property')) return 'land_deed';
  return 'unknown';
}


function groupDocumentsByFolderStructure(allFilesWithPaths) {
  console.log('\n📊 Grouping documents...');
  const groups = {};

  for (const { file, folderPath } of allFilesWithPaths) {
    if (file.mimeType === 'application/vnd.google-apps.folder') continue;

    const pathParts = folderPath.split('/').filter(p => p);
    let personName = 'unknown';

    const proofsFolderIdx = pathParts.findIndex(p =>
      p.toLowerCase().includes('identity_proofs') || p.toLowerCase().includes('identity proofs')
    );

    if (proofsFolderIdx !== -1 && proofsFolderIdx + 1 < pathParts.length) {
      personName = pathParts[proofsFolderIdx + 1]
        .toLowerCase().replace(/[_-]/g, ' ').trim();
    } else if (pathParts.length >= 2) {
      const parentName = pathParts[pathParts.length - 2];
      if (!parentName.match(/^\d+$/) && parentName.length > 2) {
        personName = parentName.toLowerCase().replace(/[_-]/g, ' ').trim();
      }
    }

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

export async function runSyncJob(jobId, folderUrl, userId) {
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

  let groups;
  try {
    groups = groupDocumentsByFolderStructure(allFilesWithPaths);
  } catch (err) {
    await updateSyncJob(jobId, { status: 'failed', error: `Failed to group: ${err.message}` });
    return;
  }

  if (groups.length === 0) {
    await updateSyncJob(jobId, { status: 'failed', error: 'No document groups found' });
    return;
  }

  const vaultData = {
    ownerId: userId,
    lastSynced: new Date().toISOString(),
    familyTree: {
      primary: 'Chintan Jayantibhai Prajapati',
      spouse: 'Manisha Prajapati',
      children: ['Dhyana Prajapati'],
      mother: 'Geetaben',
    },
    profiles: {
      primary: { personalDetails: {}, identities: {}, documents: [] },
      spouse: { personalDetails: {}, identities: {}, documents: [] },
      children_0: { personalDetails: {}, identities: {}, documents: [] },
      mother: { personalDetails: {}, identities: {}, documents: [] },
    },
    assets: {},
  };

  let processed = 0;
  let failed = 0;

  const allParsedDocuments = [];

  for (const group of groups) {
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
          name: group.personName !== 'unknown' ? group.personName : null,
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

    const sourceName = parsedData.name || doc.personName || '';
    const profileKey = sourceName
      ? assignProfileOwner({ ...parsedData, name: sourceName }, vaultData.familyTree)
      : assignProfileOwner(parsedData, vaultData.familyTree);
    console.log(`  👤 Assigned "${sourceName || 'unknown'}" → ${profileKey}`);

    if (profileKey === 'unknown') {
      console.warn(`  ⚠️  Falling back to folder owner for unknown profile owner`);
      const fallbackKey = doc.personName
        ? assignProfileOwner({ ...parsedData, name: doc.personName }, vaultData.familyTree)
        : 'unknown';
      if (fallbackKey !== 'unknown') {
        if (vaultData.profiles[fallbackKey]) {
          vaultData.profiles[fallbackKey].documents.push({
            documentType,
            ...parsedData,
            name: sourceName || doc.personName || parsedData.name || null,
            driveFileIds: doc.files.map(f => f.id),
            driveFileNames: doc.files.map(f => f.name),
          });
        }
        await addArchivedDocument({
          userId,
          documentType,
          parsedData: deepEncryptObject(parsedData),
          driveFileIds: doc.files.map(f => f.id),
          driveFileNames: doc.files.map(f => f.name),
          status: 'processed_folder_fallback',
          determinedDate: null,
          dateSource: null,
        });
        continue;
      }
      
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
    
    // Prevent multiple unknown documents from overwriting each other by treating them as separate types
    const uniqueType = documentType === 'unknown' ? `unknown_${doc.files[0].id}` : documentType;
    if (!profilesAndDocs[profileKey][uniqueType]) {
      profilesAndDocs[profileKey][uniqueType] = [];
    }
    profilesAndDocs[profileKey][uniqueType].push(doc);
  }

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

  function normalizeIdentityRecord(docType, parsedData) {
    if (docType === 'aadhaar') {
      return {
        idNumber: parsedData.aadhaarNumber || parsedData.idNumber || null,
        address: parsedData.address || null,
        determinedDate: parsedData.determinedDate || null,
        dateSource: parsedData.dateSource || null,
        name: parsedData.name || null,
        dob: parsedData.dob || null,
        gender: parsedData.gender || null,
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
      const docType = uniqueType.startsWith('unknown_') ? 'unknown' : uniqueType;
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
        if (bestSourceName) {
          const parts = bestSourceName.split(' ');
          vaultData.profiles[profileKey].personalDetails.firstName = parts[0] || '';
          vaultData.profiles[profileKey].personalDetails.lastName = parts[parts.length - 1] || '';
          vaultData.profiles[profileKey].personalDetails.fullName = bestSourceName;
        }
        if (parsedData.dob) vaultData.profiles[profileKey].personalDetails.dob = parsedData.dob;
        if (parsedData.gender) vaultData.profiles[profileKey].personalDetails.gender = parsedData.gender;

        vaultData.profiles[profileKey].identities[docType] = {
          ...normalizeIdentityRecord(docType, { ...parsedData, name: bestSourceName }),
          driveFileIds: best.files.map(f => f.id),
          driveFileNames: best.files.map(f => f.name),
        };
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

  const encryptedVault = {
    ...vaultData,
    profiles: deepEncryptObject(vaultData.profiles),
    assets: deepEncryptObject(vaultData.assets),
  };

  await setVault(userId, encryptedVault);

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

  const { folderUrl } = req.body;
  if (!folderUrl) return res.status(400).json({ error: 'folderUrl is required' });

  const jobId = await createSyncJob({ userId: user.uid, folderUrl });

  runSyncJob(jobId, folderUrl, user.uid).catch(async err => {
    console.error('❌ Sync failed:', err);
    await updateSyncJob(jobId, { status: 'failed', error: err.message, finished_at: new Date().toISOString() });
  });

  return res.status(202).json({ jobId, message: 'Sync started' });
}
