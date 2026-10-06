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
  - Trims, boots, jacks, screws and accessories are billed each / bag / roll.
  - Totals update as you type. Pressing Enter on a line starts the next line with
    the same panel and color, so a list of lengths goes in quickly.
  - Special-order colors add their upcharge automatically.
- **Order status**: Quote → Confirmed → In production → Ready → Completed. Completed
  orders are locked; "Invoiced" is set when an order is sent to QuickBooks.
- **Printable cut sheet** for the shop, with Completed by / Inspected by boxes.
- **Price list** loaded from the October 1, 2026 HPCM price list. Change a price on the
  Price list page and new lines use it; existing orders keep the price they were written at.
- **Suppliers and colors**: each color belongs to its supplier (the same color name from
  two suppliers is a different color). Colors can be smooth or textured and carry a price
  premium % that is added to lines in that color.

Coming next: coil and panel inventory, then sending completed orders to QuickBooks
as invoices (see the QuickBooks mapping guide), then user sign-in and going live.

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
