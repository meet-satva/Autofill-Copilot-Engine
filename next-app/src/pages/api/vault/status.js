import { verifyToken } from '../auth/verify.js';
import { getSyncJob } from '../../../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = await verifyToken(req, res);
  if (!user) return;

  const { jobId } = req.query;
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  const job = await getSyncJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Only allow the owner to see their job
  if (job.user_id !== user.uid) return res.status(403).json({ error: 'Forbidden' });

  return res.status(200).json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  });
}
