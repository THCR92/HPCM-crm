// Draws each PDF drawing on a line into the page, so it shows and prints with its line
// without a click (Tyler 2026-11-12). Up to 4 pages per file. Watches for lines the
// quote form redraws.
(function () {
  if (!window.pdfjsLib) return;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  var docs = {};
  var MAX_PAGES = 4;

  function draw(box) {
    box.setAttribute('data-done', '1');
    var url = box.getAttribute('data-pdf');
    var name = box.getAttribute('data-name');
    if (!docs[url]) docs[url] = window.pdfjsLib.getDocument(url).promise;
    docs[url].then(function (pdf) {
      var pages = Math.min(pdf.numPages, MAX_PAGES);
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
          p.textContent = (pdf.numPages - pages) + ' more page(s) in ' + name + '.';
          box.appendChild(p);
        });
      }
    }).catch(function () {
      box.textContent = 'PDF drawing ' + name + ' could not be shown here. Open it to view.';
    });
  }

  function scan(root) {
    var boxes = root.querySelectorAll ? root.querySelectorAll('.pdf-pages[data-pdf]:not([data-done])') : [];
    Array.prototype.forEach.call(boxes, draw);
  }
  scan(document);
  if (window.MutationObserver) {
    new MutationObserver(function () { scan(document); }).observe(document.body, { childList: true, subtree: true });
  }
}());
