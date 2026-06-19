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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCRAPE_DOM') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) return sendResponse({ error: 'No active tab' });
      // Chrome internal pages cannot be accessed
      const url = tab.url || tab.pendingUrl || '';
      if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:')) {
        console.warn('Skipping injection on restricted URL:', url);
        return sendResponse({ error: 'Cannot access this type of page (e.g. Chrome internal pages or extensions)' });
      }
      const tabId = tab.id;
      // Ensure content script is loaded
      chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
        if (chrome.runtime.lastError) {
          console.error('Injection error:', chrome.runtime.lastError);
          return sendResponse({ error: 'Injection failed' });
        }
        chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_DOM' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Message error:', chrome.runtime.lastError);
            return sendResponse({ error: 'No receiving end' });
          }
          sendResponse(response);
        });
      });
    });
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
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) return sendResponse({ error: 'No active tab' });
      const url = tab.url || tab.pendingUrl || '';
      if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:')) {
        console.warn('Skipping injection on restricted URL:', url);
        return sendResponse({ error: 'Cannot access this type of page (e.g. Chrome internal pages or extensions)' });
      }
      const tabId = tab.id;
      // Ensure content script is loaded before injection
      chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
        if (chrome.runtime.lastError) {
          console.error('Injection error:', chrome.runtime.lastError);
          return sendResponse({ error: 'Injection failed' });
        }
        chrome.tabs.sendMessage(tabId, { type: 'INJECT_VALUES', mappings: message.mappings }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Message error:', chrome.runtime.lastError);
            return sendResponse({ error: 'No receiving end' });
          }
          sendResponse(response);
        });
      });
    });
    return true;
  }

  if (message.type === 'DETECT_FIELDS_WITH_AI') {
    const apiKey = "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";
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `You are a form‑field extractor. Return a JSON array of objects for every fillable form field in the following HTML. Include the properties: id, name, type, label (text), placeholder, ariaLabel, ariaDescribedBy. Exclude hidden, button, submit, reset inputs.\n\nHTML:\n${message.html}`,
      }],
    };

    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
      .then(resp => {
        if (!resp.ok) throw new Error(`Anthropic error ${resp.status}`);
        return resp.json();
      })
      .then(data => {
        const text = data.content?.[0]?.text || '';
        const parsed = tryParseJson(text);
        sendResponse(Array.isArray(parsed) ? parsed : []);
      })
      .catch(e => {
        console.error('AI field detection failed:', e);
        sendResponse([]);
      });

    return true; // Keep message channel open for async fetch
  }
});