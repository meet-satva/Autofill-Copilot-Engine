import { verifyToken } from '../auth/verify.js';
import { getVault } from '../../../db.js';
import { deepDecryptObject } from '../../../lib/encryptionUtils.js';
import OpenAI from 'openai';

let client = null;
function getOpenAIClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  client = new OpenAI({
    apiKey,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });
  return client;
}

const MAP_MODEL = 'meta/llama-3.1-70b-instruct';

const AUTOFILL_SYSTEM_PROMPT = `You are an intelligent form autofill engine for a personal identity vault.
You receive:
1. A structured vault containing personal profiles and asset data for a family
2. A user's natural language instruction (e.g. "Fill this for my wife Manisha")
3. A DOM schema of the current web page's form fields

Your task:
- Determine which family member is the subject of the form (the "applicant")
- Understand relational field labels (e.g. "Husband Name" on a form for a wife = use the primary user's name)
- Return ONLY a JSON array of field mappings — no explanation, no markdown

Output format:
[
  {
    "fieldId": "the_html_id_or_name",
    "fieldLabel": "human readable label",
    "fieldType": "text|select|file|textarea|radio|checkbox",
    "value": "value to inject or null",
    "documentKey": "for file fields only — see rules below",
    "confidence": "high|medium|low"
  }
]

Relationship rules:
- If filling for Manisha (wife): "Husband Name", "Spouse Name" fields → use Chintan's data
- If filling for Chintan: "Spouse Name", "Wife Name" fields → use Manisha's data
- "Emergency Contact" → use spouse's data
- "Mother's Name" → use Geetaben's name
- "Child Name" / "Son/Daughter Name" → use Dhyana's data

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE UPLOAD FIELD RULES (type="file")
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For any field with type="file", you MUST:
- Set fieldType to "file"
- Set value to null
- Determine documentKey by reading the field's labelText, placeholder, ariaLabel, and name/id

Use this mapping to pick documentKey:
  Label contains "aadhaar" / "aadhar" / "uid"          → documentKey: "aadhaar"
  Label contains "pan" / "pan card" / "income tax"      → documentKey: "pan"
  Label contains "passport"                              → documentKey: "passport"
  Label contains "voter" / "election card" / "epic"     → documentKey: "voterCard"
  Label contains "driving" / "licence" / "license" / "dl" → documentKey: "drivingLicense"
  Label contains "photo" / "photograph" / "selfie" / "picture" / "image" → documentKey: "photo"
  Label contains "resume" / "cv" / "curriculum vitae" / "upload your resume" → documentKey: "resume"
  Label contains "signature"                             → documentKey: "signature"
  Label contains "birth certificate" / "dob proof"      → documentKey: "birthCertificate"
  Label contains "address proof" / "residence proof"    → documentKey: "addressProof"
  Label contains "income proof" / "salary slip" / "itr" → documentKey: "incomeProof"
  Label contains "bank" / "passbook" / "cheque" / "statement" → documentKey: "bankDocument"
  Label contains "insurance"                             → documentKey: "insurance"
  Label contains "vehicle" / "rc book" / "registration certificate" → documentKey: "vehicleRC"

If the label is ambiguous (e.g. just "Upload Document" with no context):
  - Look at surrounding fields on the form for context clues
  - If still unclear, set documentKey to "aadhaar" as the most common ID document and confidence to "medium"
  - If completely unresolvable, set documentKey to null and confidence to "low"

For file fields, also check WHO the document belongs to:
  - If filling for Manisha → use Manisha's driveFileIds for that document type
  - The documentKey alone identifies the type; the profile is determined by the applicant

Return ONLY the JSON array.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const user = await verifyToken(req, res);
  if (!user) return;

  const { userInstruction, domSchema } = req.body;
  if (!userInstruction || !domSchema) {
    return res.status(400).json({ error: 'userInstruction and domSchema are required' });
  }

  const vault = await getVault(user.uid);
  if (!vault) {
    return res.status(404).json({ error: 'Vault not found. Please sync your documents first.' });
  }

  const decryptedVault = {
    ...vault,
    profiles: deepDecryptObject(vault.profiles),
    assets: deepDecryptObject(vault.assets),
  };

  // Keep the full decrypted vault for file ID lookup later
  // Only send sanitized (no driveFileIds) version to LLM
  const sanitizedVault = sanitizeVaultForLLM(decryptedVault);
  const autoMappings = buildAutoMappings(domSchema, decryptedVault, userInstruction);
  const needsModel = autoMappings.some(
    (m) => m.confidence === 'low' || (m.fieldType === 'file' && !m.documentKey)
  );

  let modelMappings = [];
  let mergedMappings = autoMappings;

  const userMessage = `
