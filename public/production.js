// Order page: "Log run" form. Fills pieces and length from the chosen line,
// shows the coil footage it will use, and warns when the coil doesn't match
// the line's color (including the same color name from another supplier) or gauge.
(function () {
  const form = document.querySelector('.run-form');
  if (!form) return;
  const line = form.elements.order_item_id;
  const coil = form.elements.coil_id;
  const warning = form.querySelector('.run-warning');
  const confirmBox = form.querySelector('.run-confirm');

  const inchesText = (inch) => {
    const whole = Math.floor(inch + 1e-9);
    let n = Math.round((inch - whole) * 16);
    if (!n) return whole ? String(whole) : '';
    let d = 16;
    while (n % 2 === 0) { n /= 2; d /= 2; }
    return `${whole ? `${whole} ` : ''}${n}/${d}`;
  };
  const parseInches = (s) => {
    const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)?(?:\s*[-\s]\s*)?(?:(\d+)\/(\d+))?$/);
    if (!m) return NaN;
    return (m[1] ? Number(m[1]) : 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
  };

  function updateFootage() {
    const pieces = Number(form.elements.pieces.value);
    const len = (Number(form.elements.ft.value) || 0) * 12 + parseInches(form.elements.inch.value);
    const scrap = Number(form.elements.scrap_lf.value) || 0;
    // Mirrors footage() in src/production.js: trim pieces side by side across the coil.
    const girth = Number(line.selectedOptions[0]?.dataset.girth);
    const width = Number(coil.selectedOptions[0]?.dataset.width);
    const across = girth > 0 && width >= girth ? Math.floor(width / girth) : 1;
    form.elements.lf_used.placeholder = pieces > 0 && len > 0
      ? `${Math.round(((Math.ceil(pieces / across) * len) / 12 + scrap) * 10) / 10}` : '';
    const note = form.querySelector('.run-across');
    if (note) note.textContent = across > 1 ? `${across} pieces fit across this coil.` : '';
  }

  function check() {
    const l = line.selectedOptions[0];
    const c = coil.selectedOptions[0];
    const problems = [];
    if (l && c && l.value && c.value) {
      if (l.dataset.color && l.dataset.color !== c.dataset.color) {
        problems.push("this coil isn't the line's color (or it's the same color name from a different supplier)");
      }
      if (l.dataset.gauge && l.dataset.gauge !== c.dataset.gauge) problems.push("this coil isn't the line's gauge");
    }
    warning.hidden = !problems.length;
    confirmBox.hidden = !problems.length;
    warning.textContent = problems.length ? `Check the coil: ${problems.join(', and ')}.` : '';
  }

  line.addEventListener('change', () => {
    const o = line.selectedOptions[0];
    if (o && o.value) {
      form.elements.pieces.value = Number(o.dataset.pieces) || '';
      const len = Number(o.dataset.length);
      form.elements.ft.value = len ? Math.floor(len / 12) : '';
      form.elements.inch.value = len ? inchesText(len - Math.floor(len / 12) * 12) : '';
      // Put matching coils first.
      const match = [...coil.options].find((c) => c.dataset.color === o.dataset.color && c.dataset.gauge === o.dataset.gauge);
      if (match && !coil.value) coil.value = match.value;
    }
    check(); updateFootage();
  });
  coil.addEventListener('change', () => { check(); updateFootage(); });
  form.addEventListener('input', updateFootage);
}());
