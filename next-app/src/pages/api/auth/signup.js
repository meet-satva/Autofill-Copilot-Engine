import { signupUser } from './verify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const token = await signupUser(email, password);
  if (!token) {
    return res.status(409).json({ error: 'Account already exists' });
  }

  return res.status(201).json({ token });
}