VAULT DATA:
${JSON.stringify(sanitizedVault, null, 2)}

USER INSTRUCTION:
"${userInstruction}"

FORM FIELDS (DOM Schema):
${JSON.stringify(domSchema, null, 2)}

IMPORTANT:
- If a question is a radio group or checkbox group, set \`fieldType\` to \`radio\` or \`checkbox\`.
- For radio/checkbox, set \`value\` to the exact visible option text to select.
- If the form asks for common personal details and the vault does not contain them, leave \`value\` null rather than guessing.

Return the field mapping JSON array now.`;

  try {
    const openaiClient = getOpenAIClient();
    let response = null;
    if (needsModel && openaiClient) {
      response = await openaiClient.chat.completions.create({
        model: MAP_MODEL,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: AUTOFILL_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      });
    }

    let clean = '';
    if (needsModel && response) {
      const rawText = response.choices[0]?.message?.content || '';
      clean = rawText.replace(/```json|```/g, '').trim();
    }

    function tryParseJson(text) {
      if (typeof text !== 'string') return null;
      const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
      const candidate = jsonMatch ? jsonMatch[1] : cleaned;
      try {
        return JSON.parse(candidate);
      } catch (_) {
        return null;
      }
    }

    if (needsModel && !clean) {
      return res.status(502).json({
        error: 'Mapping model returned an empty response',
        detail: `Model ${MAP_MODEL} returned no text.`,
      });
    }

    if (needsModel) {
      const mappings = tryParseJson(clean);
      modelMappings = Array.isArray(mappings) ? mappings : [];
      if (!Array.isArray(mappings)) {
        console.warn('Mapping model returned invalid JSON, using local heuristics only.', clean.slice(0, 400));
      }
      mergedMappings = mergeMappings(modelMappings, autoMappings);
    }

    // ── Enrich file-type mappings with actual Drive download URLs ──────────────
    // Uses the full decryptedVault (which still has driveFileIds) — NOT the sanitized one
    const enrichedMappings = mergedMappings.map((m) => {
      if (m.fieldType === 'file' && m.documentKey) {
        const fileInfo = resolveFileId(decryptedVault, m.documentKey, userInstruction, m.fieldLabel);
        if (fileInfo && fileInfo.driveFileId) {
          return {
            ...m,
            fileUrl: `https://drive.google.com/uc?export=download&id=${fileInfo.driveFileId}`,
            documentLink: fileInfo.documentLink || null,
            fileName: `${m.documentKey}.pdf`,
            mimeType: 'application/pdf',
          };
        }
      }
      return m;
    });

    for (const field of domSchema) {
      const inferred = inferCommonField(field, decryptedVault, userInstruction);
      const label = field.labelText || field.groupLabel || field.ariaLabel || field.name || field.id || '';
      const fieldType = (field.type || '').toLowerCase() === 'file' ? 'file' : 'text';
      const key = normalize(label || `${field.id || ''}|${field.name || ''}`);
      const existing = enrichedMappings.find((m) => normalize(m.fieldLabel || '') === key);

      if (existing) {
        if ((!existing.value || existing.confidence === 'low') && inferred) {
          existing.value = inferred;
          existing.confidence = 'high';
        }
        continue;
      }

      if (inferred) {
        enrichedMappings.push({
          fieldId: field.id || null,
          fieldName: field.name || null,
          fieldLabel: label,
          fieldType,
          value: inferred,
          documentKey: null,
          confidence: 'high',
        });
      }
    }

    const deduped = [];
    const seen = new Map();
    for (const m of enrichedMappings) {
      const key = normalize(m.fieldLabel || '') + '|' + normalize(m.fieldId || '') + '|' + normalize(m.fieldName || '');
      const score = (m.confidence === 'high' ? 3 : m.confidence === 'medium' ? 2 : 1) + (m.value !== null && m.value !== undefined ? 0.5 : 0);
      if (!seen.has(key) || seen.get(key).score < score) {
        seen.set(key, { score, item: m });
      }
    }
    for (const { item } of seen.values()) deduped.push(item);

    const successfulMappings = deduped.filter(
      (m) => m.confidence !== 'low' && (m.value !== null || m.fileUrl)
    );
    const failedFields = deduped.filter(
      (m) => m.confidence === 'low' || (m.value === null && !m.fileUrl)
    );

    return res.status(200).json({
      mappings: deduped,
      unmappedFields: failedFields,
      summary: {
        total: deduped.length,
        mapped: successfulMappings.length,
        unmapped: failedFields.length,
      },
    });
  } catch (err) {
    console.error('Autofill mapping failed:', err);
    return res.status(500).json({ error: 'Mapping failed', detail: err.message, model: MAP_MODEL });
  }
}

