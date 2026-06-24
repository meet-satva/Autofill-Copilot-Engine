import crypto from 'crypto';

export function generateTreeId() {
  return crypto.randomUUID();
}

export function createEmptyVaultContainer(ownerId) {
  return { ownerId, activeTreeId: null, familyTrees: {} };
}

/** Migrate single-tree vault JSON to multi-tree shape */
export function migrateLegacyVault(vault) {
  if (!vault) return null;
  if (vault.familyTrees && typeof vault.familyTrees === 'object') return vault;

  const treeId = 'default';
  return {
    ownerId: vault.ownerId,
    activeTreeId: treeId,
    familyTrees: {
      [treeId]: {
        id: treeId,
        name: vault.familyTree?.primary ? `${vault.familyTree.primary}'s Family` : 'My Family',
        driveFolderUrl: null,
        createdAt: vault.lastSynced || new Date().toISOString(),
        lastSynced: vault.lastSynced || null,
        familyTree: vault.familyTree || {},
        profiles: vault.profiles || {},
        assets: vault.assets || {},
      },
    },
  };
}

export function buildProfilesFromFamilyTree(familyTree) {
  const profiles = {
    primary: {
      personalDetails: { fullName: familyTree.primary, name: familyTree.primary },
      identities: {},
      documents: [],
    },
  };
  if (familyTree.spouse) {
    profiles.spouse = {
      personalDetails: { fullName: familyTree.spouse, name: familyTree.spouse },
      identities: {},
      documents: [],
    };
  }
  if (familyTree.father) {
    profiles.father = {
      personalDetails: { fullName: familyTree.father, name: familyTree.father },
      identities: {},
      documents: [],
    };
  }
  if (familyTree.mother) {
    profiles.mother = {
      personalDetails: { fullName: familyTree.mother, name: familyTree.mother },
      identities: {},
      documents: [],
    };
  }
  if (familyTree.grandfather) {
    profiles.grandfather = {
      personalDetails: { fullName: familyTree.grandfather, name: familyTree.grandfather },
      identities: {},
      documents: [],
    };
  }
  if (familyTree.grandmother) {
    profiles.grandmother = {
      personalDetails: { fullName: familyTree.grandmother, name: familyTree.grandmother },
      identities: {},
      documents: [],
    };
  }
  (familyTree.children || []).forEach((child, idx) => {
    profiles[`children_${idx}`] = {
      personalDetails: { fullName: child, name: child },
      identities: {},
      documents: [],
    };
  });
  return profiles;
}

export function buildFamilyTreeFromWizardInput({
  treeName,
  primary,
  spouse,
  father,
  mother,
  grandfather,
  grandmother,
  children = [],
  driveFolderUrl,
}) {
  if (!primary?.trim()) {
    throw new Error('Primary user name is required');
  }

  const treeId = generateTreeId();
  const familyTree = {
    primary: primary.trim(),
    spouse: spouse?.trim() || null,
    father: father?.trim() || null,
    mother: mother?.trim() || null,
    grandfather: grandfather?.trim() || null,
    grandmother: grandmother?.trim() || null,
    children: (Array.isArray(children) ? children : [])
      .map((c) => (typeof c === 'string' ? c : c?.name || '').trim())
      .filter(Boolean),
  };

  return {
    id: treeId,
    name: treeName?.trim() || `${familyTree.primary}'s Family`,
    driveFolderUrl: driveFolderUrl?.trim() || null,
    createdAt: new Date().toISOString(),
    lastSynced: null,
    familyTree,
    profiles: buildProfilesFromFamilyTree(familyTree),
    assets: {},
  };
}

export function getTreeList(vault) {
  const v = migrateLegacyVault(vault);
  if (!v?.familyTrees) return [];
  return Object.values(v.familyTrees).map((t) => ({
    id: t.id,
    name: t.name,
    primary: t.familyTree?.primary || '',
    spouse: t.familyTree?.spouse || null,
    father: t.familyTree?.father || null,
    mother: t.familyTree?.mother || null,
    grandfather: t.familyTree?.grandfather || null,
    grandmother: t.familyTree?.grandmother || null,
    children: t.familyTree?.children || [],
    lastSynced: t.lastSynced || null,
    driveFolderUrl: t.driveFolderUrl || null,
  }));
}

export function resolveTreeVault(vault, treeId) {
  const container = migrateLegacyVault(vault);
  if (!container) return null;
  const id = treeId || container.activeTreeId;
  if (!id) return null;
  const tree = container.familyTrees?.[id];
  if (!tree) return null;
  return { container, treeId: id, tree };
}

export function buildAssignCandidates(familyTree) {
  if (!familyTree) return [];
  return [
    { profileKey: 'primary', names: [familyTree.primary] },
    { profileKey: 'spouse', names: [familyTree.spouse] },
    { profileKey: 'father', names: [familyTree.father] },
    { profileKey: 'mother', names: [familyTree.mother] },
    { profileKey: 'grandfather', names: [familyTree.grandfather] },
    { profileKey: 'grandmother', names: [familyTree.grandmother] },
    ...(familyTree.children || []).map((child, idx) => ({
      profileKey: `children_${idx}`,
      names: [child],
    })),
  ].filter((c) => c.names.some((n) => n && String(n).trim()));
}

