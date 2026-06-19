
import { getSession, getUserByEmail, createSession, createUser } from '../../../db.js';
import { randomBytes, randomUUID } from 'crypto';

export async function verifyToken(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return null;
  }

  const token = authHeader.split('Bearer ')[1];

  const session = await getSession(token);
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session token' });
    return null;
  }

  return {
    uid: session.user_id,
    email: session.email,
    emailVerified: true,
    displayName: session.email.split('@')[0],
  };
}

export async function loginUser(email, password) {
  const user = await getUserByEmail(email);
  if (!user) return null;

 
  if (user.password !== password) return null;


  const token = randomBytes(32).toString('hex');
  await createSession({
    token,
    userId: user.id,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
  });

  return token;
}

export async function signupUser(email, password) {
  const existing = await getUserByEmail(email);
  if (existing) return null;

  const user = {
    id: randomUUID(),
    email,
    password,
  };

  await createUser(user);

  const token = randomBytes(32).toString('hex');
  await createSession({
    token,
    userId: user.id,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
  });

  return token;
}
