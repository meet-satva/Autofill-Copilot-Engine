// chrome-extension/content.js
(function() {
  if (window.__IDENTITY_VAULT_INJECTED) return;
  window.__IDENTITY_VAULT_INJECTED = true;

  console.log('✅ Identity Vault content script loaded');
  const HIGHLIGHT_COLOR = 'yellow';

  function normalizeText(text) {
    return (text || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ── AI-driven field detection ──────────────────────────────────────────────
  // ── Scrape form fields from webpage ────────────────────────────────────────
  async function scrapeFormFields() {
    const fields = [];
    const isGoogleForms = !!document.querySelector('form[action*="google.com/forms"], .freebirdFormviewerViewFormCard');
    const inputs = document.querySelectorAll(
      'input, textarea, select, [role="textbox"][contenteditable="true"], [role="radio"], [role="checkbox"]'
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
      const type = el.type || el.tagName.toLowerCase();
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
          currentValue: el.value || '',
          accept: el.accept || '',
          multiple: el.multiple || false,
          element: el, // Reference to actual DOM element
        });
      }
    });

    console.log(`📋 Found ${fields.length} form fields`);

    return fields;
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
    const isElement = (node) => node && node.nodeType === Node.ELEMENT_NODE;

    for (const mapping of mappings) {
      if (mapping.value === null || mapping.value === undefined || mapping.value === '') {
        console.warn(`⚠️  No value for: ${mapping.fieldLabel}`);
        continue;
      }

      let el = null;

      // Strategy 1: By ID
      if (mapping.fieldId) {
        el = index.byId.get(mapping.fieldId) || document.getElementById(mapping.fieldId);
        if (!el) {
          const target = normalizeText(mapping.fieldId);
          const allInputs = Array.from(document.querySelectorAll('input, textarea, select'));
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
        const allInputs = Array.from(document.querySelectorAll('input, textarea, select'));
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
        const allInputs = Array.from(document.querySelectorAll('input, textarea, select'));
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
              radio.style.setProperty('background-color', HIGHLIGHT_COLOR, 'important');
              clicked = true;
              break;
            }
            const groupText = radio.closest('.freebirdFormviewerViewNumberedItemContainer, .freebirdFormviewerViewItemsItemItem, .freebirdFormviewerComponentsQuestionBaseRoot, [data-params]')?.innerText?.toLowerCase() || '';
            if (!target && groupText.includes(mapping.fieldLabel.toLowerCase())) {
              radio.click();
              radio.style.setProperty('background-color', HIGHLIGHT_COLOR, 'important');
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
              checkbox.style.setProperty('background-color', HIGHLIGHT_COLOR, 'important');
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
          // Handle INPUT / TEXTAREA
          const nativeInputSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )?.set;
          const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
          )?.set;
          const rawValue = mapping.value?.toString() || '';
          const isDateInput = el.matches('input[type="date"]');
          const isDateTime = el.matches('input[type="datetime-local"]');

          if (isDateInput) {
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
        }

        if (isDateInput || isDateTime) {
          const parsed = new Date(rawValue);
          if (!Number.isNaN(parsed.getTime())) {
            el.valueAsDate = parsed;
          }
        }

        // Trigger change events
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));

        // Visual feedback
        el.style.setProperty('background-color', HIGHLIGHT_COLOR, 'important');
        el.style.transition = 'background-color 0.3s ease';

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

    for (const item of prepared) {
      const { mapping, file, error } = item;
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

        // Visual feedback
        fileField.style.setProperty('background-color', HIGHLIGHT_COLOR, 'important');
        fileField.style.transition = 'background-color 0.3s ease';

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