const norm = (str) =>
  (str || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const GENERIC_FOLDER_NAMES = new Set([
  'documents', 'document', 'files', 'file', 'uploads', 'upload',
  'identity proofs', 'identity_proofs', 'proofs', 'attachments', 'scans',
  'images', 'photos', 'misc', 'other', 'unknown', 'data', 'drive',
  'folder', 'root', 'backup', 'my drive', 'shared', 'archive', 'temp', 'tmp', 'new folder',
]);

/** Folder names that are not real person names */
export function isGenericFolderName(name) {
  const n = norm(name);
  if (!n || n.length < 2) return true;
  if (GENERIC_FOLDER_NAMES.has(n)) return true;
  return /^(documents?|files?|uploads?|proofs?|attachments?|scans?|images?|photos?|misc|other|data|backup|archive|temp|tmp)s?$/.test(n);
}

const ROLE_FOLDER_ALIASES = {
  spouse: ['wife', 'husband', 'partner', 'spouse', 'wifes', 'husbands'],
  father: ['father', 'dad', 'papa', 'father name', 'dad name', 'parent'],
  mother: ['mother', 'mom', 'mama', 'mother name', 'mom name', 'parent'],
  grandfather: ['grandfather', 'grandpa', 'grand father', 'paternal grandfather'],
  grandmother: ['grandmother', 'grandma', 'grand mother', 'paternal grandmother'],
};

function matchRoleAliasFolder(name, familyTree) {
  const n = norm(name);
  if (!n || !familyTree) return null;
  for (const [profileKey, aliases] of Object.entries(ROLE_FOLDER_ALIASES)) {
    if (!familyTree[profileKey]) continue;
    if (aliases.some((alias) => n === alias || n.includes(alias) || alias.includes(n))) {
      return profileKey;
    }
  }
  return null;
}

export function extractPersonNameFromPath(pathParts) {
  if (!pathParts?.length) return 'unknown';

  const folderParts = pathParts.filter((p) => !/\.[a-z0-9]{2,5}$/i.test(p));

  const proofsFolderIdx = folderParts.findIndex((p) => {
    const lower = p.toLowerCase();
    return lower.includes('identity_proofs') || lower.includes('identity proofs');
  });

  if (proofsFolderIdx !== -1) {
    for (let i = proofsFolderIdx + 1; i < folderParts.length; i++) {
      const candidate = folderParts[i].toLowerCase().replace(/[_-]/g, ' ').trim();
      if (!isGenericFolderName(candidate)) return candidate;
    }
  }

  for (let i = folderParts.length - 1; i >= 0; i--) {
    const candidate = folderParts[i].toLowerCase().replace(/[_-]/g, ' ').trim();
    if (!isGenericFolderName(candidate) && !/^\d+$/.test(candidate) && candidate.length > 2) {
      return candidate;
    }
  }

  return 'unknown';
}

/** Match a folder/person name to a profile key using the family tree definition */
export function matchNameToProfileKey(name, familyTree) {
  const extractedName = norm(name);
  if (!extractedName || isGenericFolderName(extractedName) || !familyTree) return null;

  const roleAlias = matchRoleAliasFolder(extractedName, familyTree);
  if (roleAlias) return roleAlias;

  const candidates = buildAssignCandidates(familyTree);
  for (const candidate of candidates) {
    for (const candidateName of candidate.names) {
      const n = norm(candidateName);
      if (!n) continue;
      if (n === extractedName || extractedName.includes(n) || n.includes(extractedName)) {
        return candidate.profileKey;
      }
      const words = extractedName.split(' ').filter(Boolean);
      const cWords = n.split(' ').filter(Boolean);
      if (words.some((w) => cWords.includes(w)) && words.length >= 1) {
        return candidate.profileKey;
      }
    }
  }
  return null;
}

export function buildRelationshipPromptRules(familyTree) {
  if (!familyTree) return '';
  const lines = [];
  const p = familyTree.primary || 'the primary user';
  const s = familyTree.spouse;
  const f = familyTree.father;
  const m = familyTree.mother;
  const gf = familyTree.grandfather;
  const gm = familyTree.grandmother;
  const kids = familyTree.children || [];

  if (s) {
    lines.push(`- Wife, spouse, partner, and husband are the SAME person (${s}) — treat those labels identically.`);
    lines.push(`- If filling for ${s}: "Husband Name", "Spouse Name", or "Partner Name" fields should use ${p}'s data.`);
    lines.push(`- If filling for ${p}: "Spouse Name" or "Wife Name" fields should use ${s}'s data.`);
    lines.push(`- "Emergency Contact" should prefer ${s}'s data when available.`);
  }
  if (f) lines.push(`- Father is ${f} — use fatherName/male parent fields for this person, not grandfather.`);
  if (m) lines.push(`- Mother is ${m} — use motherName/female parent fields for this person, not grandmother.`);
  if (gm) lines.push(`- "Grandmother", "Grand Mother's Name" → use ${gm}`);
  if (gf) lines.push(`- "Grandfather", "Grand Father's Name" → use ${gf}`);
  lines.push('- "Father\'s Name", "Father Name" → use fatherName from identity documents (Aadhaar/PAN), NOT grandfather.');
  lines.push('- "Mother\'s Name", "Mother Name" → use motherName from identity documents, NOT grandmother.');
  lines.push('- "Middle Name" → middle part of the person\'s full name from identity docs — NOT the father\'s name.');
  if (kids.length) {
    lines.push(`- Child fields → use ${kids.join(', ')}`);
  }
  return lines.join('\n');
}

export function estimateAutofillTime(domSchema = [], options = {}) {
  const fields = domSchema.length || 0;
  const files = domSchema.filter((f) => (f.type || '').toLowerCase() === 'file').length;
  const segmented = domSchema.filter((f) => f.fieldType === 'segmented' || f.type === 'segmented').length;
  const llmPenalty = options.needsModel ? 8 : 0;
  const seconds = Math.max(3, Math.ceil(2 + fields * 0.4 + files * 4 + segmented * 0.6 + llmPenalty));
  return {
    seconds,
    label: formatEta(seconds),
  };
}

function formatEta(seconds) {
  if (seconds < 60) return `~${seconds} seconds`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `~${mins} min ${secs} sec` : `~${mins} min`;
}
