
const ORIENTATIONAL_SUFFIXES = [
  /[_-]front$/i,
  /[_-]back$/i,
  /[_-]page\d+$/i,
  /[_-]p\d+$/i,
  /[_-]\d+$/,
];

const DOCUMENT_TYPE_PATTERNS = [
  { type: 'aadhaar', patterns: [/aadhaar/i, /aadhar/i, /uid/i] },
  { type: 'pan', patterns: [/\bpan\b/i, /pan.?card/i] },
  { type: 'passport', patterns: [/passport/i] },
  { type: 'driving_licence', patterns: [/driving/i, /licence/i, /license/i, /dl[_-]/i] },
  { type: 'voter_id', patterns: [/voter/i, /epic/i] },
  { type: 'land_deed', patterns: [/deed/i, /index.?2/i, /registry/i, /property/i] },
  { type: 'ration_card', patterns: [/ration/i] },
];

function stripSuffix(name) {
  let base = name.replace(/\.[^.]+$/, ''); 
  for (const pattern of ORIENTATIONAL_SUFFIXES) {
    base = base.replace(pattern, '');
  }
  return base.toLowerCase().trim();
}

function detectDocumentType(filename) {
  const lower = filename.toLowerCase();
  for (const { type, patterns } of DOCUMENT_TYPE_PATTERNS) {
    if (patterns.some(p => p.test(lower))) return type;
  }
  return 'unknown';
}

function timeDeltaMinutes(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 60000;
}

export function groupDocuments(files) {
  const groups = [];
  const used = new Set();

  // Sort by modified time ascending
  const sorted = [...files].sort(
    (a, b) => new Date(a.modifiedTime) - new Date(b.modifiedTime)
  );

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(sorted[i].id)) continue;

    const baseI = stripSuffix(sorted[i].name);
    const typeI = detectDocumentType(sorted[i].name);
    const group = { files: [sorted[i]], documentType: typeI };
    used.add(sorted[i].id);

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(sorted[j].id)) continue;
      const baseJ = stripSuffix(sorted[j].name);
      const typeJ = detectDocumentType(sorted[j].name);

      const sameBase = baseI === baseJ || baseI.startsWith(baseJ) || baseJ.startsWith(baseI);
      const withinTimeWindow = timeDeltaMinutes(sorted[i].modifiedTime, sorted[j].modifiedTime) < 5;
      const sameType = typeI === typeJ && typeI !== 'unknown';

      if (sameBase || (withinTimeWindow && sameType)) {
        group.files.push(sorted[j]);
        used.add(sorted[j].id);
      }
    }

    groups.push(group);
  }

  return groups;
}