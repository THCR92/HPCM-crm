// Length check photos: picking (or taking) a photo uploads it right away, shrunk
// to 1600 px so phone photos stay small. Used on the order and Pack & check pages.
(function () {
  const MAX = 1600;
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    try {
      const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.82));
    } catch (err) {
      return file;
    }
  }
  document.querySelectorAll('.photo-form').forEach((form) => {
    const input = form.querySelector('input[type=file]');
    const status = form.querySelector('.photo-status');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      status.textContent = 'Uploading…';
      try {
        const body = await shrink(file);
        const res = await fetch(form.dataset.action, {
          method: 'POST',
          headers: { 'Content-Type': body.type || 'image/jpeg', 'X-Filename': encodeURIComponent(file.name.replace(/\.\w+$/, '.jpg')) },
          body,
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'The photo didn\'t upload. Try again.');
        window.location.reload();
      } catch (err) {
        status.textContent = err.message;
      }
    });
  });
}());