/**
 * Resolves which profile to look in based on the user's instruction,
 * then finds the driveFileId for the given documentKey.
 *
 * Vault structure assumed:
 *   vault.profiles.<profileKey>.identities.<docType>.driveFileIds: string[]
 *   vault.assets.<assetKey>.driveFileIds: string[]
 */
function resolveFileId(vault, documentKey, userInstruction, fieldLabel = '') {
  if (!documentKey) return null;

  const instruction = userInstruction.toLowerCase();
  const label = (fieldLabel || '').toLowerCase();
  const effectiveKey = (() => {
    if ((documentKey === 'photo' || documentKey === 'addressProof') && (label.includes('adhar') || label.includes('aadhar') || label.includes('aadhaar'))) {
      return 'aadhaar';
    }
    if (documentKey === 'resume') return 'resume';
    if (documentKey === 'voterCard') return 'voter_id';
    if (documentKey === 'drivingLicense') return 'driving_licence';
    return documentKey;
  })();

  // Determine target profile from instruction
  let targetProfileKey = null;
  for (const profileKey of Object.keys(vault.profiles || {})) {
    const name = vault.profiles[profileKey]?.personalDetails?.name?.toLowerCase() || '';
    if (instruction.includes(profileKey.toLowerCase()) || (name && instruction.includes(name))) {
      targetProfileKey = profileKey;
      break;
    }
  }

  // Helper: search identities and documents of a given profile
  const searchProfile = (profileKey) => {
    const identities = vault.profiles[profileKey]?.identities || {};
    for (const [idType, idData] of Object.entries(identities)) {
      if (idType.toLowerCase() === effectiveKey.toLowerCase() && idData.driveFileIds?.length) {
        return { driveFileId: idData.driveFileIds[0], documentLink: idData.documentLinks?.[0] };
      }
    }
    const documents = vault.profiles[profileKey]?.documents || [];
    for (const doc of documents) {
      if (doc.documentType?.toLowerCase() === effectiveKey.toLowerCase() && doc.driveFileIds?.length) {
        return { driveFileId: doc.driveFileIds[0], documentLink: doc.documentLinks?.[0] };
      }
    }
    return null;
  };

  // 1. Try target profile first
  if (targetProfileKey) {
    const found = searchProfile(targetProfileKey);
    if (found) return found;
  }

  // 2. Fallback: all profiles
  for (const profileKey of Object.keys(vault.profiles || {})) {
    const found = searchProfile(profileKey);
    if (found) return found;
  }

  // 3. Check assets
  for (const [assetKey, asset] of Object.entries(vault.assets || {})) {
    if (assetKey.toLowerCase() === effectiveKey.toLowerCase() && asset.driveFileIds?.length) {
      return { driveFileId: asset.driveFileIds[0], documentLink: asset.documentLinks?.[0] };
    }
  }

  if (effectiveKey === 'resume') {
    for (const profileKey of Object.keys(vault.profiles || {})) {
      const documents = vault.profiles[profileKey]?.documents || [];
      for (const doc of documents) {
        const text = normalize([doc.documentType, doc.name, ...(doc.driveFileNames || [])].filter(Boolean).join(' '));
        if (text.includes('resume') || text.includes('cv') || text.includes('curriculum vitae')) {
          return { driveFileId: doc.driveFileIds?.[0], documentLink: doc.documentLinks?.[0] };
        }
      }
    }
  }

  return null;
}

