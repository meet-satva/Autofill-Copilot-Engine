const DEFAULT_BACKEND_URL = 'http://localhost:3000';

// Simple backend auth using the Next.js API (Postgres-backed sessions)
let authToken = null;

async function getValidToken() {
  const stored = await chrome.storage.local.get(['sessionToken']);
  if (!stored.sessionToken) return null;
  authToken = stored.sessionToken;
  return authToken;
}

function getBackendUrl() {
  return DEFAULT_BACKEND_URL.replace(/\/$/, '');
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  const candidate = jsonMatch ? jsonMatch[1] : cleaned;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    return null;
  }
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text.trim()) return {};
  const parsed = tryParseJson(text);
  if (parsed !== null) return parsed;
  throw new Error(`Unexpected response from server: ${text.slice(0, 200)}`);
}

function withTimeout(promise, ms, errorMessage) {
  const timeout = new Promise((_, reject) => {
    const id = setTimeout(() => reject(new Error(errorMessage)), ms);
    Promise.resolve(promise).finally(() => clearTimeout(id));
  });
  return Promise.race([promise, timeout]);
}

function sendChromeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// DOM helpers
const $ = id => document.getElementById(id);
const loginScreen = $('login-screen');
const mainScreen = $('main-screen');
const chatHistory = $('chat-history');
const chatInput = $('chat-input');

// Restore saved folder URL
chrome.storage.local.get(['syncFolderUrl'], (s) => {
  if (s.syncFolderUrl) $('sync-folder-url').value = s.syncFolderUrl;
});

function showScreen(name) {
  loginScreen.classList.toggle('hidden', name !== 'login');
  mainScreen.classList.toggle('hidden', name !== 'main');
}

function appendMessage(role, html) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = html;
  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function setStatus(text, ok = true) {
  $('auth-status').textContent = text;
  $('auth-status').style.color = ok ? '#1a73e8' : '#d93025';
}

// Init — check for stored auth
(async () => {
  const token = await getValidToken();
  if (token) {
    showScreen('main');
    setStatus('Vault connected', true);
  } else {
    showScreen('login');
  }
})();

// Login handler
$('btn-login').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  $('login-error').textContent = '';
  $('btn-login').textContent = 'Signing in...';

  try {
    const res = await fetch(`${getBackendUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await readJsonResponse(res);
    if (!res.ok) throw new Error(data.error || 'Login failed');
    authToken = data.token;
    await chrome.storage.local.set({ sessionToken: data.token });
    showScreen('main');
    setStatus('Vault connected', true);
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    $('btn-login').textContent = 'Sign In';
  }
});

$('btn-signup').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  $('login-error').textContent = '';
  $('btn-signup').textContent = 'Creating...';

  try {
    const res = await fetch(`${getBackendUrl()}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await readJsonResponse(res);
    if (!res.ok) throw new Error(data.error || 'Signup failed');
    authToken = data.token;
    await chrome.storage.local.set({ sessionToken: data.token });
    showScreen('main');
    setStatus('Vault connected', true);
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    $('btn-signup').textContent = 'Create Account';
  }
});

// Sync panel toggle
$('btn-sync-toggle').addEventListener('click', () => {
  const body = $('sync-body');
  const chevron = $('sync-chevron');
  const isHidden = body.classList.toggle('hidden');
  chevron.textContent = isHidden ? '▼' : '▲';
});

// Tab switching
document.querySelectorAll('.sync-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sync-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('panel-seed').classList.toggle('hidden', tab.dataset.tab !== 'seed');
    $('panel-drive').classList.toggle('hidden', tab.dataset.tab !== 'drive');
  });
});

