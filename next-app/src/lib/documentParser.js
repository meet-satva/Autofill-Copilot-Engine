import { GoogleGenerativeAI } from '@google/generative-ai';
import { verifyToken } from '../pages/api/auth/verify.js';
import { createSyncJob, updateSyncJob, addArchivedDocument, setVault } from '../db.js';
import { extractFolderId, listAllFiles, getDriveClient } from './driveClient.js';
import { deepEncryptObject } from './encryptionUtils.js';
import sharp from 'sharp';
import { PDFParse } from 'pdf-parse';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PARSE_PROMPTS = {
  aadhaar: `Extract from this Aadhaar card. Return ONLY valid JSON, no explanation:
{
  "name": "full name on card",
  "dob": "DD/MM/YYYY",
  "gender": "Male|Female|Other",
  "aadhaarNumber": "XXXX XXXX XXXX",
  "address": "full address",
  "pincode": "6 digit pin or null"
}`,

  pan: `Extract from this PAN card. Return ONLY valid JSON, no explanation:
{
  "name": "full name on card",
  "fatherName": "father name or null",
  "dob": "DD/MM/YYYY",
  "panNumber": "10 char PAN"
}`,

  passport: `Extract from this passport. Return ONLY valid JSON, no explanation:
{
  "name": "full name",
  "dob": "DD/MM/YYYY",
  "gender": "Male|Female",
  "passportNumber": "passport number",
  "dateOfIssue": "DD/MM/YYYY",
  "dateOfExpiry": "DD/MM/YYYY",
  "placeOfIssue": "city or null",
  "nationality": "INDIAN",
  "fatherName": "null if not present",
  "motherName": "null if not present",
  "spouseName": "null if not present",
  "address": "null if not present"
}`,

  driving_licence: `Extract from this driving licence. Return ONLY valid JSON, no explanation:
{
  "name": "full name",
  "dob": "DD/MM/YYYY",
  "licenceNumber": "licence number",
  "dateOfIssue": "DD/MM/YYYY or null",
  "dateOfExpiry": "DD/MM/YYYY",
  "address": "full address or null",
  "vehicleClasses": ["LMV"]
}`,

  voter_id: `Extract from this Voter ID / EPIC card. Return ONLY valid JSON, no explanation:
{
  "name": "full name",
  "fatherOrHusbandName": "name or null",
  "dob": "DD/MM/YYYY or null",
  "gender": "Male|Female|Other",
  "epicNumber": "EPIC number",
  "address": "full address or null",
  "assemblyConstituency": "null if not present"
}`,

  land_deed: `Extract from this land deed / property registration document. Return ONLY valid JSON, no explanation:
{
  "registrationNumber": "document number",
  "registrationDate": "DD/MM/YYYY",
  "ownerName": "primary owner name",
  "coOwnerName": "null if not present",
  "propertyAddress": "full address",
  "surveyNumber": "null if not present",
  "area": "area with unit or null",
  "marketValue": "amount or null",
  "stampDuty": "amount or null",
  "subRegistrarOffice": "null if not present"
}`,

  unknown: `Extract all readable information from this document. Return ONLY valid JSON, no explanation:
{
  "documentType": "your best guess at document type",
  "name": "person name if found or null",
  "dob": "date of birth if found or null",
  "idNumber": "any ID or reference number or null",
  "dateOfIssue": "null if not found",
  "dateOfExpiry": "null if not found",
  "otherDetails": {}
}`,
};

