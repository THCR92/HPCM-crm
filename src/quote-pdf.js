// The customer's quote (or order) as a PDF, attached when the CRM emails it
// (Tyler 2026-11-09). Same content as the customer copy page: one price per piece,
// no billing units, no coil supplier.
const path = require('path');
const PDFDocument = require('pdfkit');

const NAVY = '#1d315e';
const MUTED = '#5b6573';
const LINE = '#d9dde2';
const LOGO = path.join(__dirname, '..', 'public', 'logo.png');
const SHOP = '805 E Fox Farm Rd Unit B · Cheyenne, WY 82007 · (307) 331-6449';

const money = (n) => (n === null || n === undefined || n === '' ? ''
  : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const num = (n, d = 2) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const usDate = (d) => {
  if (!d) return '';
  const s = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const [y, m, day] = s.split('-');
  return `${Number(m)}/${Number(day)}/${y}`;
};

// o: an order from loadOrder(); sizeCol(i) and areaLabel(section) come from the order page.
function quotePdf(o, { sizeCol, areaLabel }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40, info: { Title: `${o.order_number}`, Author: 'High Plains Custom Metal' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const isQuote = o.status === 'quote';
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;

    // Header: logo and address on the left, document name and number on the right.
    doc.image(LOGO, left, 36, { width: 130 });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(SHOP, left, 108);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text(isQuote ? 'QUOTE' : 'ORDER', left, 40, { width, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text(o.order_number, { width, align: 'right' });
    doc.font('Helvetica').fontSize(10).text(usDate(isQuote ? o.quoted_on : o.ordered_on), { width, align: 'right' });
    doc.moveTo(left, 124).lineTo(left + width, 124).lineWidth(1.5).strokeColor(NAVY).stroke();

    // Customer and job.
    const fields = [
      ['Customer', o.customer_name], ['Job name', o.job_name],
      ['Project / PO #', o.po_number], [isQuote ? 'Valid until' : 'Need by', usDate(isQuote ? o.valid_until : o.need_by)],
      ['Job address', o.job_address_text], [o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup', o.fulfillment === 'delivery' ? 'Delivered' : 'Customer pickup'],
    ];
    let y = 134;
    const half = width / 2;
    fields.forEach(([k, v], i) => {
      const x = left + (i % 2) * half;
      if (i % 2 === 0 && i) y += 16;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(k, x, y, { width: 80 });
      doc.font('Helvetica').fontSize(10).fillColor('black').text(v || '', x + 82, y - 1, { width: half - 90, height: 13, ellipsis: true });
    });
    y += 26;

    // Lines, by section.
    const cols = [
      { key: 'qty', label: 'Qty', w: 38, align: 'right' }, { key: 'len', label: 'Length', w: 52 },
      { key: 'item', label: 'Item', w: 168 }, { key: 'color', label: 'Color', w: 92 }, { key: 'size', label: 'Size', w: 62 },
      { key: 'each', label: 'Price each', w: 62, align: 'right' }, { key: 'amt', label: 'Amount', w: 58, align: 'right' },
    ];
    const scale = width / cols.reduce((a, c) => a + c.w, 0);
    cols.forEach((c) => { c.w *= scale; });
    const row = (vals, { bold = false, color = 'black', size = 9 } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
      const heights = cols.map((c) => doc.heightOfString(String(vals[c.key] ?? ''), { width: c.w - 6 }));
      const h = Math.max(...heights) + 6;
      if (y + h > doc.page.height - doc.page.margins.bottom - 20) { doc.addPage(); y = doc.page.margins.top; }
      let x = left;
      for (const c of cols) {
        doc.text(String(vals[c.key] ?? ''), x + 3, y + 3, { width: c.w - 6, align: c.align || 'left' });
        x += c.w;
      }
      y += h;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(LINE).stroke();
    };
    for (const sec of o.sections.filter((s) => s.items.length)) {
      if (y > doc.page.height - 140) { doc.addPage(); y = doc.page.margins.top; }
      y += 6;
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(areaLabel(sec).toUpperCase(), left, y);
      y += 15;
      row(Object.fromEntries(cols.map((c) => [c.key, c.label])), { bold: true, color: MUTED, size: 8 });
      for (const i of sec.items) {
        row({
          qty: num(i.pieces), len: i.length_display || '',
          item: `${i.product_name}${i.description ? `\n${i.description}` : ''}`,
          color: i.customer_color || '', size: sizeCol(i, { shop: false }) || '',
          each: money(i.pieces ? i.line_total / i.pieces : i.line_total), amt: money(i.line_total),
        });
      }
    }

    // Notes on the left, totals on the right.
    y += 12;
    if (y > doc.page.height - 170) { doc.addPage(); y = doc.page.margins.top; }
    const top = y;
    const notes = [
      o.customer_memo ? `Notes: ${o.customer_memo}` : '',
      isQuote ? `Prices are good until ${usDate(o.valid_until)}. Lengths and quantities are cut exactly as listed, so please check them before approving.` : '',
    ].filter(Boolean).join('\n\n');
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(notes, left, top, { width: width * 0.52 });
    const totals = [
      ['Materials', money(o.lines_subtotal)],
      ...(Number(o.delivery_charge) ? [['Delivery', money(o.delivery_charge)]] : []),
      ...(Number(o.discount_amount) ? [['Discount', `-${money(o.discount_amount)}`]] : []),
      ['Subtotal', money(o.pre_tax_total)],
      [o.tax_exempt_effective ? 'Sales tax (exempt)' : `Sales tax (${num(o.tax_rate, 3)}%)`, money(o.tax_amount)],
      ['Total', money(o.grand_total)],
      ...(Number(o.deposit_amount) ? [['Deposit received', `-${money(o.deposit_amount)}`], ['Balance due', money(o.grand_total - o.deposit_amount)]] : []),
    ];
    const tx = left + width * 0.58;
    const tw = width * 0.42;
    let ty = top;
    for (const [k, v] of totals) {
      const grand = k === 'Total';
      if (grand) { doc.moveTo(tx, ty).lineTo(tx + tw, ty).lineWidth(1).strokeColor(NAVY).stroke(); ty += 3; }
      doc.font(grand ? 'Helvetica-Bold' : 'Helvetica').fontSize(grand ? 11 : 9.5).fillColor(grand ? 'black' : MUTED)
        .text(k, tx, ty, { width: tw * 0.55 });
      doc.fillColor('black').text(v, tx + tw * 0.55, ty, { width: tw * 0.45, align: 'right' });
      ty += grand ? 18 : 15;
    }
    doc.end();
  });
}

module.exports = { quotePdf };
