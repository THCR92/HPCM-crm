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