// ── Fetch a Drive file as base64 ──────────────────────────────────────────────
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

  // Convert everything to JPEG — NVIDIA vision only reliably accepts JPEG
  if (exportMime !== 'application/pdf') {
    try {
      buffer = await sharp(buffer).jpeg({ quality: 95 }).toBuffer();
      finalMime = 'image/jpeg';
    } catch (sharpErr) {
      console.warn(`    ⚠️  sharp conversion failed for ${name}: ${sharpErr.message}`);
    }
  }

  // Resize if over 4MB
  let base64 = buffer.toString('base64');
  const sizeMB = (base64.length * 0.75) / (1024 * 1024);
  console.log(`    📏 ${name}: ${sizeMB.toFixed(2)} MB (${finalMime})`);

  if (sizeMB > 4 && finalMime === 'image/jpeg') {
    buffer = await sharp(buffer)
      .jpeg({ quality: 75 })
      .resize({ width: 1600, withoutEnlargement: true })
      .toBuffer();
    base64 = buffer.toString('base64');
    console.log(`    🗜️  Resized to: ${((base64.length * 0.75) / (1024 * 1024)).toFixed(2)} MB`);
  }

  return {
    base64,
    mimeType: finalMime,
    isImage: finalMime === 'image/jpeg',
    isPDF: finalMime === 'application/pdf',
    isText: finalMime === 'text/plain',
    name,
  };
}

