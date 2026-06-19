import { verifyToken } from '../auth/verify.js';
import { getVault } from '../../../db.js';
import { deepDecryptObject } from '../../../lib/encryptionUtils.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = await verifyToken(req, res);
  if (!user) return;

  const vault = await getVault(user.uid);
  if (!vault) return res.status(404).json({ error: 'Vault not found. Run a sync first.' });

  // Decrypt before sending to authenticated client
  const decrypted = {
    ...vault,
    profiles: deepDecryptObject(vault.profiles),
    assets: deepDecryptObject(vault.assets),
  };

  return res.status(200).json(decrypted);
}