function sanitizeVaultForLLM(vault) {
  const clean = { familyTree: vault.familyTree, profiles: {}, assets: {} };

  /* eslint-disable no-unused-vars */
  for (const [key, profile] of Object.entries(vault.profiles || {})) {
    clean.profiles[key] = {
      personalDetails: profile.personalDetails || {},
      identities: {},
      documents: [],
    };
    for (const [idType, idData] of Object.entries(profile.identities || {})) {
      const { driveFileIds, driveFileNames, documentLinks, ...safeIdData } = idData;
      clean.profiles[key].identities[idType] = safeIdData;
    }
    for (const doc of (profile.documents || [])) {
      const { driveFileIds, driveFileNames, documentLinks, ...safeDocData } = doc;
      clean.profiles[key].documents.push(safeDocData);
    }
  }

  for (const [key, asset] of Object.entries(vault.assets || {})) {
    const { driveFileIds, driveFileNames, documentLinks, ...safeAsset } = asset;
    clean.assets[key] = safeAsset;
  }
  /* eslint-enable no-unused-vars */

  return clean;
}

function normalize(str) {
  const spaced = (str || '').toString()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return spaced.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getPrimaryProfile(vault) {
  const profiles = vault.profiles || {};
  const keys = Object.keys(profiles);
  if (keys.includes('primary')) return profiles.primary;
  if (keys.length > 0) return profiles[keys[0]];
  return null;
}

function splitNameParts(fullName) {
  const words = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { firstName: '', middleName: '', lastName: '' };
  if (words.length === 1) return { firstName: words[0], middleName: '', lastName: words[0] };
  if (words.length === 2) return { firstName: words[0], middleName: '', lastName: words[1] };
  // For 3+ words: first is firstName, last is lastName, everything in between is middleName
  return {
    firstName: words[0],
    middleName: words.slice(1, -1).join(' '),
    lastName: words[words.length - 1],
  };
}
function extractLastDigits(value, count) {
  if (!value || !count) return null;
  const digits = value.toString().replace(/\D/g, '');
  if (digits.length < count) return null;
  return digits.slice(-count);
}

function inferCommonField(field, vault, userInstruction) {
  const label = normalizeFieldText(field);
  const applicantProfileKey = getApplicantProfileKey(vault, userInstruction);
  const profile = getApplicantProfile(vault, userInstruction) || {};
  const otherProfile = getOtherProfile(vault, applicantProfileKey) || {};
  const familyTree = vault.familyTree || {};
  const pd = profile.personalDetails || {};
  const idDoc = profile.identities?.aadhaar || {};
  
  const fullName = pd.fullName || pd.name || [pd.firstName, pd.middleName, pd.lastName].filter(Boolean).join(' ') || '';
  const { firstName, middleName, lastName } = splitNameParts(fullName);
  
  let effectiveMiddleName = middleName;
  if (!effectiveMiddleName) {
    if (applicantProfileKey === 'primary' && familyTree.primary) {
      const { middleName: ftMiddleName } = splitNameParts(familyTree.primary);
      effectiveMiddleName = ftMiddleName;
    } else if (applicantProfileKey === 'spouse' && familyTree.spouse) {
      const { middleName: ftMiddleName } = splitNameParts(familyTree.spouse);
      effectiveMiddleName = ftMiddleName;
    }
  }

  const dob = pd.dob || idDoc.dob || null;
  const rawGender = (pd.gender || idDoc.gender || '').toLowerCase();
  const gender = rawGender.includes('female') ? 'female' : rawGender.includes('male') ? 'male' : rawGender;
  const aadhaarNumber = idDoc.aadhaarNumber || idDoc.idNumber || pd.aadhaarNumber || pd.idNumber || null;
  const nationalId = idDoc.idNumber || idDoc.aadhaarNumber || pd.idNumber || pd.aadhaarNumber || null;
  const address = idDoc.address || pd.address || null;
  let pincode = idDoc.pincode || pd.pincode || null;
  
 
  if (!pincode && address) {
    const pincodeMatch = address.match(/\b(\d{6})\b/); 
    if (pincodeMatch) {
      pincode = pincodeMatch[1];
    }
  }
  
  const email = pd.email || pd.emailAddress || profile.documents?.find((doc) => doc.otherDetails?.email)?.otherDetails.email || null;
  const phone = pd.phone || pd.phoneNumber || pd.mobile || null;
  const rawFieldText = normalize([field.id, field.name, field.labelText, field.placeholder, field.ariaLabel, field.ariaDescribedBy, field.groupLabel].filter(Boolean).join(' '));
  const lastDigitsMatch = label.match(/last\s*(\d+)|(?:(?:ending\s+in|ending\s+with)\s*)(\d+)|(?:\b(\d+)\s*digits?\b)/i);
  const lastDigitsCount = lastDigitsMatch ? Number(lastDigitsMatch[1] || lastDigitsMatch[2] || lastDigitsMatch[3]) : null;
  const lastDigitsAadhaar = lastDigitsCount ? extractLastDigits(aadhaarNumber || nationalId, lastDigitsCount) : null;
  const city = address ? address.split(/,|\n/).map((s) => s.trim()).filter(Boolean).slice(-2, -1)[0] || address.split(/,|\n/).map((s) => s.trim()).filter(Boolean)[0] : null;
  const state = address ? address.split(/,|\n/).map((s) => s.trim()).filter(Boolean).slice(-1)[0] : null;
  const otherName = otherProfile?.personalDetails?.fullName || otherProfile?.personalDetails?.name || [otherProfile?.personalDetails?.firstName, otherProfile?.personalDetails?.lastName].filter(Boolean).join(' ') || null;
  const spouseName = familyTree.spouse || otherName || vault.profiles?.spouse?.personalDetails?.fullName || vault.profiles?.spouse?.personalDetails?.name || null;
  const motherName = familyTree.mother || vault.profiles?.mother?.personalDetails?.fullName || vault.profiles?.mother?.personalDetails?.name || null;
  const emergencyContact = spouseName || motherName || null;
  let fatherName = null;
  if (familyTree.father) {
    fatherName = familyTree.father;
  } else if (vault.profiles?.father?.personalDetails?.fullName) {
    fatherName = vault.profiles.father.personalDetails.fullName;
  } else if (vault.profiles?.father?.personalDetails?.name) {
    fatherName = vault.profiles.father.personalDetails.name;
  } else if (familyTree.primary) {
    const { middleName: primaryMiddleName } = splitNameParts(familyTree.primary);
    fatherName = primaryMiddleName || null;
  }
  
  const childName = Array.isArray(familyTree.children) && familyTree.children.length ? familyTree.children[0] : vault.profiles?.children_0?.personalDetails?.fullName || vault.profiles?.children_0?.personalDetails?.name || null;

  if (/password|passcode|pin\b/.test(label) || field.type === 'password') return null;
  if (/declaration|consent|agree|confirm|checkbox.*legal/.test(label)) return null;

  if (lastDigitsAadhaar) return lastDigitsAadhaar;
  if (/last 4|last4|last-four|last four/.test(label)) return aadhaarNumber ? aadhaarNumber.toString().replace(/\D/g, '').slice(-4) : null;

  if (/aadhaar|aadhar|uidai|unique identification|uid\b/.test(label)) return aadhaarNumber || nationalId || null;
  if (/national id|identity number|id number/.test(label)) return nationalId || aadhaarNumber || null;

  if (/birth date|date of birth|dob|birthday/.test(label) || /dob|date/.test(rawFieldText)) return dob || null;

  if (/current.*address|residential address|home address|permanent.*address|registered.*address/.test(label)) return address || null;
  if (/permanent.*address.*line 1|permanent.*line 1/.test(label)) return address ? address.split(/,|\n/)[0]?.trim() : null;
  if (/permanent.*address.*line 2|permanent.*line 2/.test(label)) return address ? address.split(/,|\n/).slice(1).join(', ').trim() : null;
  if (/correspondence|mailing address|postal address/.test(label)) return address || null;

  if (/city\b/.test(label)) return city || null;
  if (/state|province|region/.test(label)) return state || null;
  if (/pin\s*\/\s*zip|zip\s*\/\s*pin|pin|zip|postal code/.test(label)) {
  if (pincode) return pincode.toString().replace(/\D/g, '');
  return null;
}
if (/emergency\s*contact\s*name|emergency\s*contact\b/.test(label) && !/phone|mobile|relation/.test(label)) {
  return emergencyContact;
}

if (/emergency\s*contact\s*phone|emergency\s*contact\s*mobile/.test(label)) {
  return phone || null;
}

if (/emergency\s*contact\s*relation|relationship\s*to\s*applicant/.test(label)) {
  return spouseName ? 'Spouse' : motherName ? 'Mother' : null;
}

if (/emergency\s*contact\s*member|emergency\s*member/.test(label)) {
  return emergencyContact;
}
  // Nationality
  if (/nationality/.test(label)) return address && address.toLowerCase().includes('india') ? 'Indian' : null;

  // Contact
  if (/phone|mobile|contact/.test(label)) return phone || null;
  if (/email/.test(label)) return email || null;

  // Name fields - be more specific
  if (/verified applicant|verified name|applicant name|applicant full name|full legal name|full name|surname and given name|complete name/.test(label)) return fullName || null;
  
  // Middle name - use effectiveMiddleName which includes fallback from familyTree
  if (/\bmiddle\s*name\b|\bmiddle\b/.test(label) && !/first|last|given|surname|family/.test(label)) return effectiveMiddleName || null;
  
  // First name
  if (/first\s*name|given name|forename|\bfirst\b/.test(label) && !/middle|last/.test(label)) return firstName || null;
  
  // Last name
  if (/last\s*name|surname|family\s*name|\blast\b/.test(label) && !/first|middle|given/.test(label)) return lastName || null;

  // Family relationships
  if (/\bspouse\b|\bhusband\b|\bwife\b|\bpartner\b/.test(label)) return spouseName || null;
  if (/emergency contact|emergency phone|emergency mobile/.test(label)) return spouseName || null;
  
  // Mother
  if (/\bmother\b|\bmom\b|\bmum\b|\bmama\b|\bma\b/.test(label) && !/father|grand|in-law/.test(label)) return motherName || null;
  if (/mother.?name|mother.?s name/.test(label)) return motherName || null;
  
  // Father - uses middle name from primary as fallback
  if (/\bfather\b|\bdad\b|\bpapa\b|\bpop\b/.test(label) && !/mother|grand|in-law/.test(label)) return fatherName || null;
  if (/father.?name|father.?s name|father.?s full name/.test(label)) return fatherName || null;
  
  // Child
  if (/\bchild\b|\bkid\b|\bson\b|\bdaughter\b|\bdependent\b/.test(label) && !/mother|father|parent|sibling|brother|sister/.test(label)) return childName || null;
  if (/child.?name|son.?name|daughter.?name|dependent.?name/.test(label)) return childName || null;

  // Gender
  if (/gender|sex/.test(label)) return gender || null;

  return null;
}

function normalizeFieldText(field) {
  return normalize([
    field.fieldLabel,
    field.labelText,
    field.groupLabel,
    field.optionLabel,
    field.ariaLabel,
    field.ariaDescribedBy,
    field.placeholder,
    field.name,
    field.id,
  ].filter(Boolean).join(' '));
}

function getApplicantProfileKey(vault, instruction) {
  const profiles = vault.profiles || {};
  const keys = Object.keys(profiles);
  const text = normalize(instruction);
  if (!text) return keys.includes('primary') ? 'primary' : keys[0] || null;
  for (const [key, profile] of Object.entries(profiles)) {
    const names = [
      profile.personalDetails?.fullName,
      profile.personalDetails?.name,
      profile.personalDetails?.firstName,
      profile.personalDetails?.lastName,
      key,
    ].filter(Boolean).map(normalize);
    if (names.some((name) => name && (text.includes(name) || name.includes(text)))) {
      return key;
    }
  }
  if (/(wife|spouse|partner|woman|she|her|manisha)/.test(text)) {
    return keys.find((k) => /spouse|wife|partner|woman/i.test(k)) || keys.find((k) => normalize(profiles[k]?.personalDetails?.fullName || '').includes('manisha')) || (keys.includes('spouse') ? 'spouse' : null);
  }
  if (/(husband|man|he|his|chintan|primary)/.test(text)) {
    return keys.find((k) => /primary|husband|man/i.test(k)) || keys.find((k) => normalize(profiles[k]?.personalDetails?.fullName || '').includes('chintan')) || (keys.includes('primary') ? 'primary' : null);
  }
  return keys.includes('primary') ? 'primary' : keys[0] || null;
}

function getApplicantProfile(vault, instruction) {
  const key = getApplicantProfileKey(vault, instruction);
  return key ? vault.profiles[key] : getPrimaryProfile(vault);
}

function getOtherProfile(vault, applicantKey) {
  const keys = Object.keys(vault.profiles || {});
  if (!applicantKey || keys.length <= 1) return null;
  if (applicantKey === 'primary') {
    const otherKey = keys.find((k) => k !== 'primary' && /spouse|wife|husband/.test(k));
    return otherKey ? vault.profiles[otherKey] : null;
  }
  const otherKey = keys.find((k) => k !== applicantKey);
  return otherKey ? vault.profiles[otherKey] : null;
}

function inferDocumentKey(field) {
  const label = normalizeFieldText(field);
  if (!label) return null;
  if (/aadhaar|aadhar|uidai|unique identification|uid\b/.test(label)) return 'aadhaar';
  if (/\bpan\b|pan card|income tax|tax id|taxpayer/.test(label)) return 'pan';
  if (/passport/.test(label)) return 'passport';
  if (/voter|election card|epic/.test(label)) return 'voterCard';
  if (/driving|licence|license|dl/.test(label)) return 'drivingLicense';
  if (/photo|photograph|selfie|picture|image/.test(label)) return 'photo';
  if (/resume|cv|curriculum vitae/.test(label)) return 'resume';
  if (/signature/.test(label)) return 'signature';
  if (/birth certificate|dob proof|date of birth proof/.test(label)) return 'birthCertificate';
  if (/address proof|residence proof|utility bill|rent agreement/.test(label)) return 'addressProof';
  if (/income proof|salary slip|itr|tax return/.test(label)) return 'incomeProof';
  if (/bank|passbook|cheque|statement|account proof/.test(label)) return 'bankDocument';
  if (/insurance/.test(label)) return 'insurance';
  if (/vehicle|rc book|registration certificate/.test(label)) return 'vehicleRC';
  return null;
}

function buildAutoMappings(domSchema, vault, userInstruction) {
  return domSchema.map((field) => {
    const label = normalizeFieldText(field);
    const normalizedType = (field.type || field.tagName || '').toLowerCase();
    const fieldType = normalizedType.includes('radio')
      ? 'radio'
      : normalizedType.includes('checkbox')
      ? 'checkbox'
      : normalizedType.includes('select')
      ? 'select'
      : (field.tagName || '').toLowerCase() === 'textarea'
      ? 'textarea'
      : normalizedType === 'file' || (field.tagName || '').toLowerCase() === 'input' && normalizedType === 'file'
      ? 'file'
      : 'text';
    const value = fieldType === 'file' ? null : inferCommonField(field, vault, userInstruction);
    const documentKey = fieldType === 'file' ? inferDocumentKey(field) : null;
    const confidence = fieldType === 'file'
      ? documentKey ? 'high' : 'low'
      : value !== null && value !== undefined && value !== ''
      ? 'high'
      : 'low';
    return {
      fieldId: field.id || null,
      fieldName: field.name || null,
      fieldLabel: label || field.id || field.name || '',
      fieldType,
      value,
      documentKey,
      confidence,
    };
  });
}

export { inferCommonField, splitNameParts, extractLastDigits, buildAutoMappings };

function mergeMappings(primary, fallback) {
  const merged = new Map();
  for (const mapping of primary) {
    const key = normalize([mapping.fieldId, mapping.fieldName, mapping.fieldLabel].filter(Boolean).join('|'));
    merged.set(key, mapping);
  }
  for (const mapping of fallback) {
    const key = normalize([mapping.fieldId, mapping.fieldName, mapping.fieldLabel].filter(Boolean).join('|'));
    const existing = merged.get(key);
    if (!existing || !existing.value) {
      merged.set(key, mapping);
    }
  }
  return Array.from(merged.values());
}
