// Reports: click a column heading to sort the table by it (click again to flip).
document.querySelectorAll('table.sortable').forEach((table) => {
  table.querySelectorAll('th').forEach((th, col) => {
    th.title = 'Sort';
    th.addEventListener('click', () => {
      const numeric = th.dataset.type === 'num';
      const dir = th.dataset.dir === 'desc' ? 'asc' : numeric ? 'desc' : 'asc';
      table.querySelectorAll('th').forEach((h) => { delete h.dataset.dir; });
      th.dataset.dir = dir;
      const body = table.tBodies[0];
      const key = (tr) => tr.cells[col].dataset.v;
      const rows = [...body.rows].sort((a, b) => {
        let x = key(a);
        let y = key(b);
        if (numeric) {
          x = x === '' ? -Infinity : Number(x);
          y = y === '' ? -Infinity : Number(y);
          return dir === 'asc' ? x - y : y - x;
        }
        return dir === 'asc' ? x.localeCompare(y) : y.localeCompare(x);
      });
      rows.forEach((r) => body.appendChild(r));
    });
  });
});

// "Print this section" beside each heading: prints just that heading and what
// follows it, up to the next heading.
document.querySelectorAll('main h2[id]').forEach((h2) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn small section-print';
  btn.textContent = 'Print this section';
  btn.addEventListener('click', () => {
    const keep = new Set([h2]);
    for (let el = h2.nextElementSibling; el && !(el.tagName === 'H2' && el.id); el = el.nextElementSibling) keep.add(el);
    const hidden = [...h2.parentElement.children].filter((el) => !keep.has(el) && !el.classList.contains('printed-line'));
    hidden.forEach((el) => el.classList.add('print-hide'));
    const done = () => { hidden.forEach((el) => el.classList.remove('print-hide')); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  });
  h2.appendChild(btn);
});
