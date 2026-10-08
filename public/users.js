// Users page: picking a role ticks that role's starting permissions.
(function () {
  const form = document.querySelector('.user-form');
  if (!form) return;
  const role = form.elements.role;
  const boxes = [...form.querySelectorAll('input[name=perm]')];
  const note = form.querySelector('.admin-note');
  const sync = () => {
    const admin = role.value === 'admin';
    boxes.forEach((b) => { b.disabled = admin; if (admin) b.checked = true; });
    note.hidden = !admin;
  };
  role.addEventListener('change', () => {
    const defaults = window.ROLE_DEFAULTS[role.value] || [];
    boxes.forEach((b) => { b.checked = defaults.includes(b.value); });
    sync();
  });
  sync();
}());
