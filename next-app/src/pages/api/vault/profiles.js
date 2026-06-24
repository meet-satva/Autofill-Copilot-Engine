import { verifyToken } from '../auth/verify.js';
import { getVault } from '../../../db.js';
import { deepDecryptObject } from '../../../lib/encryptionUtils.js';
import { migrateLegacyVault, resolveTreeVault, getTreeList } from '../../../lib/familyTreeUtils.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = await verifyToken(req, res);
  if (!user) return;

  const rawVault = await getVault(user.uid);
  if (!rawVault) return res.status(404).json({ error: 'Vault not found. Create a family tree first.' });

  const container = migrateLegacyVault(rawVault);
  const treeId = req.query?.treeId || container.activeTreeId;
  const treeCtx = resolveTreeVault(container, treeId);

  if (!treeCtx) {
    return res.status(200).json({
      activeTreeId: container.activeTreeId,
      trees: getTreeList(container),
      error: 'No matching family tree',
    });
  }

  const decrypted = {
    treeId: treeCtx.treeId,
    treeName: treeCtx.tree.name,
    familyTree: treeCtx.tree.familyTree,
    profiles: deepDecryptObject(treeCtx.tree.profiles || {}),
    assets: deepDecryptObject(treeCtx.tree.assets || {}),
    lastSynced: treeCtx.tree.lastSynced,
    trees: getTreeList(container),
  };

  return res.status(200).json(decrypted);
}