// ── Quick Seed handler ────────────────────────────────────────────────────────
$('btn-seed').addEventListener('click', async () => {
  const rawText = $('seed-data').value.trim();
  const statusEl = $('seed-status');

  if (!rawText) {
    statusEl.textContent = 'Please paste some identity data first.';
    statusEl.className = 'sync-status-msg error';
    return;
  }

  const token = await getValidToken();
  if (!token) { showScreen('login'); return; }

  const btn = $('btn-seed');
  btn.disabled = true;
  btn.textContent = 'Seeding...';
  statusEl.textContent = 'Parsing and encrypting your data...';
  statusEl.className = 'sync-status-msg thinking';

  try {
    // Ask the backend AI to parse the raw text into structured vault profiles
    const backendUrl = getBackendUrl();
    const res = await fetch(`${backendUrl}/api/vault/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        profiles: {
          chintan_prajapati: {
            personalDetails: { fullName: 'Chintan Jayantibhai Prajapati' },
            identities: { raw: { text: rawText } },
          },
        },
      }),
    });

    const data = await readJsonResponse(res);
    if (!res.ok) {
      statusEl.textContent = `Seed failed: ${data?.error || res.status}`;
      statusEl.className = 'sync-status-msg error';
      return;
    }

    statusEl.textContent = '✅ Vault seeded! You can now fill forms.';
    statusEl.className = 'sync-status-msg success';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = 'sync-status-msg error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Seed Vault ✓';
  }
});

// ── Google Drive Sync handler ─────────────────────────────────────────────────
$('btn-sync-drive').addEventListener('click', async () => {
  const folderUrl = $('sync-folder-url').value.trim();
  const statusEl = $('sync-status');

  if (!folderUrl) {
    statusEl.textContent = 'Please paste a Google Drive folder URL.';
    statusEl.className = 'sync-status-msg error';
    return;
  }

  const token = await getValidToken();
  if (!token) { showScreen('login'); return; }

  chrome.storage.local.set({ syncFolderUrl: folderUrl });

  const btn = $('btn-sync-drive');
  btn.disabled = true;
  btn.textContent = 'Syncing...';
  statusEl.textContent = 'Starting sync job...';
  statusEl.className = 'sync-status-msg thinking';

  try {
    const backendUrl = getBackendUrl();
    const res = await fetch(`${backendUrl}/api/vault/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ folderUrl }),
    });

    const data = await readJsonResponse(res);
    if (!res.ok) {
      statusEl.textContent = `Sync failed: ${data?.error || res.status}`;
      statusEl.className = 'sync-status-msg error';
      return;
    }

    const jobId = data.jobId;
    statusEl.textContent = `Sync started. Polling for completion...`;

    let done = false;
    for (let i = 0; i < 60 && !done; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const pollRes = await fetch(`${backendUrl}/api/vault/status?jobId=${jobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const job = await readJsonResponse(pollRes);
        if (job.status === 'completed') {
          statusEl.textContent = `✅ Synced! ${job.progress?.processed ?? 0} docs processed.`;
          statusEl.className = 'sync-status-msg success';
          done = true;
        } else if (job.status === 'failed') {
          statusEl.textContent = `❌ Sync failed: ${job.error || 'Unknown error'}`;
          statusEl.className = 'sync-status-msg error';
          done = true;
        } else {
          const p = job.progress || {};
          statusEl.textContent = `Processing... ${p.processed ?? 0}/${p.total ?? '?'} docs`;
        }
      } catch (_) { /* keep polling */ }
    }
    if (!done) {
      statusEl.textContent = '⏱ Taking long — check back later.';
      statusEl.className = 'sync-status-msg warn';
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = 'sync-status-msg error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync from Drive';
  }
});

// Quick prompt chips
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chatInput.value = chip.dataset.prompt;
    chatInput.focus();
  });
});

// Main autofill flow
$('btn-send').addEventListener('click', handleAutofill);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleAutofill();
  }
});

function setAutofillLoading(isLoading, message = 'Autofill in progress…') {
  const loader = $('autofill-loader');
  const sendBtn = $('btn-send');
  const input = $('chat-input');
  const clearBtn = $('btn-clear');
  if (loader) {
    loader.classList.toggle('hidden', !isLoading);
    const textEl = $('autofill-loader-text');
    if (textEl) textEl.textContent = message;
  }
  if (sendBtn) {
    sendBtn.disabled = isLoading;
    sendBtn.textContent = isLoading ? 'Filling…' : 'Fill Form ↗';
  }
  if (input) input.disabled = isLoading;
  if (clearBtn) clearBtn.disabled = isLoading;
}

async function handleAutofill() {
  const instruction = chatInput.value.trim();
  if (!instruction) return;

  setAutofillLoading(true, 'Scanning form fields...');
  appendMessage('user', `<p>${escapeHtml(instruction)}</p>`);
  chatInput.value = '';

  const thinkingId = 'thinking_' + Date.now();
  appendMessage('assistant', `<p id="${thinkingId}" class="thinking">Scanning form fields...</p>`);

  const autofillTask = (async () => {
    // Step 1: Scrape DOM, retry a couple of times for late-loading forms
    let domResponse = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      domResponse = await withTimeout(sendChromeMessage({ type: 'SCRAPE_DOM' }), 4000, 'Form scanning timed out');
      if (domResponse?.fields?.length || domResponse?.error) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!domResponse?.fields?.length) {
      setAutofillLoading(false);
      const message = domResponse?.error
        ? `Form scanning failed: ${escapeHtml(domResponse.error)}`
        : 'No fillable form fields found on this page after retrying.';
      document.getElementById(thinkingId).outerHTML =
        `<div class="message assistant"><p class="warn">${message}</p></div>`;
      return;
    }

    document.getElementById(thinkingId).textContent = `Found ${domResponse.fields.length} fields. Mapping to vault...`;

    // Step 2: Get mapping from backend
    const token = await getValidToken();
    if (!token) {
      setAutofillLoading(false);
      showScreen('login');
      return;
    }

    const backendUrl = getBackendUrl();
    let mapRes;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 280000);
      try {
        mapRes = await fetch(`${backendUrl}/api/autofill/map`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
          body: JSON.stringify({ userInstruction: instruction, domSchema: domResponse.fields }),
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (networkErr) {
      const message = networkErr?.name === 'AbortError'
        ? `The autofill backend at ${backendUrl} did not respond in time. Please ensure the server is running and try again.`
        : `Could not reach backend at ${backendUrl}. Make sure your API server is running and exposes /api/autofill/map. ${networkErr?.message || ''}`;
      throw new Error(message.trim());
    }

    const mapData = await readJsonResponse(mapRes);

    if (!mapRes.ok) {
      const statusText = `${mapRes.status} ${mapRes.statusText}`.trim();
      let errorDetail = '';
      if (typeof mapData?.detail === 'string') {
        errorDetail = mapData.detail;
      } else if (mapData?.error) {
        errorDetail = typeof mapData.error === 'object' ? JSON.stringify(mapData.error) : mapData.error;
        if (mapData.detail) {
          errorDetail += ' ' + (typeof mapData.detail === 'object' ? JSON.stringify(mapData.detail) : mapData.detail);
        }
      }
      document.getElementById(thinkingId).outerHTML =
        `<div class="message assistant"><p class="error">Error: ${escapeHtml(errorDetail || statusText || 'Unknown error')}</p></div>`;
      return;
    }

    // Step 3: Inject values
    const mappings = Array.isArray(mapData.mappings) ? mapData.mappings : [];
    const normalized = mappings.map((m) => ({
      ...m,
      fieldType: m.fieldType || 'text',
    }));
    const valueMappings = normalized.filter((m) => m.fieldType !== 'file' && m.value !== null && m.value !== undefined && m.value !== '');
    const fileMappings = normalized.filter((m) => m.fieldType === 'file');

    const injectRes = await withTimeout(
      sendChromeMessage({ type: 'INJECT_VALUES', mappings: valueMappings }),
      180000,
      'Text field injection timed out'
    );

    const fileInjectRes = fileMappings.length > 0
      ? await withTimeout(
        sendChromeMessage({ type: 'INJECT_FILES', mappings: fileMappings }),
        180000,
        'File injection timed out'
      )
      : { injected: 0, failed: 0, details: [] };

    const injected = (injectRes?.injected ?? 0) + (fileInjectRes?.injected ?? 0);
    const failedInjects = (injectRes?.failed ?? 0) + (fileInjectRes?.failed ?? 0);
    const mappedCount = mapData.summary?.mapped ?? normalized.filter((m) => (m.value !== null && m.value !== undefined && m.value !== '') || m.fileUrl).length;
    const total = mapData.summary?.total ?? normalized.length;

    let summaryHtml = `<p>Mapped <strong>${mappedCount}</strong> of ${total} candidate fields.</p>`;
    summaryHtml += `<p>Injected <strong>${injected}</strong> values into the page.</p>`;
    if (failedInjects > 0) {
      summaryHtml += `<p class="warn">${failedInjects} field${failedInjects !== 1 ? 's' : ''} failed to inject and need manual review.</p>`;
    }

    if (mapData.unmappedFields?.length > 0) {
      const unmappedLabels = mapData.unmappedFields.map((f) => f.fieldLabel || f.fieldId).filter(Boolean);
      summaryHtml += `<p class="warn">I could not confidently map ${mapData.unmappedFields.length} field${mapData.unmappedFields.length !== 1 ? 's' : ''}.</p>`;
      if (unmappedLabels.length) {
        summaryHtml += `<ul>${unmappedLabels.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
      }
    }

    summaryHtml += `<p class="note">Fields highlighted in yellow - review each before submitting.</p>`;

    document.getElementById(thinkingId).outerHTML = `<div class="message assistant">${summaryHtml}</div>`;
  })();

  try {
    await withTimeout(autofillTask, 300000, 'Autofill exceeded max duration of 5 minutes');
  } catch (err) {
    const el = document.getElementById(thinkingId);
    let errMsg = err.message || err;
    if (typeof errMsg === 'object') errMsg = JSON.stringify(errMsg);
    if (el) el.outerHTML = `<div class="message assistant"><p class="error">Error: ${escapeHtml(errMsg)}</p></div>`;
  } finally {
    setAutofillLoading(false);
  }
}

$('btn-clear').addEventListener('click', () => {
  chatHistory.innerHTML = '';
});

function escapeHtml(str) {
  if (typeof str === 'object' && str !== null) {
    str = JSON.stringify(str);
  }
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
