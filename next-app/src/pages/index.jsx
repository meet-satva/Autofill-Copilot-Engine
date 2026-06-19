import { useState, useEffect, useCallback } from 'react';

const BACKEND_URL = 'http://localhost:3000';


export default function AdminDashboard() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [folderUrl, setFolderUrl] = useState('');
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [vault, setVault] = useState(null);
  const [failures, setFailures] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const loadVault = useCallback(async (token) => {
    try {
      const res = await fetch('/api/vault/profiles', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setVault(data);
    } catch (err) {
      setMessage('Failed to load vault: ' + err.message);
    }
  }, []);

  useEffect(() => {
    const storedToken = window.localStorage.getItem('identity_vault_token');
    const storedEmail = window.localStorage.getItem('identity_vault_email');
    if (storedToken && storedEmail) {
      setToken(storedToken);
      setUser({ email: storedEmail });
    }
  }, []);

  // Poll job status
  useEffect(() => {
    if (!jobId || !token) return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/vault/status?jobId=${jobId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setJobStatus(data);
      if (data.failures) setFailures(data.failures);
      if (data.status === 'completed' || data.status === 'failed') {
        clearInterval(interval);
        if (data.status === 'completed') loadVault(token);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [jobId, token, loadVault]);

  async function handleLogin(e) {
    e.preventDefault();
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      window.localStorage.setItem('identity_vault_token', data.token);
      window.localStorage.setItem('identity_vault_email', email);
      setToken(data.token);
      setUser({ email });
    } catch (err) {
      setMessage('Login failed: ' + err.message);
    }
  }

  async function handleSignup() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      window.localStorage.setItem('identity_vault_token', data.token);
      window.localStorage.setItem('identity_vault_email', email);
      setToken(data.token);
      setUser({ email });
      setMessage('Account created and signed in.');
    } catch (err) {
      setMessage('Signup failed: ' + err.message);
    }
  }

  async function handleSync() {
    if (!folderUrl) return setMessage('Please enter a Google Drive folder URL');
    setLoading(true);
    setMessage('');
    setJobStatus(null);
    setFailures([]);
    try {
      const res = await fetch('/api/vault/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ folderUrl }),
      });
      const data = await res.json();
      if (data.jobId) {
        setJobId(data.jobId);
        setMessage('Sync started. Processing documents...');
      } else {
        setMessage('Error: ' + JSON.stringify(data));
      }
    } catch (err) {
      setMessage('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }



  if (!user) {
    return (
      <div style={{ maxWidth: 400, margin: '80px auto', fontFamily: 'sans-serif', padding: 24 }}>
        <h2>Identity Vault — Admin</h2>
        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: 12 }}>
            <label>Email<br />
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                style={{ width: '100%', padding: 8, marginTop: 4 }} />
            </label>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label>Password<br />
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                style={{ width: '100%', padding: 8, marginTop: 4 }} />
            </label>
          </div>
          <button type="submit" style={{ padding: '8px 24px', marginRight: 8 }}>Sign In</button>
          <button type="button" onClick={handleSignup} style={{ padding: '8px 24px' }}>Sign Up</button>
          {message && <p style={{ color: 'red', marginTop: 12 }}>{message}</p>}
        </form>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', fontFamily: 'sans-serif', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Identity Vault</h2>
        <button onClick={() => {
          window.localStorage.removeItem('identity_vault_token');
          window.localStorage.removeItem('identity_vault_email');
          setUser(null);
          setToken('');
        }}>Sign Out</button>
      </div>

      <div style={{ background: '#f5f5f5', borderRadius: 8, padding: 20, marginBottom: 24 }}>
        <h3 style={{ marginTop: 0 }}>Sync Google Drive Vault</h3>
        <div style={{ display: 'flex', gap: 12 }}>
          <input
            type="text"
            placeholder="Paste Google Drive folder URL here"
            value={folderUrl}
            onChange={e => setFolderUrl(e.target.value)}
            style={{ flex: 1, padding: 10, borderRadius: 4, border: '1px solid #ddd' }}
          />
          <button onClick={handleSync} disabled={loading}
            style={{ padding: '10px 20px', background: '#1a73e8', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
            {loading ? 'Starting...' : 'Sync & Reparse Vault'}
          </button>
        </div>
        {message && <p style={{ marginTop: 12, color: '#555' }}>{message}</p>}
      </div>

      {jobStatus && (
        <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: 20, marginBottom: 24 }}>
          <h3 style={{ marginTop: 0 }}>Sync Progress</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            {[
              ['Status', jobStatus.status],
              ['Total Files', jobStatus.progress?.total || 0],
              ['Processed', jobStatus.progress?.processed || 0],
              ['Failed', jobStatus.progress?.failed || 0],
            ].map(([label, value]) => (
              <div key={label} style={{ background: '#f8f9fa', borderRadius: 6, padding: 12, textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{label}</div>
                <div style={{ fontWeight: 600, fontSize: 18 }}>{value}</div>
              </div>
            ))}
          </div>

          {failures.length > 0 && (
            <div>
              <h4 style={{ color: '#d93025' }}>Ingestion Failures</h4>
              {failures.map((f, i) => (
                <div key={i} style={{ background: '#fce8e6', borderRadius: 4, padding: 10, marginBottom: 8, fontSize: 13 }}>
                  <strong>Status:</strong> Ingestion Failed - Visual Clarity Check Required<br />
                  <strong>Files:</strong> {f.files?.join(', ')}<br />
                  <strong>Error:</strong> {f.error}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {vault && (
        <div>
          <h3>Vault Contents</h3>
          {Object.entries(vault.profiles || {}).map(([key, profile]) => (
            <div key={key} style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: 20, marginBottom: 16 }}>
              <h4 style={{ marginTop: 0, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <strong>Personal Details</strong>
                  <pre style={{ background: '#f5f5f5', padding: 10, borderRadius: 4, fontSize: 12, overflow: 'auto' }}>
                    {JSON.stringify(profile.personalDetails, null, 2)}
                  </pre>
                </div>
                <div>
                  <strong>Identities</strong>
                  <pre style={{ background: '#f5f5f5', padding: 10, borderRadius: 4, fontSize: 12, overflow: 'auto' }}>
                    {JSON.stringify(profile.identities, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          ))}
          {Object.keys(vault.assets || {}).length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: 20 }}>
              <h4 style={{ marginTop: 0 }}>Assets</h4>
              <pre style={{ background: '#f5f5f5', padding: 10, borderRadius: 4, fontSize: 12, overflow: 'auto' }}>
                {JSON.stringify(vault.assets, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