async function extractPdfText(pdfBuffer) {
  try {
    const parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText();
    return (result?.text || '').trim() || null;
  } catch (err) {
    console.warn(`    ⚠️  PDF extraction failed: ${err.message}`);
    return null;
  }
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

function extractTxtText(buffer) {
  try {
    return buffer.toString('utf-8').trim() || null;
  } catch (err) {
    console.warn(`    ⚠️  Text extraction failed: ${err.message}`);
    return null;
  }
}

// ✅ CORRECT format for NVIDIA
// async function buildVisionContent(files, documentType) {
//   const content = [];

//   for (const file of files) {
//     try {
//       let imageData;

//       if (file.data instanceof Buffer) {
//         // If it's a Buffer (from file system)
//         imageData = file.data.toString('base64');
//       } else if (typeof file.data === 'string') {
//         // If it's already a URL or base64
//         if (file.data.startsWith('http')) {
//           content.push({
//             type: 'image_url',
//             image_url: { url: file.data },
//           });
//           continue;
//         }
//         imageData = file.data;
//       } else {
//         console.warn(`    ⚠️  Skipping ${file.name}: unsupported format`);
//         continue;
//       }

//       // Ensure proper MIME type
//       const mimeType = file.mimeType || 'image/jpeg';
//       const dataUrl = `data:${mimeType};base64,${imageData}`;

//       content.push({
//         type: 'image_url',
//         image_url: { 
//           url: dataUrl  // ✅ NVIDIA supports data URLs
//         },
//       });

//       console.log(`    ✅ Loaded ${file.name} (${file.mimeType})`);
//     } catch (e) {
//       console.error(`    ❌ Failed to process ${file.name}:`, e.message);
//     }
//   }

//   return content;
// }

export async function parseDocumentGroup(group) {
  const { personName, documentType, files } = group;

  console.log(`    🔍 parseDocumentGroup: ${personName || 'unknown'} / ${documentType} / ${files.length} file(s)`);

  try {
    const imageFiles = [];
    const textParts = [];

    // Process ALL file types
    for (const file of files) {
      try {
        const fetched = await fetchDriveFileAsBase64(file.id);

        if (fetched.isImage) {
          console.log(`    ✅ Image: ${file.name}`);
          imageFiles.push(fetched);
        } else if (fetched.isPDF) {
          console.log(`    📄 PDF: ${file.name}`);
          const pdfBuffer = Buffer.from(fetched.base64, 'base64');
          const text = await extractPdfText(pdfBuffer);
          if (text) {
            textParts.push(`[${file.name}]:\n${text}`);
          } else {
            console.log(`    🔄 PDF text empty or scanned; rendering pages as images`);
            const pageImages = await renderPdfPagesAsImages(pdfBuffer);
            pageImages.forEach((buffer, index) => {
              imageFiles.push({
                name: `${file.name} [page ${index + 1}]`,
                mimeType: 'image/jpeg',
                base64: buffer.toString('base64'),
                isImage: true,
              });
            });
          }
        } else if (fetched.isText || file.name.endsWith('.txt')) {
          console.log(`    📝 Text: ${file.name}`);
          const textBuffer = Buffer.from(fetched.base64, 'base64');
          const text = extractTxtText(textBuffer);
          if (text) {
            textParts.push(`[${file.name}]:\n${text}`);
          }
        }
      } catch (err) {
        console.error(`    ❌ Fetch failed ${file.name}:`, err.message);
      }
    }

    if (imageFiles.length === 0 && textParts.length === 0) {
      return { error: 'NO_CONTENT', message: 'No processable files found' };
    }

    console.log(`    📤 Sending: ${imageFiles.length} images + ${textParts.length} text sources`);

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // ✅ Enhanced prompt to extract family relationships
    const content = [
      {
        text: `Extract data from this ${documentType} document. Also identify family relationships.
Return ONLY valid JSON:
${PARSE_PROMPTS[documentType]}

IMPORTANT: If you see spouse name, father name, mother name, or children names mentioned, include them in the response.`,
      },
      ...imageFiles.map(file => ({
        inlineData: {
          mimeType: file.mimeType,
          data: file.base64,
        },
      })),
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

// ✅ Build family tree dynamically from parsed documents
export function buildFamilyTreeFromDocuments(parsedDocuments) {
  console.log('\n👨‍👩‍👧 Building family tree from documents...');

  const familyMembers = {};

  // Extract all unique names and relationships
  for (const { parsedData } of parsedDocuments) {
    if (!parsedData.name) continue;

    const name = parsedData.name.trim();

    // Add primary person
    if (!familyMembers[name]) {
      familyMembers[name] = {
        name,
        role: 'primary',
        details: parsedData,
      };
    }

    // Extract spouse
    if (parsedData.spouseName) {
      const spouseName = parsedData.spouseName.trim();
      if (!familyMembers[spouseName]) {
        familyMembers[spouseName] = {
          name: spouseName,
          role: 'spouse',
          details: {},
        };
      }
    }

    // Extract father
    if (parsedData.fatherName) {
      const fatherName = parsedData.fatherName.trim();
      if (!familyMembers[fatherName]) {
        familyMembers[fatherName] = {
          name: fatherName,
          role: 'father',
          details: {},
        };
      }
    }

    // Extract mother
    if (parsedData.motherName) {
      const motherName = parsedData.motherName.trim();
      if (!familyMembers[motherName]) {
        familyMembers[motherName] = {
          name: motherName,
          role: 'mother',
          details: {},
        };
      }
    }

    // Extract children
    if (parsedData.children && Array.isArray(parsedData.children)) {
      for (const child of parsedData.children) {
        const childName = child.trim();
        if (!familyMembers[childName]) {
          familyMembers[childName] = {
            name: childName,
            role: 'child',
            details: {},
          };
        }
      }
    }

    // Extract father or husband name (from voter ID, etc.)
    if (parsedData.fatherOrHusbandName) {
      const relName = parsedData.fatherOrHusbandName.trim();
      if (!familyMembers[relName]) {
        familyMembers[relName] = {
          name: relName,
          role: 'relative',
          details: {},
        };
      }
    }
  }

  // Determine primary member (most documents or mentioned first)
  let primaryMember = null;
  let primaryCount = 0;

  for (const [name] of Object.entries(familyMembers)) {
    const docCount = parsedDocuments.filter(d =>
      d.parsedData.name?.toLowerCase() === name.toLowerCase()
    ).length;

    if (docCount > primaryCount) {
      primaryCount = docCount;
      primaryMember = name;
    }
  }

  if (primaryMember) {
    familyMembers[primaryMember].role = 'primary';
  }

  // Build structured family tree
  const familyTree = {
    primary: primaryMember || 'Unknown',
    spouse: null,
    children: [],
    parents: [],
    siblings: [],
  };

  for (const [name, member] of Object.entries(familyMembers)) {
    if (member.role === 'primary') continue;

    if (member.role === 'spouse') {
      familyTree.spouse = name;
    }
    if (member.role === 'child') {
      familyTree.children.push(name);
    }
    if (member.role === 'mother' || member.role === 'father') {
      familyTree.parents.push(name);
    }
  }

  console.log(`✅ Family tree built:`);
  console.log(`   Primary: ${familyTree.primary}`);
  console.log(`   Spouse: ${familyTree.spouse || 'Not found'}`);
  console.log(`   Children: ${familyTree.children.join(', ') || 'None'}`);
  console.log(`   Parents: ${familyTree.parents.join(', ') || 'None'}`);

  return { familyTree, familyMembers };
}


// ✅ Assign document to correct family member dynamically
export function assignProfileOwner(parsedData, familyMembers) {
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
    return { profileKey: 'unknown', member: null };
  }

  // Find exact match in family members
  for (const [name, member] of Object.entries(familyMembers)) {
    if (norm(name) === extractedName) {
      console.log(`    ✅ Found: ${member.role} → ${name}`);
      return { profileKey: name.toLowerCase().replace(/\s+/g, '_'), member };
    }
  }

  for (const [name, member] of Object.entries(familyMembers)) {
    if (aliasMatches(name, extractedName)) {
      console.log(`    ✅ Alias match: ${member.role} → ${name}`);
      return { profileKey: name.toLowerCase().replace(/\s+/g, '_'), member };
    }
  }

  // Fuzzy match (partial name match)
  const extractedWords = extractedName.split(' ').filter(Boolean);
  for (const [name, member] of Object.entries(familyMembers)) {
    const nameWords = norm(name).split(' ').filter(Boolean);
    if (extractedWords.some(w => nameWords.includes(w))) {
      console.log(`    ✅ Fuzzy match: ${member.role} → ${name}`);
      return { profileKey: name.toLowerCase().replace(/\s+/g, '_'), member };
    }
  }

  let best = { profileKey: 'unknown', member: null, score: 0 };
  for (const [name, member] of Object.entries(familyMembers)) {
    const score = similarity(extractedName, name);
    if (score > best.score) {
      best = { profileKey: name.toLowerCase().replace(/\s+/g, '_'), member, score };
    }
  }

  if (best.score >= 0.72 && best.member) {
    console.log(`    ✅ Fuzzy similarity match (${best.score.toFixed(2)}): → ${best.profileKey}`);
    return { profileKey: best.profileKey, member: best.member };
  }

  console.warn(`    ❌ No match for: "${parsedData.name}"`);
  return { profileKey: 'unknown', member: null };
}
// ── Everything below is unchanged from your original ─────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyToken(req, res);
  if (!user) return;

  const { folderUrl } = req.body;
  if (!folderUrl) return res.status(400).json({ error: 'folderUrl is required' });

  const jobId = await createSyncJob({ userId: user.uid, folderUrl });

  runSyncJob(jobId, folderUrl, user.uid).catch(async err => {
    console.error('❌ Sync job failed:', err);
    await updateSyncJob(jobId, { status: 'failed', error: err.message, finished_at: new Date().toISOString() });
  });

  return res.status(202).json({ jobId, message: 'Sync started' });
}

function detectDocumentType(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('aadhaar') || name.includes('aadhar')) return 'aadhaar';
  if (name.includes('pan')) return 'pan';
  if (name.includes('passport')) return 'passport';
  if (name.includes('driving') || name.includes('license') || name.includes('licence')) return 'driving_licence';
  if (name.includes('voter')) return 'voter_id';
  if (name.includes('land') || name.includes('deed') || name.includes('index')) return 'land_deed';
  if (name.includes('property') || name.includes('registration')) return 'land_deed';
  return 'unknown';
}

function buildFileMap(allFiles) {
  const map = {};
  for (const file of allFiles) map[file.id] = file;
  return map;
}

function buildFullPath(file, fileMap, rootFolderId) {
  const parts = [];
  let current = file;
  while (current) {
    parts.unshift(current.name);
    const parentId = current.parents?.[0];
    if (!parentId || parentId === rootFolderId || !fileMap[parentId]) break;
    current = fileMap[parentId];
  }
  return parts.join('/');
}

function groupDocumentsByFolderStructure(allFilesWithPaths) {
  console.log('\n📊 ALL RAW FILE PATHS:');
  allFilesWithPaths.forEach(({ file, folderPath }) => {
    if (file.mimeType !== 'application/vnd.google-apps.folder') {
      const parts = folderPath.split('/').filter(p => p);
      console.log(`   PATH: "${folderPath}"`);
      console.log(`   PARTS[${parts.length}]: ${JSON.stringify(parts)}`);
    }
  });

  const groups = {};

  for (const { file, folderPath } of allFilesWithPaths) {
    if (file.mimeType === 'application/vnd.google-apps.folder') continue;

    const pathParts = folderPath.split('/').filter(p => p);
    console.log(`\n📁 File path: ${folderPath}`);
    console.log(`   Path parts: ${JSON.stringify(pathParts)}`);

    let personName = 'unknown';

    const proofsFolderIdx = pathParts.findIndex(p =>
      p.toLowerCase().includes('identity_proofs') || p.toLowerCase() === 'identity proofs'
    );

    if (proofsFolderIdx !== -1 && proofsFolderIdx + 1 < pathParts.length) {
      personName = pathParts[proofsFolderIdx + 1]
        .toLowerCase()
        .replace(/[_-]/g, ' ')
        .trim();
      console.log(`   ✅ Extracted person: "${personName}"`);
    } else {
      console.warn(`   ⚠️  Could not find Identity_Proofs in path: ${folderPath}`);
    }

    // Document type: detect from filename first, then parent folder name
    const detectedType = detectDocumentType(file.name);
    const documentType = detectedType === 'unknown' && pathParts.length >= 2
      ? detectDocumentType(pathParts[pathParts.length - 2])
      : detectedType;

    console.log(`   📄 Document type: ${documentType}`);

    // Group front + back of same doc together under same key, but split unknown docs
    const groupKey = documentType === 'unknown'
      ? `${personName}__${documentType}__${file.id}`
      : `${personName}__${documentType}`;
    if (!groups[groupKey]) groups[groupKey] = { personName, documentType, files: [] };
    groups[groupKey].files.push(file);
  }

  const groupArray = Object.values(groups);
  console.log(`\n✅ Created ${groupArray.length} document groups`);
  groupArray.forEach((g, idx) => {
    console.log(`   Group ${idx + 1}: "${g.personName}" - ${g.documentType} (${g.files.length} files)`);
    if (!g.personName || g.personName === 'unknown') {
      console.warn(`   ⚠️  WARNING: Person name is empty/unknown!`);
    }
  });
  return groupArray;
}

// ✅ Updated main sync function
async function runSyncJob(jobId, folderUrl, userId) {
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
    const fileMap = buildFileMap(allFiles);
    for (const file of allFiles) {
      allFilesWithPaths.push({ file, folderPath: buildFullPath(file, fileMap, folderId) });
    }
  } catch (err) {
    await updateSyncJob(jobId, { status: 'failed', error: `Failed to list files: ${err.message}` });
    return;
  }

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

  await updateSyncJob(jobId, { progress: { total: allFilesWithPaths.length, processed: 0, failed: 0 } });

  const allParsedDocuments = [];
  let processed = 0;
  let failed = 0;

  // ✅ Build family tree from parsed documents
  const { familyTree, familyMembers } = buildFamilyTreeFromDocuments(
    allParsedDocuments.map(d => ({ parsedData: d.parsedData }))
  );

  // ✅ Initialize vault with dynamic family tree
  const vaultData = {
    ownerId: userId,
    lastSynced: new Date().toISOString(),
    familyTree,
    profiles: {},
    assets: {},
  };

  // Create profile entries for each family member
  for (const [name, member] of Object.entries(familyMembers)) {
    const profileKey = name.toLowerCase().replace(/\s+/g, '_');
    vaultData.profiles[profileKey] = {
      personalDetails: {},
      identities: {},
      documents: [],
      role: member.role,
      displayName: name,
    };
  }

// ✅ Assign documents to family members
   for (const { docType, parsedData, files } of allParsedDocuments) {
    const { profileKey } = assignProfileOwner(parsedData, familyMembers);

    const links = files
      .filter(f => f.mimeType !== 'text/plain' && !f.name.endsWith('.txt'))
      .map(f => f.webViewLink)
      .filter(Boolean);
    if (links.length > 0) parsedData.documentLinks = links;

    if (profileKey === 'unknown') {
      await addArchivedDocument({
        userId,
        documentType: docType,
        parsedData: deepEncryptObject(parsedData),
        driveFileIds: files.map(f => f.id),
        driveFileNames: files.map(f => f.name),
        status: 'archived_unknown_owner',
        determinedDate: null,
        dateSource: null,
      });
      continue;
    }

    const isIdentityDoc = ['aadhaar', 'pan', 'passport', 'driving_licence', 'voter_id'].includes(docType);

    if (isIdentityDoc && vaultData.profiles[profileKey]) {
      if (parsedData.name) {
        const parts = parsedData.name.split(' ').filter(Boolean);
        const middleName = parts.length > 2 ? parts.slice(1, -1).join(' ') : '';
        vaultData.profiles[profileKey].personalDetails.firstName = parts[0] || '';
        vaultData.profiles[profileKey].personalDetails.middleName = middleName;
        vaultData.profiles[profileKey].personalDetails.lastName = parts[parts.length - 1] || '';
        vaultData.profiles[profileKey].personalDetails.fullName = parsedData.name;
      }
      if (parsedData.dob) vaultData.profiles[profileKey].personalDetails.dob = parsedData.dob;
      if (parsedData.gender) vaultData.profiles[profileKey].personalDetails.gender = parsedData.gender;

      vaultData.profiles[profileKey].identities[docType] = {
        ...parsedData,
        driveFileIds: files.map(f => f.id),
        driveFileNames: files.map(f => f.name),
      };
    } else if (docType === 'land_deed') {
      const assetKey = `asset_${parsedData.registrationNumber || Date.now()}`;
      vaultData.assets[assetKey] = {
        ...parsedData,
        driveFileIds: files.map(f => f.id),
        driveFileNames: files.map(f => f.name),
      };
    } else if (vaultData.profiles[profileKey]) {
      // Store ALL other documents in the documents array
      vaultData.profiles[profileKey].documents.push({
        documentType: docType,
        ...parsedData,
        driveFileIds: files.map(f => f.id),
        driveFileNames: files.map(f => f.name),
      });
    }
  }

  // ✅ Encrypt and store
  const encryptedVault = {
    ...vaultData,
    profiles: deepEncryptObject(vaultData.profiles),
    assets: deepEncryptObject(vaultData.assets),
    familyTree: deepEncryptObject(vaultData.familyTree),
  };

  await setVault(userId, encryptedVault);

  console.log(`\n✅ COMPLETED - Processed: ${processed}, Failed: ${failed}`);

  await updateSyncJob(jobId, {
    status: 'completed',
    finished_at: new Date().toISOString(),
    progress: { total: allFilesWithPaths.length, processed, failed },
  });
}

// export default async function handler(req, res) {
//   if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

//   const user = await verifyFirebaseToken(req, res);
//   if (!user) return;

//   const { folderUrl } = req.body;
//   if (!folderUrl) return res.status(400).json({ error: 'folderUrl is required' });

//   const jobId = await createSyncJob({ userId: user.uid, folderUrl });

//   runSyncJob(jobId, folderUrl, user.uid).catch(async err => {
//     console.error('❌ Sync failed:', err);
//     await updateSyncJob(jobId, { status: 'failed', error: err.message, finished_at: new Date().toISOString() });
//   });

//   return res.status(202).json({ jobId, message: 'Sync started' });
// }
