// Terms and privacy pages Intuit asks for before handing out Production keys.
// Open without signing in.
const { html, layout } = require('../html');

const router = require('../async-router')();

const page = (title, body) => layout({ title, bare: true, body: html`<div class="card legal"><h1>${title}</h1>${body}</div>` });

router.get('/legal/terms', (req, res) => res.send(page('Terms of use', html`
  <p>The HPCM CRM is the private business system of High Plains Custom Metal, 805 E Fox Farm Rd Unit B, Cheyenne, WY 82007.
    It is used only by High Plains Custom Metal staff with an account issued by the company.</p>
  <p>Connecting QuickBooks lets the CRM read and write High Plains Custom Metal's own customers, products and invoices in its own
    QuickBooks company. The connection can be removed at any time from Admin &gt; QuickBooks or from QuickBooks.</p>
  <p>The software is provided as is. Questions: (307) 331-6449.</p>`)));

router.get('/legal/privacy', (req, res) => res.send(page('Privacy policy', html`
  <p>The HPCM CRM holds High Plains Custom Metal's customer and order records: names, contact details, addresses, quotes,
    orders and invoices. It is used only by company staff and is not sold or shared with anyone.</p>
  <p>With QuickBooks connected, customer, product and invoice details are exchanged only between the CRM and the company's
    own QuickBooks company. QuickBooks sign-in tokens are stored encrypted and are deleted on disconnect.</p>
  <p>To ask about or remove your information, call (307) 331-6449 or write to 805 E Fox Farm Rd Unit B, Cheyenne, WY 82007.</p>`)));

module.exports = router;
