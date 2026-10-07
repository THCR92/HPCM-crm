// Order page: "Attach" form for drawings. Sends the file as-is; the server
// stores it with the order (or the chosen line) and the page reloads.
(function () {
  const form = document.querySelector('.attach-form');
  if (!form) return;
  const status = form.querySelector('.attach-status');
  const MAX = 20 * 1024 * 1024;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = form.elements.file.files[0];
    if (!file) return;
    if (file.size > MAX) { status.textContent = 'That file is over 20 MB. Export a smaller PDF or a PNG.'; return; }
    const params = new URLSearchParams();
    if (form.elements.line.value) params.set('line', form.elements.line.value);
    if (form.elements.note.value.trim()) params.set('note', form.elements.note.value.trim());
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Uploading…';
    try {
      const res = await fetch(`${form.dataset.action}?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: file,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'The upload didn\'t go through. Try again.');
      window.location.hash = `drawing-${out.attachment_id}`;
      window.location.reload();
    } catch (err) {
      status.textContent = err.message;
      button.disabled = false;
    }
  });
}());
