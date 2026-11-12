// Draws each PDF drawing on a cut sheet line into the page, so it prints with its line
// (Tyler 2026-11-12). Up to 4 pages per file.
(function () {
  var boxes = document.querySelectorAll('.pdf-print[data-pdf]');
  if (!boxes.length || !window.pdfjsLib) return;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  Array.prototype.forEach.call(boxes, function (box) {
    window.pdfjsLib.getDocument(box.getAttribute('data-pdf')).promise.then(function (pdf) {
      var pages = Math.min(pdf.numPages, 4);
      var chain = Promise.resolve();
      for (var n = 1; n <= pages; n += 1) {
        (function (n) {
          chain = chain.then(function () { return pdf.getPage(n); }).then(function (page) {
            var viewport = page.getViewport({ scale: 2 });
            var canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            box.appendChild(canvas);
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
          });
        }(n));
      }
      if (pdf.numPages > pages) {
        chain.then(function () {
          var p = document.createElement('p');
          p.className = 'small';
          p.textContent = (pdf.numPages - pages) + ' more page(s): open ' + box.getAttribute('data-name') + ' in the CRM.';
          box.appendChild(p);
        });
      }
    }).catch(function () {
      box.textContent = 'PDF drawing ' + box.getAttribute('data-name') + ': open it in the CRM to view or print.';
    });
  });
}());
