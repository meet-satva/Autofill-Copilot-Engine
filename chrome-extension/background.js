importScripts('config.js');

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  const candidate = jsonMatch ? jsonMatch[1] : cleaned;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    console.warn('JSON parse fallback failed:', err.message);
    return null;
  }
}

function isRestrictedUrl(url) {
  return !url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:');
}

function forwardToActiveTab(message, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return sendResponse({ error: 'No active tab' });
    const url = tab.url || tab.pendingUrl || '';
    if (isRestrictedUrl(url)) {
      return sendResponse({ error: 'Cannot access this type of page' });
    }
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }, () => {
      if (chrome.runtime.lastError) {
        return sendResponse({ error: 'Injection failed' });
      }
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          return sendResponse({ error: chrome.runtime.lastError.message });
        }
        sendResponse(response);
      });
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCRAPE_DOM') {
    forwardToActiveTab({ type: 'SCRAPE_DOM' }, sendResponse);
    return true;
  }

  if (message.type === 'SHOW_AUTOFILL_OVERLAY' || message.type === 'UPDATE_AUTOFILL_OVERLAY' || message.type === 'HIDE_AUTOFILL_OVERLAY') {
    forwardToActiveTab(message, sendResponse);
    return true;
  }

  if (message.type === 'FETCH_FILE_BLOB') {
    fetch(message.url)
      .then(res => res.arrayBuffer())
      .then(buffer => sendResponse({ buffer }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'INJECT_VALUES') {
    forwardToActiveTab({ type: 'INJECT_VALUES', mappings: message.mappings }, sendResponse);
    return true;
  }

  if (message.type === 'INJECT_FILES') {
    forwardToActiveTab({ type: 'INJECT_FILES', mappings: message.mappings }, sendResponse);
    return true;
  }

  if (message.type === 'DETECT_FIELDS_WITH_AI') {
    const apiKey = typeof OPENROUTER_API_KEY !== 'undefined' ? OPENROUTER_API_KEY : '';
    const model = typeof OPENROUTER_MODEL !== 'undefined' ? OPENROUTER_MODEL : 'anthropic/claude-sonnet-4';
    if (!apiKey) {
      console.error('OPENROUTER_API_KEY not set — copy config.example.js to config.js');
      sendResponse([]);
      return true;
    }

    fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        temperature: 0,
        messages: [{
          role: 'user',
          content: `You are a form-field extractor. Return a JSON array of objects for every fillable form field in the following HTML. Include the properties: id, name, type, label (text), placeholder, ariaLabel, ariaDescribedBy. Exclude hidden, button, submit, reset inputs.\n\nHTML:\n${message.html}`,
        }],
      }),
    })
      .then(resp => {
        if (!resp.ok) throw new Error(`OpenRouter error ${resp.status}`);
        return resp.json();
      })
      .then(data => {
        const text = data.choices?.[0]?.message?.content || '';
        const parsed = tryParseJson(text);
        sendResponse(Array.isArray(parsed) ? parsed : []);
      })
      .catch(e => {
        console.error('AI field detection failed:', e);
        sendResponse([]);
      });

    return true;
  }
});
