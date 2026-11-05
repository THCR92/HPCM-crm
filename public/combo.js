// Type-to-search for long dropdowns (Tyler 2026-11-05): a <select data-combo> gets a text box
// in front of it. Typing narrows the list to the options containing every word typed
// ("eave" finds every eave trim), arrow keys and Enter pick one, Escape puts it back.
// The select stays the real field: picking an option sets it and fires its input and
// change events, so the page works as before. Selects drawn later (the quote form redraws
// its rows) are picked up on their own.
(function () {
  const words = (s) => String(s).toLowerCase().split(/\s+/).filter(Boolean);

  function attach(select) {
    if (select.dataset.comboReady) return;
    select.dataset.comboReady = '1';
    const box = document.createElement('span');
    box.className = 'combo';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = `combo-input ${select.className}`;
    input.autocomplete = 'off';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-label', select.getAttribute('aria-label') || 'Search');
    const list = document.createElement('ul');
    list.className = 'combo-list';
    list.hidden = true;
    select.parentNode.insertBefore(box, select);
    box.append(input, list, select);
    select.classList.add('combo-hidden');
    select.tabIndex = -1;

    const options = () => [...select.options].filter((o) => o.value !== '');
    const placeholder = () => (select.options[0] && select.options[0].value === '' ? select.options[0].text : '');
    const shown = () => {
      const o = select.selectedOptions[0];
      input.value = o && o.value !== '' ? o.text : '';
      input.placeholder = placeholder();
    };
    shown();

    let hits = [];
    let active = -1;
    function draw(filter) {
      const want = words(filter);
      hits = options().filter((o) => {
        const text = `${o.text} ${o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.label : ''}`.toLowerCase();
        return want.every((w) => text.includes(w));
      });
      active = hits.length ? 0 : -1;
      list.innerHTML = '';
      let group = null;
      if (!hits.length) {
        const li = document.createElement('li');
        li.className = 'combo-empty';
        li.textContent = 'Nothing matches';
        list.append(li);
      }
      hits.forEach((o, i) => {
        const g = o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.label : null;
        if (g && g !== group) {
          const h = document.createElement('li');
          h.className = 'combo-group';
          h.textContent = g;
          list.append(h);
        }
        group = g;
        const li = document.createElement('li');
        li.className = 'combo-option';
        li.textContent = o.text;
        li.dataset.i = i;
        list.append(li);
      });
      list.hidden = false;
      mark();
    }
    function mark() {
      list.querySelectorAll('.combo-option').forEach((li) => {
        const on = Number(li.dataset.i) === active;
        li.classList.toggle('active', on);
        if (on) li.scrollIntoView({ block: 'nearest' });
      });
    }
    function close() { list.hidden = true; shown(); }
    function pick(o) {
      list.hidden = true;
      if (!o) return shown();
      const changed = select.value !== o.value;
      select.value = o.value;
      shown();
      if (!changed) return;
      // Where this select sat, so focus can move on if the page redraws the row.
      const tr = select.closest('tr[data-s][data-i]');
      const at = tr ? `tr[data-s="${tr.dataset.s}"][data-i="${tr.dataset.i}"]` : null;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => {
        if (select.isConnected) return;
        const row = at && document.querySelector(at);
        // data-combo-next: where to go next, first match wins (e.g. "select.color, .qty").
        const next = row && (select.dataset.comboNext || '').split(',').map((q) => row.querySelector(q.trim())).find(Boolean);
        if (next) next.focus();
      });
    }

    input.addEventListener('focus', () => { input.select(); draw(''); });
    input.addEventListener('input', () => draw(input.value));
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) return draw(input.value);
        if (hits.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
        mark();
      } else if (e.key === 'Enter') {
        if (list.hidden) return;
        e.preventDefault();
        e.stopPropagation();
        pick(hits[active]);
      } else if (e.key === 'Escape') {
        if (list.hidden) return;
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab' && !list.hidden && input.value.trim() && hits.length) {
        pick(hits[active]);
      }
    });
    // mousedown, not click: it comes before the text box loses focus.
    list.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const li = e.target.closest('.combo-option');
      if (li) pick(hits[Number(li.dataset.i)]);
    });
    // Code that focuses the select (a new line) lands in the text box instead.
    select.addEventListener('focus', () => input.focus());
    // The select changed some other way: show it.
    select.addEventListener('change', () => { if (document.activeElement !== input) shown(); });
  }

  const scan = (root) => root.querySelectorAll && root.querySelectorAll('select[data-combo]').forEach(attach);
  const start = () => {
    scan(document);
    new MutationObserver((changes) => {
      for (const c of changes) for (const n of c.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('select[data-combo]')) attach(n);
        else scan(n);
      }
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}());
