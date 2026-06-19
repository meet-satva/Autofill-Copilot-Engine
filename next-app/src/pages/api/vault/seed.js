// /api/vault/seed — Seeds the vault directly from provided text/JSON data
// This is used when Google Drive credentials are not yet configured.
// The client sends the parsed identity data directly in the request body.

import { verifyToken } from '../auth/verify.js';
import { setVault } from '../../../db.js';
import { deepEncryptObject } from '../../../lib/encryptionUtils.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const user = await verifyToken(req, res);
  if (!user) return;

  const { profiles, assets, familyTree } = req.body;

  if (!profiles) {
    return res.status(400).json({ error: 'profiles is required in request body' });
  }

  const vaultData = {
    ownerId: user.uid,
    lastSynced: new Date().toISOString(),
    familyTree: familyTree || {
      primary: 'Chintan Jayantibhai Prajapati',
      spouse: 'Manisha Prajapati',
      children: ['Dhyana Prajapati'],
      mother: 'Geetaben',
    },
    profiles: profiles || {},
    assets: assets || {},
  };

  // Encrypt sensitive fields before storing
  const encryptedVault = {
    ...vaultData,
    profiles: deepEncryptObject(vaultData.profiles),
    assets: deepEncryptObject(vaultData.assets),
  };

  await setVault(user.uid, encryptedVault);

  return res.status(200).json({
    message: 'Vault seeded successfully',
    userId: user.uid,
    profileCount: Object.keys(profiles).length,
  });
}
