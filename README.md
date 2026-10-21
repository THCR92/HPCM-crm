# HPCM CRM

Order and customer system for **High Plains Custom Metal** (Cheyenne, WY).
It replaces the paper cut sheet: you enter each order the way you fill out the
sheet (Roof / Wall / Trim sections, quantity, length, panel, gauge, color) and it
works out the square feet, linear feet and price for every line.

## What it does today

- **Customers**: contractors and homeowners with phone, email, terms and tax status.
- **Orders (cut sheets)**: header fields from the paper sheet (job name, PO, need-by
  date, job address, pickup or delivery) and Roof / Wall / Trim / Other sections.
  - Lengths are entered in feet and inches (`16` ft `3 1/2` in).
  - Board & Batten, Snap Lock and Nail Flange are billed **per sq ft** of coverage
    (Snap Lock / Nail Flange coverage is chosen per line, 16"–18").
  - PBR/R and Tuff Rib are billed **per linear foot**.
  - Custom trim is billed per sq ft using its girth (flat width).
  - Trims, boots, jacks, screws and accessories are billed each / bag / roll. Trim and
    downspouts are priced per 10' piece; other lengths (trim up to 20') bill in proportion,
    so 6 pieces at 12' = 7.2 × the 10' price.
  - Totals update as you type. Pressing Enter on a line starts the next line with
    the same panel and color, so a list of lengths goes in quickly.
  - Special-order colors add their upcharge automatically.
- **Order status**: Quote → Confirmed → In production → Ready → Completed. Completed
  orders are locked; "Invoiced" is set when an order is sent to QuickBooks.
- **Printable cut sheet** for the shop, with Completed by / Inspected by boxes.
- **Price list** loaded from the October 1, 2026 HPCM price list. Change a price on the
  Price list page and new lines use it; existing orders keep the price they were written at.
- **Suppliers and colors**: each color belongs to its supplier (the same color name from
  two suppliers is a different color). Colors have a finish (Smooth, Textured, Metallic, Premium, PVDF heat-reflective, or one you add), the same color name can be listed in several finishes, and carry a price
  premium % that is added to lines in that color.

- **Coils**, tracked by linear feet: receive each coil by tag (color sets the supplier),
  see feet on hand per coil and totals by color, gauge and width, correct a coil's footage
  after measuring it, and close out used-up or returned coils. Weight is optional.
- **Production** on each order: log which coil each line was run from. Coil feet used
  default to pieces × length (plus scrap). The form warns when a coil doesn't match the
  line's color (including the same color name from another supplier) or gauge. For trim
  with a flat width set on the Price list, pieces that fit side by side across the coil
  (e.g. four 12" pieces across a 48" coil) share the same footage. Runs can
  be undone, and the first run moves a confirmed order to In production.
- **Stock**: panels and trim cut ahead or left over, by product, color and length. Add
  pieces (optionally cut from a coil) and take them out when sold or scrapped.
