// chrome-extension/content.js
(function() {
  if (window.__IDENTITY_VAULT_INJECTED) return;
  window.__IDENTITY_VAULT_INJECTED = true;

  console.log('✅ Identity Vault content script loaded');
  const HIGHLIGHT_COLOR = '#ffff00';
  const HIGHLIGHT_CLASS = 'identity-vault-filled';

  function ensureHighlightStyles() {
    if (document.getElementById('identity-vault-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'identity-vault-highlight-style';
    style.textContent = `
      input.${HIGHLIGHT_CLASS},
      textarea.${HIGHLIGHT_CLASS},
      select.${HIGHLIGHT_CLASS},
      [contenteditable="true"].${HIGHLIGHT_CLASS},
      input[maxlength="1"].${HIGHLIGHT_CLASS},
      .identity-vault-filled-wrap {
        background-color: ${HIGHLIGHT_COLOR} !important;
        background: ${HIGHLIGHT_COLOR} !important;
        transition: background-color 0.3s ease;
      }
      label.${HIGHLIGHT_CLASS},
      label.identity-vault-filled-wrap {
        background-color: #ffff99 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function highlightFilledField(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    ensureHighlightStyles();

    const targets = new Set([el]);
    if (el.matches('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) {
      const label = el.closest('label');
      if (label) targets.add(label);
    } else if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) targets.add(label);
    }

    const parent = el.parentElement;
    if (parent && !['FORM', 'BODY', 'HTML'].includes(parent.tagName)) {
      targets.add(parent);
    }

    for (const target of targets) {
      target.classList.add(HIGHLIGHT_CLASS);
      if (target !== el) target.classList.add('identity-vault-filled-wrap');
      target.style.setProperty('background-color', HIGHLIGHT_COLOR, 'important');
      target.style.setProperty('background', HIGHLIGHT_COLOR, 'important');
      target.style.transition = 'background-color 0.3s ease';
    }
  }

  function normalizeText(text) {
    return (text || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ── Full-page Gemini-style autofill overlay ─────────────────────────────────
  function ensureOverlayStyles() {
    if (document.getElementById('identity-vault-overlay-style')) return;
    const style = document.createElement('style');
    style.id = 'identity-vault-overlay-style';
    style.textContent = `
      #identity-vault-autofill-overlay {
        position: fixed; inset: 0; z-index: 2147483646;
        pointer-events: all; font-family: "Google Sans", system-ui, sans-serif;
      }
      #identity-vault-autofill-overlay .iv-backdrop {
        position: absolute; inset: 0;
        background: rgba(255,255,255,0.72);
        backdrop-filter: blur(4px);
        animation: iv-fade-in 0.25s ease;
      }
      #identity-vault-autofill-overlay .iv-panel {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        text-align: center; min-width: 280px; max-width: 90vw;
      }
      #identity-vault-autofill-overlay .iv-orbit {
        width: 56px; height: 56px; margin: 0 auto 20px;
        border-radius: 50%;
        background: conic-gradient(from 0deg, #4285f4, #9b72cb, #d96570, #f4c430, #4285f4);
        animation: iv-spin 1.2s linear infinite;
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 0);
        mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 0);
      }
      #identity-vault-autofill-overlay .iv-shimmer {
        height: 4px; border-radius: 999px; overflow: hidden;
        background: #e8eaed; margin-bottom: 14px;
      }
      #identity-vault-autofill-overlay .iv-shimmer-bar {
        height: 100%; width: 40%;
        background: linear-gradient(90deg, transparent, #4285f4, #9b72cb, transparent);
        animation: iv-shimmer 1.4s ease-in-out infinite;
      }
      #identity-vault-autofill-overlay .iv-text {
        font-size: 14px; color: #5f6368; font-weight: 400; margin: 12px 0 0;
      }
      #identity-vault-autofill-overlay .iv-steps {
        text-align: left; margin: 0 auto; max-width: 320px;
      }
      #identity-vault-autofill-overlay .iv-step {
        display: flex; align-items: flex-start; gap: 10px;
        font-size: 14px; line-height: 1.4; padding: 6px 0;
        color: #9aa0a6; transition: color 0.2s ease;
      }
      #identity-vault-autofill-overlay .iv-step-icon {
        flex-shrink: 0; width: 18px; text-align: center; font-size: 13px; margin-top: 1px;
      }
      #identity-vault-autofill-overlay .iv-step-active {
        color: #1a73e8; font-weight: 500;
      }
      #identity-vault-autofill-overlay .iv-step-done {
        color: #3c4043;
      }
      #identity-vault-autofill-overlay .iv-step-pending {
        color: #bdc1c6;
      }
      #identity-vault-autofill-overlay .iv-detail {
        font-size: 13px; color: #80868b; margin-top: 4px; font-weight: 400;
      }
      @keyframes iv-spin { to { transform: rotate(360deg); } }
      @keyframes iv-shimmer { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
      @keyframes iv-fade-in { from { opacity: 0; } to { opacity: 1; } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function renderOverlaySteps(steps) {
    if (!steps?.length) return '';
    return `<div class="iv-steps">${steps.map((step) => {
      const status = step.status || 'pending';
      const icon = status === 'done' ? '✓' : status === 'active' ? '●' : '○';
      const detail = step.detail ? `<div class="iv-detail">${escapeOverlayText(step.detail)}</div>` : '';
      return `<div class="iv-step iv-step-${status}"><span class="iv-step-icon">${icon}</span><div><div>${escapeOverlayText(step.label)}</div>${detail}</div></div>`;
    }).join('')}</div>`;
  }

  function normalizeOverlayPayload(messageOrPayload) {
    if (messageOrPayload && typeof messageOrPayload === 'object') {
      return {
        message: messageOrPayload.message || messageOrPayload.detail || '',
        steps: messageOrPayload.steps || [],
      };
    }
    return { message: messageOrPayload || '', steps: [] };
  }

  function showAutofillOverlay(messageOrPayload = 'Autofilling your form…') {
    ensureOverlayStyles();
    hideAutofillOverlay();
    const { message, steps } = normalizeOverlayPayload(messageOrPayload);
    const overlay = document.createElement('div');
    overlay.id = 'identity-vault-autofill-overlay';
    overlay.innerHTML = `
      <div class="iv-backdrop"></div>
      <div class="iv-panel">
        <div class="iv-orbit"></div>
        <div class="iv-shimmer"><div class="iv-shimmer-bar"></div></div>
        ${renderOverlaySteps(steps)}
        ${message ? `<p class="iv-text">${escapeOverlayText(message)}</p>` : ''}
      </div>`;
    document.documentElement.appendChild(overlay);
  }

  function updateAutofillOverlay(messageOrPayload) {
    const { message, steps } = normalizeOverlayPayload(messageOrPayload);
    const overlay = document.getElementById('identity-vault-autofill-overlay');
    if (!overlay) {
      if (message || steps.length) showAutofillOverlay({ message, steps });
      return;
    }
    const stepsEl = overlay.querySelector('.iv-steps');
    const textEl = overlay.querySelector('.iv-text');
    if (steps.length) {
      if (stepsEl) {
        stepsEl.outerHTML = renderOverlaySteps(steps);
      } else {
        const panel = overlay.querySelector('.iv-panel');
        const shimmer = panel?.querySelector('.iv-shimmer');
        shimmer?.insertAdjacentHTML('afterend', renderOverlaySteps(steps));
      }
    }
    if (textEl) {
      textEl.textContent = message || '';
      textEl.style.display = message ? '' : 'none';
    } else if (message) {
      overlay.querySelector('.iv-panel')?.insertAdjacentHTML(
        'beforeend',
        `<p class="iv-text">${escapeOverlayText(message)}</p>`
      );
    }
  }

  function reportAutofillProgress(payload) {
    updateAutofillOverlay(payload);
    try {
      chrome.runtime.sendMessage({ type: 'AUTOFILL_PROGRESS', ...normalizeOverlayPayload(payload) });
    } catch (_) {}
  }

  let lastProgressAt = 0;
  function reportFillProgressThrottled(fieldLabel, progressIndex, total, value) {
    const now = Date.now();
    const isKeyFrame = progressIndex === 1 || progressIndex === total;
    if (!isKeyFrame && now - lastProgressAt < 250 && progressIndex % 6 !== 0) return;
    lastProgressAt = now;
    const valueHint = value ? ` → ${String(value).slice(0, 40)}` : '';
    reportAutofillProgress({
      steps: [
        { id: 'scan', label: 'Scanning form on page', status: 'done' },
        { id: 'vault', label: 'Loading vault from database', status: 'done' },
        { id: 'map', label: 'Extracting & matching field values', status: 'done' },
        { id: 'fill', label: 'Injecting values into form', status: 'active', detail: `Extracting "${fieldLabel}" from vault${valueHint} (${progressIndex}/${total})` },
      ],
    });
  }

  function fireFieldEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function hideAutofillOverlay() {
    document.getElementById('identity-vault-autofill-overlay')?.remove();
  }

  function escapeOverlayText(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Segmented / per-character input boxes (government forms, OTP, etc.) ─────
  function isSegmentBox(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = (el.type || 'text').toLowerCase();
    if (['hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
    if (el.maxLength === 1) return true;
    const cls = `${el.className || ''} ${el.id || ''} ${el.name || ''}`.toLowerCase();
    if (/otp|pin|digit|char|segment|box|square|single|verify/i.test(cls) && el.maxLength > 0 && el.maxLength <= 2) return true;
    const w = parseFloat(window.getComputedStyle(el).width);
    if (el.maxLength > 0 && el.maxLength <= 2 && w > 0 && w <= 56) return true;
    return false;
  }

  function getFieldContainerLabel(container, firstInput) {
    const textFrom = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const labelledBy = firstInput?.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => textFrom(document.getElementById(id))).filter(Boolean).join(' ');
      if (t) return t;
    }
    if (firstInput?.getAttribute('aria-label')) return firstInput.getAttribute('aria-label');
    const legend = container?.querySelector('legend');
    if (legend) return textFrom(legend);
    const label = container?.querySelector('label');
    if (label) return textFrom(label);
    let node = container;
    for (let i = 0; i < 3 && node; i++) {
      const prev = node.previousElementSibling;
      if (prev) {
        const t = textFrom(prev);
        if (t && t.length < 200) return t;
      }
      node = node.parentElement;
    }
    return textFrom(container).slice(0, 120);
  }

  function findSegmentedGroups() {
    const candidates = [...document.querySelectorAll('input')].filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled && isSegmentBox(el);
    });

    const groups = [];
    const used = new Set();

    for (const input of candidates) {
      if (used.has(input)) continue;
      const container = input.closest('fieldset, td, tr, li, div, span, form') || input.parentElement;
      if (!container) continue;

      const boxes = [...container.querySelectorAll('input')].filter((el) => {
        if (!isSegmentBox(el)) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && !el.disabled;
      });

      if (boxes.length < 2) continue;

      boxes.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (Math.abs(ra.top - rb.top) > 12) return ra.top - rb.top;
        return ra.left - rb.left;
      });

      const rows = [];
      let currentRow = [boxes[0]];
      for (let i = 1; i < boxes.length; i++) {
        const prev = boxes[i - 1].getBoundingClientRect();
        const curr = boxes[i].getBoundingClientRect();
        if (Math.abs(prev.top - curr.top) <= 12) currentRow.push(boxes[i]);
        else { rows.push(currentRow); currentRow = [boxes[i]]; }
      }
      rows.push(currentRow);

      const bestRow = rows.sort((a, b) => b.length - a.length)[0];
      if (!bestRow || bestRow.length < 2) continue;

      bestRow.forEach((el) => used.add(el));
      const label = getFieldContainerLabel(container, bestRow[0]);
      groups.push({
        boxes: bestRow,
        label,
        groupId: bestRow.map((b) => b.id).filter(Boolean).join('_') || `segment_${groups.length}`,
        container,
      });
    }
    return groups;
  }

  function consolidateSegmentedFields(fields) {
    const groups = findSegmentedGroups();
    if (!groups.length) return fields;

    const consumed = new Set();
    for (const g of groups) g.boxes.forEach((b) => consumed.add(b));

    const segmented = groups.map((g) => ({
      id: g.groupId,
      name: g.boxes[0]?.name || '',
      type: 'segmented',
      fieldType: 'segmented',
      labelText: g.label,
      groupLabel: g.label,
      segmentCount: g.boxes.length,
      segmentIds: g.boxes.map((b) => b.id).filter(Boolean),
      segmentNames: [...new Set(g.boxes.map((b) => b.name).filter(Boolean))],
      placeholder: '',
      ariaLabel: g.label,
      tagName: 'input',
    }));

    const filtered = fields.filter((f) => !f.element || !consumed.has(f.element));
    return [...filtered, ...segmented];
  }

  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  function setNativeInputValue(el, value) {
    const raw = value?.toString() ?? '';
    if (el.isContentEditable) {
      el.textContent = raw;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) nativeTextareaSetter.call(el, raw);
    else if (nativeInputSetter) nativeInputSetter.call(el, raw);
    else el.value = raw;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function injectSegmentedValue(boxes, value) {
    const chars = value.toString().replace(/\s+/g, '').split('');
    boxes.forEach((el, i) => {
      setNativeInputValue(el, chars[i] ?? '');
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      highlightFilledField(el);
    });
    if (boxes[0]?.parentElement) highlightFilledField(boxes[0].parentElement);
    return chars.length > 0;
  }

  function findSegmentedGroupForMapping(mapping) {
    const groups = findSegmentedGroups();
    const target = normalizeText(mapping.fieldLabel || mapping.fieldId || mapping.fieldName || '');

    if (mapping.segmentIds?.length) {
      const g = groups.find((grp) => mapping.segmentIds.every((id) => grp.boxes.some((b) => b.id === id)));
      if (g) return g.boxes;
    }

    for (const g of groups) {
      const label = normalizeText(g.label);
      if (target && (label.includes(target) || target.includes(label))) return g.boxes;
      if (mapping.fieldId && g.groupId === mapping.fieldId) return g.boxes;
    }

    if (/aadhaar|aadhar|pan|pincode|mobile|phone|otp|epic|passport/i.test(target)) {
      const best = groups.find((g) => {
        const l = normalizeText(g.label);
        return l.includes(target) || target.split(' ').some((w) => w.length > 3 && l.includes(w));
      });
      if (best) return best.boxes;
    }
    return null;
  }

  // ── AI-driven field detection ──────────────────────────────────────────────
  // ── Scrape form fields from webpage ────────────────────────────────────────
  async function scrapeFormFields() {
    const fields = [];
    const isGoogleForms = !!document.querySelector('form[action*="google.com/forms"], .freebirdFormviewerViewFormCard');
    const inputs = document.querySelectorAll(
      'input, textarea, select, [role="textbox"][contenteditable="true"], [contenteditable="true"], [role="radio"], [role="checkbox"]'
    );

    const textFrom = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const nearestQuestionText = (el) => {
      const selectors = [
        '.freebirdFormviewerViewNumberedItemContainer',
        '.freebirdFormviewerViewItemsItemItem',
        '.freebirdFormviewerComponentsQuestionBaseRoot',
        '[data-params]',
      ];
      for (const selector of selectors) {
        const container = el.closest(selector);
        if (container) {
          const candidates = [
            container.querySelector('.freebirdFormviewerViewItemsItemItemTitle'),
            container.querySelector('.freebirdFormviewerComponentsQuestionBaseTitle'),
            container.querySelector('[role="heading"]'),
          ].filter(Boolean);
          for (const candidate of candidates) {
            const txt = textFrom(candidate);
            if (txt) return txt;
          }
          const fallback = textFrom(container);
          if (fallback) return fallback;
        }
      }
      return '';
    };

    inputs.forEach((el) => {
      const computedStyle = window.getComputedStyle(el);
      if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden' || el.disabled) {
        return;
      }
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) {
        return;
      }
      if (el.tagName.toLowerCase() === 'input' && el.type === 'file' && !el.name && !el.id) {
        return;
      }

      const id = el.id || '';
      const name = el.name || '';
      const placeholder = el.placeholder || '';
      const type = el.type || (el.isContentEditable ? 'text' : el.tagName.toLowerCase());
      const ariaLabel = el.getAttribute('aria-label') || '';
      const ariaDescribedBy = el.getAttribute('aria-describedby') || '';

      // Get associated label text
      let labelText = '';
      const ariaLabelledBy = el.getAttribute('aria-labelledby') || '';

      // Try: label[for="id"]
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) labelText = label.innerText.trim();
      }

      // Try: labels associated by the element's labels property
      if (!labelText && el.labels?.length) {
        labelText = Array.from(el.labels)
          .map((labelEl) => labelEl.innerText.trim())
          .filter(Boolean)
          .join(' ');
      }

      // Try: aria-labelledby reference text
      if (!labelText && ariaLabelledBy) {
        labelText = ariaLabelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText?.trim())
          .filter(Boolean)
          .join(' ');
      }

      // Try: parent label or nearby text
      if (!labelText) {
        const parent = el.closest('label, fieldset, div, td');
        if (parent && parent !== el) {
          labelText = parent.innerText?.trim() || '';
          // If parent has too much text, try just nearby label
          if (labelText.length > 100) {
            const closeLabel = parent.querySelector('label, .label, [class*=\"label\"]');
            if (closeLabel) labelText = closeLabel.innerText.trim();
          }
        }
      }

      // Try: previous siblings (Google Forms style)
      if (!labelText) {
        let sibling = el.previousElementSibling;
        let attempts = 0;
        while (sibling && !labelText && attempts < 3) {
          const txt = sibling.innerText?.trim();
          if (txt && txt.length > 0 && txt.length < 200) {
            labelText = txt;
          }
          sibling = sibling.previousElementSibling;
          attempts++;
        }
      }

      // Google Forms often keeps the question text several ancestors away.
      if (!labelText && isGoogleForms) {
        labelText = nearestQuestionText(el);
      }

      // Improve common Google Forms radio/checkbox extraction
      const role = el.getAttribute('role') || '';
      if ((el.type === 'radio' || el.type === 'checkbox') && isGoogleForms) {
        const optionText =
          textFrom(el.closest('[role="radio"], [role="checkbox"], label')) ||
          el.getAttribute('aria-label') ||
          '';
        if (optionText) {
          labelText = labelText || nearestQuestionText(el) || optionText;
        }
      }

      // Only add if it has some identifying info
      if (id || name || labelText || placeholder || ariaLabel) {
        fields.push({
          id,
          name,
          type,
          labelText,
          groupLabel: isGoogleForms ? nearestQuestionText(el) : '',
          optionLabel: (el.type === 'radio' || el.type === 'checkbox') ? (ariaLabel || textFrom(el.closest('label, [role="radio"], [role="checkbox"]')) || '') : '',
          placeholder,
          ariaLabel,
          ariaDescribedBy,
          role,
          tagName: el.tagName.toLowerCase(),
          currentValue: el.value || el.textContent || '',
          accept: el.accept || '',
          multiple: el.multiple || false,
          element: el, // Reference to actual DOM element
        });
      }
    });

    const merged = consolidateSegmentedFields(fields);
    console.log(`📋 Found ${merged.length} form fields (${merged.filter(f => f.fieldType === 'segmented').length} segmented groups)`);
    return merged;
  }

  function buildFieldIndex() {
    const index = {
      byId: new Map(),
      byName: new Map(),
      byAria: [],
      byPlaceholder: [],
      byLabel: [],
      byGroupText: [],
      byFileContext: [],
      radios: [],
      checkboxes: [],
    };

    const allFields = document.querySelectorAll('input, textarea, select');
    allFields.forEach((el) => {
      const record = { el, text: '' };
      const id = el.id || '';
      const name = el.name || '';
      const aria = (el.getAttribute('aria-label') || '').trim();
      const placeholder = (el.placeholder || '').trim();
      const label = (el.closest('label')?.innerText || '').trim();
      const parentText = (el.closest('div, fieldset, td, form')?.innerText || '').trim();
      const type = (el.type || '').toLowerCase();
      const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

      if (id) index.byId.set(id, el);
      if (name) {
        if (!index.byName.has(name)) index.byName.set(name, []);
        index.byName.get(name).push(el);
      }
      if (aria) index.byAria.push({ el, text: normalize(aria) });
      if (placeholder) index.byPlaceholder.push({ el, text: normalize(placeholder) });
      if (label) index.byLabel.push({ el, text: normalize(label) });
      if (parentText) index.byGroupText.push({ el, text: normalize(parentText) });
      if (el.type === 'file') index.byFileContext.push({ el, text: parentText.toLowerCase() });
      if (type === 'radio') index.radios.push(el);
      if (type === 'checkbox') index.checkboxes.push(el);
    });

    return index;
  }

  // ── Inject text values into form fields ────────────────────────────────────
  function injectValues(mappings) {
    const results = { injected: 0, failed: 0, details: [] };
    const index = buildFieldIndex();
    const allInputs = Array.from(document.querySelectorAll('input, textarea, select'));
    const isElement = (node) => node && node.nodeType === Node.ELEMENT_NODE;
    const actionable = mappings.filter((m) => m.value !== null && m.value !== undefined && m.value !== '');
    const total = actionable.length;
    let filledCount = 0;

    for (let i = 0; i < mappings.length; i++) {
      const mapping = mappings[i];
      if (mapping.value === null || mapping.value === undefined || mapping.value === '') {
        continue;
      }

      filledCount += 1;
      const fieldLabel = mapping.fieldLabel || mapping.fieldName || mapping.fieldId || 'field';
      reportFillProgressThrottled(fieldLabel, filledCount, total, mapping.value);

      // Segmented / per-character boxes (government forms, OTP-style)
      if (mapping.fieldType === 'segmented' || mapping.type === 'segmented' || mapping.segmentIds?.length) {
        const boxes = findSegmentedGroupForMapping(mapping);
        if (boxes?.length) {
          const ok = injectSegmentedValue(boxes, mapping.value);
          if (ok) {
            results.injected++;
            results.details.push({ field: mapping.fieldLabel, value: mapping.value, status: 'success_segmented' });
            continue;
          }
        }
      }

      let el = null;

      // Strategy 1: By ID
      if (mapping.fieldId) {
        el = index.byId.get(mapping.fieldId) || document.getElementById(mapping.fieldId);
        if (!el) {
          const target = normalizeText(mapping.fieldId);
          el = allInputs.find((candidate) => {
            const idText = normalizeText(candidate.id || '');
            const nameText = normalizeText(candidate.name || '');
            return idText === target || idText.includes(target) || nameText.includes(target);
          }) || null;
        }
      }

      // Strategy 2: By name attribute
      if (!el && mapping.fieldName) {
        const named = index.byName.get(mapping.fieldName);
        el = named?.[0] || null;
      }

      // Strategy 2b: By partial id/name match, useful when HTML uses camelCase or snake_case
      if (!el && mapping.fieldName) {
        const target = mapping.fieldName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        el = allInputs.find((candidate) => {
          const idText = (candidate.id || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const nameText = (candidate.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          return (idText && idText.includes(target)) || (nameText && nameText.includes(target));
        }) || null;
      }

      // Strategy 3: By aria-label
      if (!el && mapping.fieldLabel) {
        const target = normalizeText(mapping.fieldLabel);
        el = index.byAria.find(x => x.text.includes(target))?.el || null;
      }

      // Strategy 4: By placeholder
      if (!el && mapping.fieldLabel) {
        const target = normalizeText(mapping.fieldLabel);
        el = index.byPlaceholder.find(x => x.text.includes(target))?.el || null;
      }

      // Strategy 5: By associated label text
      if (!el && mapping.fieldLabel) {
        const target = normalizeText(mapping.fieldLabel);
        el = index.byLabel.find(x => x.text.includes(target))?.el || null;
      }

      // Strategy 5b: Raw normalized search across id/name/placeholder/aria/label
      if (!el && mapping.fieldLabel) {
        const target = normalizeText(mapping.fieldLabel);
        el = allInputs.find((candidate) => {
          const idText = normalizeText(candidate.id || '');
          const nameText = normalizeText(candidate.name || '');
          const placeholderText = normalizeText(candidate.placeholder || '');
          const ariaText = normalizeText(candidate.getAttribute('aria-label') || '');
          const labelText = normalizeText(candidate.closest('label')?.innerText || '');
          return [idText, nameText, placeholderText, ariaText, labelText].some((text) => text.includes(target));
        }) || null;
      }

      // Strategy 6: Search parent context
      if (!el && mapping.fieldLabel) {
        const target = mapping.fieldLabel.toLowerCase();
        el = index.byGroupText.find(x => x.text.includes(target))?.el || null;
      }

      // Strategy 7: Google Forms radio/checkbox groups by question text
      if (!el && mapping.fieldLabel) {
        const target = mapping.fieldLabel.toLowerCase();
        const candidates = [...index.radios, ...index.checkboxes];
        for (const candidate of candidates) {
          const groupText = candidate.closest('.freebirdFormviewerViewNumberedItemContainer, .freebirdFormviewerViewItemsItemItem, .freebirdFormviewerComponentsQuestionBaseRoot, [data-params]')?.innerText?.toLowerCase() || '';
          if (groupText.includes(target)) {
            el = candidate;
            break;
          }
        }
      }

      if (!el) {
        const boxes = findSegmentedGroupForMapping(mapping);
        if (boxes?.length && injectSegmentedValue(boxes, mapping.value)) {
          results.injected++;
          results.details.push({ field: mapping.fieldLabel, value: mapping.value, status: 'success_segmented' });
          continue;
        }
        results.failed++;
        results.details.push({
          field: mapping.fieldLabel,
          status: 'not_found',
        });
        console.warn(`❌ Field not found: ${mapping.fieldLabel}`);
        continue;
      }

      if (!isElement(el)) {
        results.failed++;
        results.details.push({
          field: mapping.fieldLabel,
          status: 'invalid_element',
        });
        console.warn(`âŒ Invalid element for: ${mapping.fieldLabel}`);
        continue;
      }

      try {
        const isDateInput = el.matches('input[type="date"]');
        const isDateTime = el.matches('input[type="datetime-local"]');

        if (el.matches('input[type="radio"], [role="radio"]')) {
          const target = (mapping.value || mapping.optionLabel || '').toLowerCase();
          const radios = index.radios.length ? index.radios : document.querySelectorAll('input[type="radio"], [role="radio"]');
          let clicked = false;
          for (const radio of radios) {
            const text = (
              radio.getAttribute('aria-label') ||
              radio.closest('label')?.innerText ||
              radio.closest('[role="radio"]')?.innerText ||
              ''
            ).toLowerCase();
            if (target && text.includes(target)) {
              radio.click();
              highlightFilledField(radio);
              clicked = true;
              break;
            }
            const groupText = radio.closest('.freebirdFormviewerViewNumberedItemContainer, .freebirdFormviewerViewItemsItemItem, .freebirdFormviewerComponentsQuestionBaseRoot, [data-params]')?.innerText?.toLowerCase() || '';
            if (!target && groupText.includes(mapping.fieldLabel.toLowerCase())) {
              radio.click();
              highlightFilledField(radio);
              clicked = true;
              break;
            }
          }
          if (clicked) {
            results.injected++;
            results.details.push({ field: mapping.fieldLabel, value: mapping.value || mapping.optionLabel || true, status: 'success' });
            continue;
          }
        }

        if (el.matches('input[type="checkbox"], [role="checkbox"]')) {
          const target = (mapping.value || mapping.optionLabel || '').toLowerCase();
          const checkboxes = index.checkboxes.length ? index.checkboxes : document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
          let clicked = false;
          for (const checkbox of checkboxes) {
            const text = (
              checkbox.getAttribute('aria-label') ||
              checkbox.closest('label')?.innerText ||
              checkbox.closest('[role="checkbox"]')?.innerText ||
              ''
            ).toLowerCase();
            if (target && text.includes(target)) {
              checkbox.click();
              highlightFilledField(checkbox);
              clicked = true;
              break;
            }
          }
          if (clicked) {
            results.injected++;
            results.details.push({ field: mapping.fieldLabel, value: mapping.value || mapping.optionLabel || true, status: 'success' });
            continue;
          }
        }

        // Handle SELECT differently
        if (el.tagName === 'SELECT') {
          let matched = false;
          for (const opt of el.options) {
            if (
              opt.value.toLowerCase() === mapping.value.toLowerCase() ||
              opt.text.toLowerCase() === mapping.value.toLowerCase()
            ) {
              el.value = opt.value;
              matched = true;
              break;
            }
          }
          if (!matched) {
            results.failed++;
            console.warn(`❌ No matching option for: ${mapping.value}`);
            continue;
          }
        } else {
          const rawValue = mapping.value?.toString() || '';

          if (el.isContentEditable) {
            setNativeInputValue(el, rawValue);
          } else if (isDateInput) {
            const normalized = normalizeDateString(rawValue);
            if (nativeInputSetter) {
              nativeInputSetter.call(el, normalized);
            } else {
              el.value = normalized;
            }
          } else if (isDateTime) {
            const normalized = normalizeDateString(rawValue);
            if (nativeInputSetter) {
              nativeInputSetter.call(el, normalized);
            } else {
              el.value = normalized;
            }
          } else if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) {
            nativeTextareaSetter.call(el, rawValue);
          } else if (nativeInputSetter) {
            nativeInputSetter.call(el, rawValue);
          } else {
            el.value = rawValue;
          }

          if (isDateInput || isDateTime) {
            const parsed = new Date(rawValue);
            if (!Number.isNaN(parsed.getTime())) {
              el.valueAsDate = parsed;
            }
          }
        }

        fireFieldEvents(el);

        highlightFilledField(el);

        results.injected++;
        results.details.push({
          field: mapping.fieldLabel,
          value: mapping.value,
          status: 'success',
        });

        console.log(`✅ Injected: ${mapping.fieldLabel} = ${mapping.value}`);
      } catch (err) {
        results.failed++;
        results.details.push({
          field: mapping.fieldLabel,
          status: 'error',
          error: err.message,
        });
        console.error(`❌ Injection error:`, err);
      }
    }

    return results;
  }

  function normalizeDateString(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      const parts = value.match(/(\d{2})[-/.](\d{2})[-/.](\d{4})/);
      if (parts) {
        return `${parts[3]}-${parts[2]}-${parts[1]}`;
      }
      return value;
    }
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // ── Inject files into file input fields ────────────────────────────────────
  async function injectFiles(mappings) {
    const results = { injected: 0, failed: 0, details: [] };
    const index = buildFieldIndex();
    const prepared = await Promise.all(mappings.map(async (mapping) => {
      try {
        const blobResponse = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: 'FETCH_FILE_BLOB',
              url: mapping.fileUrl || mapping.driveFileId,
              fileName: mapping.fileName,
            },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else if (!response?.buffer) {
                reject(new Error('No buffer returned'));
              } else {
                resolve(response);
              }
            }
          );
        });

        const blob = new Blob([new Uint8Array(blobResponse.buffer)], {
          type: mapping.mimeType || 'application/octet-stream',
        });
        return {
          mapping,
          file: new File([blob], mapping.fileName, {
            type: mapping.mimeType || 'application/octet-stream',
          }),
        };
      } catch (error) {
        return { mapping, error };
      }
    }));

    for (let fileIdx = 0; fileIdx < prepared.length; fileIdx++) {
      const item = prepared[fileIdx];
      const { mapping, file, error } = item;
      const fieldLabel = mapping.fieldLabel || mapping.fileName || 'document';
      reportAutofillProgress({
        steps: [
          { id: 'scan', label: 'Scanning form on page', status: 'done' },
          { id: 'vault', label: 'Loading vault from database', status: 'done' },
          { id: 'map', label: 'Extracting & matching field values', status: 'done' },
          { id: 'fill', label: 'Injecting values into form', status: 'done' },
          { id: 'files', label: 'Attaching documents from vault', status: 'active', detail: `Getting "${fieldLabel}" from vault / Drive (${fileIdx + 1}/${prepared.length})` },
        ],
      });
      if (error) {
        results.failed++;
        results.details.push({
          field: mapping.fieldLabel,
          status: 'error',
          error: error.message,
        });
        continue;
      }

      let fileField = null;

      // Strategy 1: By ID
      if (mapping.fieldId) {
        fileField = index.byId.get(mapping.fieldId) || document.getElementById(mapping.fieldId);
      }

      // Strategy 2: By name
      if (!fileField && mapping.fieldName) {
        fileField = index.byName.get(mapping.fieldName)?.[0] || null;
      }

      // Strategy 3: By aria-label
      if (!fileField && mapping.fieldLabel) {
        const target = mapping.fieldLabel.toLowerCase();
        fileField = index.byAria.find(x => x.text.includes(target) && x.el.type === 'file')?.el || null;
      }

      // Strategy 4: By associated label
      if (!fileField && mapping.fieldLabel) {
        const target = mapping.fieldLabel.toLowerCase();
        fileField = index.byLabel.find(x => x.text.includes(target) && x.el.type === 'file')?.el || null;
      }

      // Strategy 5: Find any file input in similar context
      if (!fileField && mapping.fieldLabel) {
        const target = mapping.fieldLabel.toLowerCase();
        fileField = index.byFileContext.find(x => x.text.includes(target))?.el || null;
      }

      if (!fileField || fileField.type !== 'file') {
        results.failed++;
        results.details.push({
          field: mapping.fieldLabel,
          status: 'file_field_not_found',
        });
        console.warn(`❌ File field not found: ${mapping.fieldLabel}`);
        continue;
      }

      try {
        // Use DataTransfer to set files
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileField.files = dataTransfer.files;

        // Trigger events
        fileField.dispatchEvent(new Event('change', { bubbles: true }));
        fileField.dispatchEvent(new Event('input', { bubbles: true }));
        fileField.dispatchEvent(new Event('blur', { bubbles: true }));

        highlightFilledField(fileField);

        results.injected++;
        results.details.push({
          field: mapping.fieldLabel,
          fileName: mapping.fileName,
          status: 'success',
        });

        console.log(`✅ Injected file: ${mapping.fileName}`);
      } catch (err) {
        results.failed++;
        results.details.push({
          field: mapping.fieldLabel,
          status: 'error',
          error: err.message,
        });
        console.error(`❌ File injection failed:`, err);
      }
    }

    return results;
  }

  // ── Message listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`📨 Received message: ${message.type}`);

    if (message.type === 'SHOW_AUTOFILL_OVERLAY') {
      showAutofillOverlay(message.payload || message.message || 'Autofilling your form…');
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'UPDATE_AUTOFILL_OVERLAY') {
      updateAutofillOverlay(message.payload || message.message || '');
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'HIDE_AUTOFILL_OVERLAY') {
      hideAutofillOverlay();
      sendResponse({ ok: true });
      return false;
    }

    // SCRAPE_DOM: Find all form fields
    if (message.type === 'SCRAPE_DOM') {
      scrapeFormFields()
        .then((fields) => {
          console.log(`✅ Scraped ${fields.length} fields`);
          // Remove element references before sending (can't serialize DOM)
          const cleanFields = fields.map(({ element, ...rest }) => rest);
          sendResponse({ fields: cleanFields });
        })
        .catch((err) => {
          console.error('Scrape error:', err);
          sendResponse({ error: err.message });
        });
      return true; // Keep channel open for async
    }

    // INJECT_VALUES: Fill text fields with values
    if (message.type === 'INJECT_VALUES') {
      try {
        const results = injectValues(message.mappings || []);
        sendResponse(results);
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return false;
    }

    // INJECT_FILES: Fill file input fields
    if (message.type === 'INJECT_FILES') {
      injectFiles(message.mappings || [])
        .then((results) => {
          console.log(`✅ File injection complete:`, results);
          sendResponse(results);
        })
        .catch((err) => {
          console.error('File injection error:', err);
          sendResponse({ error: err.message });
        });
      return true; // Keep channel open for async
    }
  });

})();
