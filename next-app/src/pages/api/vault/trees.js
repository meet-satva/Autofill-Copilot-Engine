import { verifyToken } from '../auth/verify.js';
import { getVault, setVault } from '../../../db.js';
import { deepDecryptObject, deepEncryptObject } from '../../../lib/encryptionUtils.js';
import {
  migrateLegacyVault,
  buildFamilyTreeFromWizardInput,
  getTreeList,
  createEmptyVaultContainer,
} from '../../../lib/familyTreeUtils.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyToken(req, res);
  if (!user) return;

  let vault = await getVault(user.uid);
  if (!vault) vault = createEmptyVaultContainer(user.uid);
  vault = migrateLegacyVault(vault) || createEmptyVaultContainer(user.uid);
  vault.ownerId = user.uid;

  if (req.method === 'GET') {
    const trees = getTreeList(vault).map((t) => {
      const raw = vault.familyTrees[t.id];
      const profiles = raw?.profiles ? deepDecryptObject(raw.profiles) : {};
      const docCount = Object.values(profiles).reduce(
        (sum, p) => sum + Object.keys(p.identities || {}).length + (p.documents?.length || 0),
        0
      );
      return { ...t, documentCount: docCount };
    });
    return res.status(200).json({
      activeTreeId: vault.activeTreeId,
      trees,
    });
  }

  if (req.method === 'POST') {
    const { treeName, primary, spouse, father, mother, grandfather, grandmother, children, driveFolderUrl, setActive } = req.body;
    if (!primary?.trim()) {
      return res.status(400).json({ error: 'Primary user name is required' });
    }

    try {
      const tree = buildFamilyTreeFromWizardInput({
        treeName,
        primary,
        spouse,
        father,
        mother,
        grandfather,
        grandmother,
        children,
        driveFolderUrl,
      });

      vault.familyTrees[tree.id] = {
        ...tree,
        profiles: deepEncryptObject(tree.profiles),
        assets: deepEncryptObject(tree.assets),
      };
      if (setActive !== false) vault.activeTreeId = tree.id;

      await setVault(user.uid, vault);
      return res.status(201).json({
        message: 'Family tree created',
        treeId: tree.id,
        tree: getTreeList(vault).find((t) => t.id === tree.id),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (req.method === 'PUT') {
    const { treeId, treeName, primary, spouse, father, mother, grandfather, grandmother, children, driveFolderUrl, setActive } = req.body;
    if (!treeId || !vault.familyTrees[treeId]) {
      return res.status(404).json({ error: 'Family tree not found' });
    }

    const existing = vault.familyTrees[treeId];
    const profiles = deepDecryptObject(existing.profiles || {});
    const familyTree = {
      primary: primary?.trim() || existing.familyTree?.primary,
      spouse: spouse !== undefined ? (spouse?.trim() || null) : existing.familyTree?.spouse,
      father: father !== undefined ? (father?.trim() || null) : existing.familyTree?.father,
      mother: mother !== undefined ? (mother?.trim() || null) : existing.familyTree?.mother,
      grandfather: grandfather !== undefined ? (grandfather?.trim() || null) : existing.familyTree?.grandfather,
      grandmother: grandmother !== undefined ? (grandmother?.trim() || null) : existing.familyTree?.grandmother,
      children: children !== undefined
        ? (Array.isArray(children) ? children : []).map((c) => String(c).trim()).filter(Boolean)
        : existing.familyTree?.children || [],
    };

    const roleNames = {
      primary: familyTree.primary,
      spouse: familyTree.spouse,
      father: familyTree.father,
      mother: familyTree.mother,
      grandfather: familyTree.grandfather,
      grandmother: familyTree.grandmother,
    };
    for (const [key, name] of Object.entries(roleNames)) {
      if (name && profiles[key]) {
        profiles[key].personalDetails = { ...profiles[key].personalDetails, fullName: name, name };
      } else if (name && !profiles[key]) {
        profiles[key] = { personalDetails: { fullName: name, name }, identities: {}, documents: [] };
      }
    }
    familyTree.children.forEach((child, idx) => {
      const key = `children_${idx}`;
      if (!profiles[key]) profiles[key] = { personalDetails: {}, identities: {}, documents: [] };
      profiles[key].personalDetails = { ...profiles[key].personalDetails, fullName: child, name: child };
    });

    vault.familyTrees[treeId] = {
      ...existing,
      name: treeName?.trim() || existing.name,
      driveFolderUrl: driveFolderUrl !== undefined ? driveFolderUrl : existing.driveFolderUrl,
      familyTree,
      profiles: deepEncryptObject(profiles),
    };
    if (setActive) vault.activeTreeId = treeId;

    await setVault(user.uid, vault);
    return res.status(200).json({ message: 'Family tree updated', treeId });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
