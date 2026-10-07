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
- **Trim at other widths**: trim with a flat width on the price list (ridge cap is 13") gets
  a width box on the order. The price scales by width and length: 10 pieces of 24" ridge cap
  at 10' bill as 10 x 24/13 = 18.46 x the 13" price.
- **Shop board** (`/board`): a full-screen page for a TV in the shop. Shows quotes out and
  approved orders (with dollars), jobs in production and ready, this week's coil feet run and
  orders finished, and the next 5 orders by Need-by date (late ones in red) with the coil
  each still needs. A coil check flags approved jobs that need more footage of a color than
  is on hand (jobs are served in due-date order; trim assumes 48" coil), and a list shows
  finished orders waiting on pickup or delivery and for how many days. Refreshes every minute.

Coming next: sending completed orders to QuickBooks as invoices (see the QuickBooks
mapping guide).

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
| `APP_PASSWORD` | Turns on a sign-in prompt. Set this before putting the app online. |
| `APP_USER` | Sign-in user name (default `hpcm`). |
| `PORT` | Web port (default 3000). |

## Putting it online (Render)

`render.yaml` sets up the app and its database on [Render](https://render.com):
in the Render dashboard choose **New → Blueprint**, pick this repository, and enter
a sign-in password when asked. The tables and price list load on the first start.
Sign in with user name `hpcm` and that password.

## Database updates

Changes to the database after the first install live in `db/migrations/` and are applied
once each, in order, by `npm run db:setup` (which runs on every start on Render).
