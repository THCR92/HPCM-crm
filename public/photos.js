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
  // Each picker on the form (camera, or several photos from the phone) uploads in turn.
  document.querySelectorAll('.photo-form').forEach((form) => {
    const status = form.querySelector('.photo-status');
    form.querySelectorAll('input[type=file]').forEach((input) => input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      try {
        for (let i = 0; i < files.length; i += 1) {
          status.textContent = files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…';
          const body = await shrink(files[i]);
          const res = await fetch(form.dataset.action, {
            method: 'POST',
            headers: { 'Content-Type': body.type || 'image/jpeg', 'X-Filename': encodeURIComponent(files[i].name.replace(/\.\w+$/, '.jpg')) },
            body,
          });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || 'The photo didn\'t upload. Try again.');
        }
        window.location.reload();
      } catch (err) {
        status.textContent = err.message;
      }
    }));
  });
}());