- **Trim widths (flat)**: every trim line has a width box, and the width is the FLAT width (inches
  of coil), which coil footage uses. The Price column is the price of one piece at that width, so
  Price x Qty = Amount. 26 ga trim (trim with no gauge on the price list counts as 26 ga) is $3.40
  per flat inch (products.price_per_flat_in); a new line starts at the width its list price is for
  ($20.40 / $3.40 = 6"). That includes ridge cap at its standard width: 14" flat (13" finished) = $47.60,
  25" flat = $85.00. Trim without a rate but with a standard flat width scales its list price per
  standard finished inch.
- **Quotes first**: "+ Quote" at the start of the menu and "New quote" buttons; a quote turns
  into an order when it's approved.
- **Customer quote / copy** (`/orders/:id/customer`): what the customer sees. One price per
  piece (the line amount over the pieces), no billing units, colors without the coil supplier.
  Print it, or Save as PDF to email. Quotes show "Valid until" (30 days).
- **Sales tax**: a default rate (set on the Price list page) is copied onto each new order and
  can be changed per order. Tax is on taxable materials after the discount; delivery isn't
  taxed. Tax-exempt customers pay none. Totals everywhere include tax. Default 5% (Cheyenne).
- **Users and roles**: everyone signs in with their email and own password. Roles are Admin,
  Manager, Sales and Production; each role ticks a starting set of permissions that an Admin can
  change per person (Admin > Users). Admins can always do everything: users, prices, sales tax,
  products, colors, finishes and suppliers (Admin page). Production doesn't see prices. Orders
  record who wrote, approved and last changed them.
- **Screws and clips**: new quotes figure them from the panels, trim and accessories (Screws section
  at the bottom). Rules live in Admin > Screws and clips (Admins and Managers; also linked from the
  Price list). Panels: PBR and Tuff Rib on wood use #10 1.5 Woodtite (or 2 1/2" Woodtite) and on steel
  1.25" Self Drilling, 90 per square; 1" Nail Flange uses 1" Panhead, 1 every 2'; Snap Lock uses 1 clip
  and 2 panheads every 2'. Trim: ridge cap 2 every 18" (or 9", picked on the line), gable trim 2 every
  2', using the same screw as the panels. Trim screws match the trim color and are their own lines;
  the quote picks which screws trim gets (starting from its panels). Totals round up to bags of 250.
  Untick "Figure screws automatically" to type them in instead.
- **Closures**: new quotes add 1 inside and 1 outside closure for every PBR panel (PBR Closure) and
  Tuff Rib panel (Inner/Outer Closure), in their own Closures section. Each quote (in the shop or the
  customer portal) picks Standard, Vented (the outside closure is "Vented Closure (through fastener)")
  or No closures. Quotes made before this start on No closures. In the shop (not the portal) the
  figured counts can be changed on the quote (0 takes a line off; "Use 48" puts it back). Screws and
  Closures each have "+ Add line" for extra lines that stay put when the figured lines are redone.
  Trim with no color gets its screws in the panel color (roof panels first), on the panel screw line.
- **Accessories reminder**: the quote form won't save until the box by the Save button is ticked to
  say any other accessories (pipe boots, jacks, butyl tape, sealant) have been added.
- **Drawings**: attach a PDF or picture (for example a reMarkable trim sketch with face lengths
  and bends) to the whole order or to one line, under "Drawings & files" on the order page.
  The line shows a 📎 link; pictures print on their own page after the cut sheet. Files are
  stored in the database (up to 20 MB each) and never appear on the customer copy.
- **Approving quotes**: a quote needs a Need-by date before it can be approved, and the order
  date becomes the day it was approved.
- **Shop board** (`/board`): a full-screen page for a TV in the shop. Shows quotes out and
  approved orders (with dollars), jobs in production and ready, this week's coil feet run and
  orders finished, and the next 5 orders by Need-by date (late ones in red) with the coil
  each still needs. A coil check flags approved jobs that need more footage of a color than
  is on hand (jobs are served in due-date order; trim assumes 48" coil), and a list shows
  finished orders waiting on pickup or delivery and for how many days. Refreshes every minute.
- **Supplies** (`/supplies`): boots, jacks, screws and accessories counted on hand (screws by
  color). Receive, count or take out; set a reorder point and where it's kept; "Running low"
  lists anything at or under its reorder point or short for open orders. Supplies on an order
  come out of stock when the order is marked Completed and go back if it is reopened. Any
  product can be counted by ticking "Count on hand" in Admin > Products.
  Costs: enter what you paid each when receiving (it blends into an average cost per item) or
  counting (it sets the average); it can also be set on the item's page. The page shows cost
  each, value on hand and margin against the price list; supplies used on orders carry their
  cost into Reports (Inventory: value at cost of coil, supplies and tools, and supplies used
  with cost, sold-for and margin). Tools show their cost and the rent billed against it.
- **Printing and count sheets**: every page under the Reports menu has a Print button (Reports
  can also print one section). Coils, Finished stock, Supplies and Tools have a "Count sheet"
  (`/count-sheets/...`): a paper sheet listing what the CRM has, with blank Counted and Notes
  columns, spare rows for anything missing, and a sign-off line. "Blind count" hides the CRM's
  numbers so counters write what they see. Enter the counts back on that page afterward.
- **Tools** (`/tools`): every tool the shop owns, with tag and serial numbers, cost and where
  it's kept, and its status (available, in for repair, retired, or out with a customer). A
  tool can be rented as a price list item ("Hand seamer rental (per day)"); put it on a quote
  with the quantity as the number of days, and once the quote is approved check the tool out
  ("Picked up", with a due-back date) and back in ("Returned", with a note) at the bottom of
  the order. Overdue tools are flagged, and the order shows when a tool was out longer than billed.
- **Barcodes**: every label has a QR code holding a link (`/s/<code>`), so a phone camera opens
  the page, and a 2D barcode scanner (it types what it reads) works in the "Scan or type a code"
  box on every page. Codes: `HP-10023` order, `L<id>` order line, `C<id>` coil, `S<id>` supply
  shelf, `T<id>` tool (coil and tool tags typed by hand work too). Labels print from the order
  (one for the whole order and one per line), Coils, Supplies and Tools pages, on Avery 5163
  sheets (4" x 2", 10 per page) or label printers (4" x 2" or 2.25" x 1.25").
- **Pack and check** (`/orders/:id/pack`, Production permission): scan each line's label as its
  bundle is checked against the order. Labels from another order are flagged, and a line can be
  checked without its label. When every line is checked the order is marked Ready
  (inspected by = whoever checked). Editing the order clears its checks.
  Lines are packed in bundles, set on the pack page before checking: type how many go in a
  bundle ("10" makes 26 pieces 10 + 10 + 6; the CRM remembers it as the usual for that item,
  drip edge 2x2, 2x4 and D style start at 10) or each bundle's count ("13, 13"). There is one
  label per bundle (`B<id>`).
  Each cut-sheet line is one length, so panels of different lengths are always separate bundles.
- **Pickup and delivery** (`/orders/:id/handoff`, Production or Quotes permission): scanning the
  whole-order label of a Ready order opens this page (so does the "Picked up…/Delivered…" button).
  Pick pickup or delivery, type who received it and an optional note, and the order is marked
  Completed with who handed it off and when. Unchecked bundles block it unless "Send it without every bundle
  checked" is ticked; rental tools not yet checked out are flagged.
- **Reports** (`/reports`, Admins and Managers): pick a date range (or a preset like This
  year) and see sales, quotes written, quote win rate (by count and dollars), average order,
  days from quote to approval, open quotes and work in the shop, quoted vs sold by week or
  month, why quotes were lost, pickup vs delivery, biggest customers (with new customers
  marked), sales by customer type, most popular colors, panels by profile and gauge, sales by
  product type, top items, the sales team, coil feet run, scrap, on-time finishing, lead time,
  late orders, production by person, coil used by color, coil on hand with weeks left, and
  coil received. Headline numbers show the change from the same number of days before.
  Click a column to sort; every table downloads as a spreadsheet (CSV). Every status change
  is recorded (`order_status_history`), and cancelling a quote asks why it was lost.

- **Customer portal** (`/portal`): off for each customer until a Manager or Admin turns it on
  (customer page > Customer portal), with "Show line prices" and "Show order totals" per customer.
  One login per customer; adding it gives a link (emailed, or copy it) to set their own password.
  Customers see their quotes and orders with a status tracker, and approve (ticking that they
  checked lengths, quantities and colors, with a need-by date and PO) or decline with a reason.
  Approved quotes stay quotes until the shop confirms them (Orders > "Customer approved" tab).
  Changing an approved quote's lines or prices asks the customer again. Staff can hide a quote
  from the portal. Customer logins are separate from staff accounts (own table, cookie, sessions).
  Customers can also start a quote with the same quote form (priced from the price list; items
  without a list price and services are left out; delivery, discounts and tax stay ours), change
  it until they answer it, "Order again" from a past order, and add drawings (PDF or pictures) to
  a quote or open order. A price staff set on a line stays if the customer edits the quote.
- **Length check photos** (order page and Pack & check, `src/proof.js`): every line that leaves
  the shop (panels, trim, closures, screws, accessories; not services or tool rentals) needs a
  photo of its pieces with a tape measure before the order can be marked Ready, or picked up or
  delivered without going through Ready. On a phone the Photo button opens the camera; photos are
  shrunk to 1600 px before upload. Customers see them in the portal under "Photos of your order".
- **Email** (`src/mail.js`, set `SMTP_USER` and `SMTP_PASS` on Render to a Gmail address and an
  App Password): portal invites and forgot-password links, Admins and Managers hear when a
  customer approves or declines, and customers hear when an order is ready. Without it, links
  are copied by hand. Every email is logged in `email_log`.
- **Deleting** (Admins only, type DELETE to confirm): a customer with no quotes or orders, and a
  quote or cancelled order with no coil run against it and no rental tool still out. Anything else
  is cancelled or left as is, so its history stays. Deleting a customer doesn't touch QuickBooks.
- **QuickBooks** (Admin > QuickBooks, Admins only): connect once, then
  - customers added or edited in the CRM are added or updated in QuickBooks right away;
  - customers added or edited in QuickBooks come into the CRM by webhook (`/qbo/webhook`), with a
    check for changes every 10 minutes in case one is missed. QuickBooks sub-customers (jobs) are skipped;
  - an order becomes a QuickBooks invoice when it is completed (picked up or delivered): same
    number, one line per cut-sheet line with its quantity, length and price, plus delivery, discount,
    deposit and the CRM's sales tax. Price list items are added to QuickBooks as products the first
    time they are invoiced. With the real company the order then reads Invoiced and is locked; with
    the test (sandbox) company it stays Completed.
  - estimates written in QuickBooks (from when the connection was made on) come in as quotes, by
    webhook or the same 10-minute check. A line whose QuickBooks item is a piece-priced CRM product
    becomes that product; any other line becomes "Item from QuickBooks" (`QBO-ITEM`) with the item's
    name, quantity and rate. A "Delivery" item goes to the delivery charge, a discount line to the
    discount. Changes to the estimate keep coming through until someone saves the quote in the CRM;
    after that the CRM's version stands. The invoice links the estimate (closing it in QuickBooks) and
    keeps each line's QuickBooks item (migration 036).
  Customers and orders show where they stand, with a "Send to QuickBooks" button to retry.
  QuickBooks works out the tax from the invoice's ship-to address: the shop for pickups, the job's
  saved address for deliveries. While the test company is connected, Admin > QuickBooks lists the
  steps to switch to the real books and can remove the customers that came from the test company
  (`customers.created_from_qbo`, only ones without orders). Intuit's app details point at
  `/legal/terms` and `/legal/privacy`, which open without signing in.
  Connecting a different company (test, then real) forgets the old company's ids. Tokens are
  stored encrypted. Every call is listed under Recent activity (`qbo_sync_log`).

## How it's built

- `db/schema.sql` – the PostgreSQL database design (coils, finished panels, trim,
  customers, orders, QuickBooks sync).
- `db/price_list.sql` – the rest of the HPCM price list.
- `db/sample_data.sql` – one example customer and order.
- `src/` – the web app (Node.js + Express). `public/` – styles and the order form script.

## Running it on a computer (for developers)

Needs Node.js 20+ and PostgreSQL 15+.

```bash
npm install
export DATABASE_URL=postgres://user:password@localhost:5432/hpcm
npm run db:setup        # or: npm run db:sample  (adds an example order)
npm start               # open http://localhost:3000
npm test                # runs the tests against the same database
```

Settings (environment variables):

| Name | What it does |
| --- | --- |
| `DATABASE_URL` | Where the database is. |
| `DATABASE_SSL` | `true` when the database host requires SSL (most hosted databases). |
| `APP_PASSWORD` | Needed once, to create the first Admin account (see Users below). |
| `PORT` | Web port (default 3000). |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | Keys from the Intuit developer app (QuickBooks). |
| `QBO_ENVIRONMENT` | `sandbox` (test company, the default) or `production` (the real books). |
| `QBO_WEBHOOK_TOKEN` | Optional: the Intuit app's webhook verifier token, to check webhooks are from QuickBooks. |
| `QBO_REDIRECT_URI` | Optional: defaults to `https://www.hpcmcrm.net/qbo/callback` on Render. |

## Putting it online (Render)

`render.yaml` sets up the app and its database on [Render](https://render.com):
in the Render dashboard choose **New → Blueprint**, pick this repository, and enter
a sign-in password when asked. The tables and price list load on the first start.
The first visit asks you to create the Admin account (your name, email and password, plus that
shared password). Everyone else is added on Admin > Users.

## Database updates

Changes to the database after the first install live in `db/migrations/` and are applied
once each, in order, by `npm run db:setup` (which runs on every start on Render).
