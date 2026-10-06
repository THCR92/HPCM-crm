-- =============================================================================
-- High Plains Custom Metal (HPCM) CRM
-- PostgreSQL schema: coil inventory, finished panel inventory, custom trim,
-- customers, orders, production, and QuickBooks Online sync bookkeeping.
--
-- Target: PostgreSQL 15+ (uses UNIQUE NULLS NOT DISTINCT; tested on 16).
-- Run:    psql -d hpcm -f hpcm_crm_schema.sql
--
-- Conventions
--   * Lengths are stored in INCHES (numeric, fractions allowed). The cut sheet's
--     feet' inches" is a display format; see fn_format_length().
--   * Coil weight is stored in POUNDS.
--   * Money is numeric(12,2); unit prices numeric(12,4) (QBO accepts >2 dp).
--   * Every order line carries its own pricing unit (sqft | lf | each | bag |
--     roll), so mixed sqft and linear-foot panels sit on one order/invoice.
--   * Prices and widths are SNAPSHOTTED onto order lines so later price-list
--     changes never alter a completed order.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS hpcm;
SET search_path = hpcm, public;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------
CREATE TYPE pricing_unit       AS ENUM ('sqft', 'lf', 'each', 'bag', 'roll');
CREATE TYPE product_category   AS ENUM ('panel', 'trim', 'custom_trim', 'flat_sheet',
                                        'boot', 'jack', 'fastener', 'accessory',
                                        'service', 'delivery');
CREATE TYPE panel_fastening    AS ENUM ('concealed', 'through_fastened');
CREATE TYPE panel_application  AS ENUM ('roof', 'wall', 'roof_or_wall');
CREATE TYPE coil_status        AS ENUM ('received', 'in_stock', 'on_machine',
                                        'depleted', 'scrapped', 'returned');
CREATE TYPE coil_txn_type      AS ENUM ('receive', 'production', 'scrap',
                                        'reweigh_adjust', 'return_to_vendor');
CREATE TYPE fg_txn_type        AS ENUM ('produce', 'sell', 'adjust', 'scrap', 'return');
CREATE TYPE customer_type      AS ENUM ('contractor', 'homeowner', 'commercial', 'dealer', 'other');
CREATE TYPE address_type       AS ENUM ('billing', 'shipping', 'job_site');
CREATE TYPE order_status       AS ENUM ('quote', 'confirmed', 'in_production',
                                        'ready', 'completed', 'invoiced', 'cancelled');
CREATE TYPE fulfillment_method AS ENUM ('pickup', 'delivery');
CREATE TYPE order_area         AS ENUM ('roof', 'wall', 'trim', 'other');
CREATE TYPE qbo_sync_status    AS ENUM ('not_synced', 'pending', 'synced', 'error', 'voided');

-- -----------------------------------------------------------------------------
-- Shared trigger: updated_at
-- -----------------------------------------------------------------------------
CREATE FUNCTION fn_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- Display helper: 174.5 -> 14' 6-1/2"  (rounds to nearest 1/16")
CREATE FUNCTION fn_format_length(p_inches numeric) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    ft      int;
    inch    numeric;
    whole   int;
    frac16  int;
    g       int;
BEGIN
    IF p_inches IS NULL THEN RETURN NULL; END IF;
    ft     := floor(p_inches / 12);
    inch   := round((p_inches - ft * 12) * 16) / 16;
    IF inch >= 12 THEN ft := ft + 1; inch := inch - 12; END IF;
    whole  := floor(inch);
    frac16 := round((inch - whole) * 16);
    IF frac16 = 0 THEN
        RETURN format('%s'' %s"', ft, whole);
    END IF;
    g := gcd(frac16, 16);
    RETURN format('%s'' %s-%s/%s"', ft, whole, frac16 / g, 16 / g);
END $$;

-- =============================================================================
-- 1. REFERENCE DATA
-- =============================================================================

-- Steel gauges. weight_lb_per_sqft drives coil-weight <-> footage estimates.
CREATE TABLE gauges (
    gauge_id            smallserial PRIMARY KEY,
    gauge               smallint      NOT NULL UNIQUE,          -- 22, 24, 26, 29
    nominal_thickness_in numeric(6,4) NOT NULL,
    weight_lb_per_sqft  numeric(6,4)  NOT NULL CHECK (weight_lb_per_sqft > 0),
    notes               text
);

CREATE TABLE colors (
    color_id            serial PRIMARY KEY,
    name                text          NOT NULL UNIQUE,          -- "Charcoal Gray"
    manufacturer_code   text,                                   -- supplier color code
    paint_system        text,                                   -- SMP, PVDF, Galvalume (bare)
    is_stock_color      boolean       NOT NULL DEFAULT true,    -- price list = stock colors
    special_order_upcharge_pct numeric(5,2) NOT NULL DEFAULT 0, -- applied to unit price if not stock
    active              boolean       NOT NULL DEFAULT true
);

CREATE TABLE suppliers (
    supplier_id         serial PRIMARY KEY,
    name                text          NOT NULL UNIQUE,
    phone               text,
    email               text,
    notes               text,
    qbo_vendor_id       text          UNIQUE
);

CREATE TABLE stock_locations (
    location_id         serial PRIMARY KEY,
    code                text          NOT NULL UNIQUE,          -- "COIL-RACK-A3", "YARD-2"
    description         text
);

-- Roll-formed panel profiles. pricing_unit is the rule the user gave:
--   Board & Batten, Snap Lock, Nail Flange standing seam -> sqft
--   Through-fastened (PBR/R, Tuff Rib)                    -> lf
CREATE TABLE panel_profiles (
    profile_id          serial PRIMARY KEY,
    name                text          NOT NULL UNIQUE,
    fastening           panel_fastening   NOT NULL,
    application         panel_application NOT NULL,
    pricing_unit        pricing_unit  NOT NULL CHECK (pricing_unit IN ('sqft','lf')),
    -- Coverage width can vary per job (Snap Lock / Nail Flange run 16"-18"), so the
    -- profile holds the allowed range plus a default; each order line stores the
    -- width actually run in order_items.width_in.
    coverage_width_in   numeric(6,3)  NOT NULL CHECK (coverage_width_in > 0),   -- default
    min_coverage_in     numeric(6,3)  NOT NULL CHECK (min_coverage_in > 0),
    max_coverage_in     numeric(6,3)  NOT NULL,
    coil_width_in       numeric(6,3)  CHECK (coil_width_in > 0),  -- typical coil fed (info only; actual = coils.width_in)
    rib_height_in       numeric(5,3),
    min_length_in       numeric(7,3)  NOT NULL DEFAULT 12,
    max_length_in       numeric(7,3)  NOT NULL DEFAULT 600,
    active              boolean       NOT NULL DEFAULT true,
    CHECK (coverage_width_in BETWEEN min_coverage_in AND max_coverage_in),
    CHECK (max_length_in > min_length_in)
);

-- Standard trim shapes (Ridge Cap, Eave Drip, J-Channel, ...). A trim type
-- describes the shape; pricing lives on the product row.
CREATE TABLE trim_types (
    trim_type_id        serial PRIMARY KEY,
    name                text          NOT NULL UNIQUE,
    girth_in            numeric(6,3),                           -- flat stretch-out width
    bend_count          smallint,
    standard_length_in  numeric(7,3)  NOT NULL DEFAULT 120,     -- price list = 10' pieces
    drawing_url         text,
    active              boolean       NOT NULL DEFAULT true
);

-- =============================================================================
-- 2. PRODUCT CATALOG / PRICE LIST
-- =============================================================================

-- One row per sellable item. This is also the 1:1 map to a QuickBooks Item.
-- Panels are one product per profile+gauge (color goes on the line), matching
-- the price list ("Snap Lock 1.5\" 24 GA").
CREATE TABLE products (
    product_id          serial PRIMARY KEY,
    sku                 text          NOT NULL UNIQUE,
    name                text          NOT NULL,
    category            product_category NOT NULL,
    profile_id          int           REFERENCES panel_profiles,
    trim_type_id        int           REFERENCES trim_types,
    gauge_id            smallint      REFERENCES gauges,
    pricing_unit        pricing_unit  NOT NULL,
    is_cut_to_length    boolean       NOT NULL DEFAULT false,   -- requires length on order lines
    standard_length_in  numeric(7,3),                           -- e.g. 120 for "Each" trims
    pack_size           int,                                    -- 250 for screws/bag
    price_varies        boolean       NOT NULL DEFAULT false,   -- "Pricing Varies by Size"
    taxable             boolean       NOT NULL DEFAULT true,
    income_account      text,                                   -- informational; QBO Item holds the account
    -- QuickBooks Online link
    qbo_item_id         text          UNIQUE,
    qbo_item_name       text,                                   -- Item.Name (max 100 chars)
    active              boolean       NOT NULL DEFAULT true,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CHECK (category <> 'panel' OR (profile_id IS NOT NULL AND gauge_id IS NOT NULL)),
    CHECK (category <> 'custom_trim' OR pricing_unit = 'sqft'),
    CHECK (qbo_item_name IS NULL OR length(qbo_item_name) <= 100)
);
CREATE INDEX products_category_idx ON products (category) WHERE active;
CREATE TRIGGER products_touch BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Price history. Current price = latest effective_from <= today.
CREATE TABLE product_prices (
    product_price_id    serial PRIMARY KEY,
    product_id          int           NOT NULL REFERENCES products ON DELETE CASCADE,
    unit_price          numeric(12,4) NOT NULL CHECK (unit_price >= 0),
    effective_from      date          NOT NULL,
    source              text,                                   -- "Price List 2026-10-01"
    UNIQUE (product_id, effective_from)
);

CREATE VIEW v_current_prices AS
SELECT DISTINCT ON (pp.product_id)
       pp.product_id, pp.unit_price, pp.effective_from
FROM   product_prices pp
WHERE  pp.effective_from <= current_date
ORDER  BY pp.product_id, pp.effective_from DESC;

-- =============================================================================
-- 3. COIL INVENTORY (tracked individually by coil tag)
-- =============================================================================

CREATE TABLE coils (
    coil_id             serial PRIMARY KEY,
    coil_tag            text          NOT NULL UNIQUE,          -- tag number on the coil
    heat_number         text,                                   -- mill heat / lot, optional
    supplier_id         int           REFERENCES suppliers,
    supplier_po         text,
    gauge_id            smallint      NOT NULL REFERENCES gauges,
    color_id            int           NOT NULL REFERENCES colors,
    width_in            numeric(6,3)  NOT NULL CHECK (width_in > 0),
    initial_weight_lb   numeric(10,2) NOT NULL CHECK (initial_weight_lb > 0),
    current_weight_lb   numeric(10,2) NOT NULL,                 -- maintained by coil_transactions
    cost_per_lb         numeric(10,4),
    received_on         date          NOT NULL DEFAULT current_date,
    status              coil_status   NOT NULL DEFAULT 'in_stock',
    location_id         int           REFERENCES stock_locations,
    mill_cert_url       text,
    notes               text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CHECK (current_weight_lb >= 0 AND current_weight_lb <= initial_weight_lb)
);
CREATE INDEX coils_lookup_idx ON coils (gauge_id, color_id, width_in)
    WHERE status IN ('in_stock', 'on_machine');
CREATE TRIGGER coils_touch BEFORE UPDATE ON coils
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Weight ledger. weight_delta_lb is negative for consumption.
CREATE TABLE coil_transactions (
    coil_txn_id         bigserial PRIMARY KEY,
    coil_id             int           NOT NULL REFERENCES coils,
    txn_type            coil_txn_type NOT NULL,
    weight_delta_lb     numeric(10,2) NOT NULL,
    production_run_id   bigint,                                 -- FK added below
    performed_by        text,
    note                text,
    occurred_at         timestamptz   NOT NULL DEFAULT now(),
    CHECK ((txn_type = 'receive' AND weight_delta_lb > 0)
        OR (txn_type IN ('production','scrap','return_to_vendor') AND weight_delta_lb < 0)
        OR  txn_type = 'reweigh_adjust')
);
CREATE INDEX coil_txn_coil_idx ON coil_transactions (coil_id, occurred_at);

-- Keep coils.current_weight_lb in sync and auto-deplete empty coils.
CREATE FUNCTION fn_apply_coil_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.txn_type = 'receive' THEN
        RETURN NEW;  -- receipt weight is set on the coil row itself
    END IF;
    UPDATE coils
       SET current_weight_lb = current_weight_lb + NEW.weight_delta_lb,
           status = CASE WHEN current_weight_lb + NEW.weight_delta_lb <= 0
                         THEN 'depleted'::coil_status ELSE status END
     WHERE coil_id = NEW.coil_id;
    RETURN NEW;
END $$;
CREATE TRIGGER coil_txn_apply AFTER INSERT ON coil_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_apply_coil_txn();

-- Log the receipt automatically when a coil is entered.
CREATE FUNCTION fn_coil_received() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO coil_transactions (coil_id, txn_type, weight_delta_lb, note)
    VALUES (NEW.coil_id, 'receive', NEW.initial_weight_lb, 'Coil received');
    RETURN NEW;
END $$;
CREATE TRIGGER coil_received AFTER INSERT ON coils
    FOR EACH ROW EXECUTE FUNCTION fn_coil_received();

-- =============================================================================
-- 4. FINISHED PANEL & TRIM INVENTORY (post-production, by profile and length)
-- =============================================================================

-- One bucket per product + color + length. Run stock lengths and remnants.
CREATE TABLE finished_goods (
    finished_good_id    serial PRIMARY KEY,
    product_id          int           NOT NULL REFERENCES products,
    color_id            int           NOT NULL REFERENCES colors,
    length_in           numeric(7,3)  NOT NULL CHECK (length_in > 0),
    qty_on_hand         int           NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
    qty_reserved        int           NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
    location_id         int           REFERENCES stock_locations,
    is_remnant          boolean       NOT NULL DEFAULT false,
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (product_id, color_id, length_in, location_id, is_remnant),
    CHECK (qty_reserved <= qty_on_hand)
);
CREATE TRIGGER finished_goods_touch BEFORE UPDATE ON finished_goods
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

CREATE TABLE finished_goods_transactions (
    fg_txn_id           bigserial PRIMARY KEY,
    finished_good_id    int           NOT NULL REFERENCES finished_goods,
    txn_type            fg_txn_type   NOT NULL,
    qty_delta           int           NOT NULL CHECK (qty_delta <> 0),
    order_item_id       bigint,                                 -- FK added below
    production_run_id   bigint,                                 -- FK added below
    performed_by        text,
    note                text,
    occurred_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE FUNCTION fn_apply_fg_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE finished_goods
       SET qty_on_hand = qty_on_hand + NEW.qty_delta
     WHERE finished_good_id = NEW.finished_good_id;
    RETURN NEW;
END $$;
CREATE TRIGGER fg_txn_apply AFTER INSERT ON finished_goods_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_apply_fg_txn();

-- =============================================================================
-- 5. CUSTOMERS
-- =============================================================================

CREATE TABLE customers (
    customer_id         serial PRIMARY KEY,
    customer_type       customer_type NOT NULL DEFAULT 'contractor',
    display_name        text          NOT NULL UNIQUE,          -- -> QBO Customer.DisplayName (unique, max 500)
    company_name        text,
    first_name          text,
    last_name           text,
    email               text,
    phone               text,
    mobile              text,
    tax_exempt          boolean       NOT NULL DEFAULT false,
    resale_cert_number  text,
    payment_terms       text          NOT NULL DEFAULT 'Due on receipt',  -- -> QBO SalesTermRef
    credit_limit        numeric(12,2),
    default_fulfillment fulfillment_method NOT NULL DEFAULT 'pickup',
    notes               text,
    -- QuickBooks Online link
    qbo_customer_id     text          UNIQUE,
    qbo_sync_token      text,
    active              boolean       NOT NULL DEFAULT true,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CHECK (length(display_name) <= 500)
);
CREATE INDEX customers_name_trgm_idx ON customers (lower(display_name));
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

CREATE TABLE customer_contacts (
    contact_id          serial PRIMARY KEY,
    customer_id         int           NOT NULL REFERENCES customers ON DELETE CASCADE,
    name                text          NOT NULL,
    role                text,                                   -- "Foreman", "AP"
    email               text,
    phone               text,
    receives_invoices   boolean       NOT NULL DEFAULT false    -- -> QBO BillEmail / BillEmailCc
);

CREATE TABLE customer_addresses (
    address_id          serial PRIMARY KEY,
    customer_id         int           NOT NULL REFERENCES customers ON DELETE CASCADE,
    address_type        address_type  NOT NULL,
    label               text,
    line1               text          NOT NULL,
    line2               text,
    city                text          NOT NULL,
    state               char(2)       NOT NULL,
    postal_code         text          NOT NULL,
    country             text          NOT NULL DEFAULT 'US',
    is_default          boolean       NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX customer_addresses_one_default
    ON customer_addresses (customer_id, address_type) WHERE is_default;

-- =============================================================================
-- 6. ORDERS (one row per cut sheet / job)
-- =============================================================================

CREATE SEQUENCE order_number_seq START 10001;

CREATE TABLE orders (
    order_id            bigserial PRIMARY KEY,
    order_number        text          NOT NULL UNIQUE
                        DEFAULT ('HP-' || nextval('order_number_seq')),  -- -> QBO DocNumber (max 21)
    customer_id         int           NOT NULL REFERENCES customers,
    status              order_status  NOT NULL DEFAULT 'quote',
    -- Cut-sheet header
    job_name            text,
    po_number           text,                                   -- Project/PO#
    job_address_id      int           REFERENCES customer_addresses,
    job_address_text    text,                                   -- free-form if not a saved address
    contact_phone       text,
    contact_email       text,
    fulfillment         fulfillment_method NOT NULL DEFAULT 'pickup',
    need_by             date,
    -- Dates & people
    ordered_on          date          NOT NULL DEFAULT current_date,
    completed_at        timestamptz,
    completed_by        text,
    inspected_by        text,
    delivered_on        date,
    -- Money
    deposit_amount      numeric(12,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
    discount_amount     numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    delivery_charge     numeric(12,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
    tax_exempt          boolean,                                -- NULL = inherit customer
    customer_memo       text,                                   -- prints on invoice (QBO max 1000)
    internal_notes      text,                                   -- -> QBO PrivateNote (max 4000)
    quote_expires_on    date,                                   -- price list: quotes valid 30 days
    -- QuickBooks Online link
    qbo_invoice_id      text          UNIQUE,
    qbo_doc_number      text,
    qbo_sync_token      text,
    qbo_sync_status     qbo_sync_status NOT NULL DEFAULT 'not_synced',
    qbo_synced_at       timestamptz,
    qbo_last_error      text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CHECK (length(order_number) <= 21),
    CHECK (customer_memo IS NULL OR length(customer_memo) <= 1000),
    CHECK (status NOT IN ('completed','invoiced') OR completed_at IS NOT NULL)
);
CREATE INDEX orders_customer_idx ON orders (customer_id, ordered_on DESC);
CREATE INDEX orders_status_idx   ON orders (status) WHERE status NOT IN ('invoiced','cancelled');
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Cut-sheet SECTION/AREA blocks (Roof / Wall / Trim / Other).
CREATE TABLE order_sections (
    section_id          bigserial PRIMARY KEY,
    order_id            bigint        NOT NULL REFERENCES orders ON DELETE CASCADE,
    area                order_area    NOT NULL,
    label               text,                                   -- "Other: Garage", "North wall"
    sort_order          smallint      NOT NULL DEFAULT 0,
    completed_by        text,
    inspected_by        text
);
CREATE INDEX order_sections_order_idx ON order_sections (order_id, sort_order);

-- Order lines. One row per cut-sheet row: QTY x LENGTH of PROFILE/GAUGE/COLOR.
--
-- billable_qty (generated, rounded to 0.01) is what gets invoiced:
--   sqft  -> pieces * length_ft * width_ft   (width = panel coverage or trim girth)
--   lf    -> pieces * length_ft
--   each / bag / roll -> pieces
-- width_in and unit_price are snapshots taken when the line is priced.
CREATE TABLE order_items (
    order_item_id       bigserial PRIMARY KEY,
    order_id            bigint        NOT NULL REFERENCES orders ON DELETE CASCADE,
    section_id          bigint        REFERENCES order_sections ON DELETE SET NULL,
    line_no             smallint      NOT NULL,
    product_id          int           NOT NULL REFERENCES products,
    color_id            int           REFERENCES colors,
    pieces              numeric(10,2) NOT NULL CHECK (pieces > 0),
    length_in           numeric(7,3)  CHECK (length_in > 0),
    pricing_unit        pricing_unit  NOT NULL,                 -- copied from product
    width_in            numeric(6,3)  CHECK (width_in > 0),     -- coverage run on this line (panel) or girth (custom trim)
    unit_price          numeric(12,4) NOT NULL CHECK (unit_price >= 0),
    line_discount       numeric(12,2) NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
    taxable             boolean       NOT NULL,                 -- defaults from product
    description         text,                                   -- override; else generated
    billable_qty        numeric(12,4) GENERATED ALWAYS AS (
        CASE pricing_unit
            WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
            WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
            ELSE pieces
        END) STORED,
    line_total          numeric(12,2) GENERATED ALWAYS AS (
        round(
            CASE pricing_unit
                WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
                WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
                ELSE pieces
            END * unit_price, 2) - line_discount) STORED,
    qbo_line_id         text,                                   -- Line.Id returned by QBO
    created_at          timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (order_id, line_no),
    CHECK (pricing_unit NOT IN ('sqft','lf') OR length_in IS NOT NULL),
    CHECK (pricing_unit <> 'sqft' OR width_in IS NOT NULL),
    CHECK (description IS NULL OR length(description) <= 4000)
);
CREATE INDEX order_items_order_idx ON order_items (order_id, line_no);

-- Custom-trim detail: the bend profile drawn on the cut sheet.
CREATE TABLE order_item_trim_specs (
    order_item_id       bigint        PRIMARY KEY REFERENCES order_items ON DELETE CASCADE,
    trim_type_id        int           REFERENCES trim_types,    -- NULL = fully custom shape
    girth_in            numeric(6,3)  NOT NULL CHECK (girth_in > 0),
    bend_count          smallint,
    -- [{"leg_in":1.0,"angle_deg":90,"hem":false}, ...]
    segments            jsonb,
    drawing_url         text,
    notes               text
);

-- Fill line defaults from the product/profile/price list on insert.
CREATE FUNCTION fn_order_item_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    p           products%ROWTYPE;
    cov         numeric;
    price       numeric;
    upcharge    numeric := 0;
BEGIN
    SELECT * INTO p FROM products WHERE product_id = NEW.product_id;

    NEW.pricing_unit := COALESCE(NEW.pricing_unit, p.pricing_unit);
    NEW.taxable      := COALESCE(NEW.taxable, p.taxable);

    IF NEW.width_in IS NULL AND p.profile_id IS NOT NULL THEN
        SELECT coverage_width_in INTO cov FROM panel_profiles WHERE profile_id = p.profile_id;
        NEW.width_in := cov;
    END IF;

    IF NEW.unit_price IS NULL THEN
        SELECT unit_price INTO price FROM v_current_prices WHERE product_id = NEW.product_id;
        IF price IS NULL THEN
            RAISE EXCEPTION 'Product % (%) has no current price; set unit_price on the line',
                p.sku, p.name;
        END IF;
        IF NEW.color_id IS NOT NULL THEN
            SELECT CASE WHEN is_stock_color THEN 0 ELSE special_order_upcharge_pct END
              INTO upcharge FROM colors WHERE color_id = NEW.color_id;
        END IF;
        NEW.unit_price := round(price * (1 + COALESCE(upcharge, 0) / 100.0), 2);
    END IF;

    IF NEW.line_no IS NULL THEN
        SELECT COALESCE(max(line_no), 0) + 1 INTO NEW.line_no
          FROM order_items WHERE order_id = NEW.order_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER order_items_defaults BEFORE INSERT ON order_items
    FOR EACH ROW EXECUTE FUNCTION fn_order_item_defaults();

-- Panel lines must use a coverage width inside the profile's range.
-- Fires after order_items_defaults (triggers run in name order).
CREATE FUNCTION fn_order_item_check_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    pr panel_profiles%ROWTYPE;
BEGIN
    SELECT pp.* INTO pr
      FROM products p JOIN panel_profiles pp USING (profile_id)
     WHERE p.product_id = NEW.product_id;
    IF FOUND AND NEW.width_in NOT BETWEEN pr.min_coverage_in AND pr.max_coverage_in THEN
        RAISE EXCEPTION '% coverage must be between % and % in (got %)',
            pr.name, trim_scale(pr.min_coverage_in), trim_scale(pr.max_coverage_in),
            trim_scale(NEW.width_in);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER order_items_enforce_coverage BEFORE INSERT OR UPDATE OF width_in, product_id ON order_items
    FOR EACH ROW EXECUTE FUNCTION fn_order_item_check_coverage();

-- Custom trim: width_in on the line mirrors the trim spec's girth.
CREATE FUNCTION fn_trim_spec_sync_width() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE order_items SET width_in = NEW.girth_in
     WHERE order_item_id = NEW.order_item_id AND pricing_unit = 'sqft';
    RETURN NEW;
END $$;
CREATE TRIGGER trim_spec_sync_width AFTER INSERT OR UPDATE OF girth_in ON order_item_trim_specs
    FOR EACH ROW EXECUTE FUNCTION fn_trim_spec_sync_width();

-- Completed or invoiced orders are locked against line edits.
CREATE FUNCTION fn_lock_closed_order_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    st order_status;
BEGIN
    SELECT status INTO st FROM orders
     WHERE order_id = COALESCE(NEW.order_id, OLD.order_id);
    IF st IN ('invoiced', 'cancelled') THEN
        RAISE EXCEPTION 'Order is %; lines cannot be changed', st;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER order_items_lock BEFORE INSERT OR UPDATE OR DELETE ON order_items
    FOR EACH ROW EXECUTE FUNCTION fn_lock_closed_order_lines();

-- =============================================================================
-- 7. PRODUCTION (coil -> cut pieces)
-- =============================================================================

CREATE TABLE production_runs (
    production_run_id   bigserial PRIMARY KEY,
    coil_id             int           NOT NULL REFERENCES coils,
    order_item_id       bigint        REFERENCES order_items,   -- NULL = run to stock
    finished_good_id    int           REFERENCES finished_goods,-- set when run to stock
    pieces              int           NOT NULL CHECK (pieces > 0),
    length_in           numeric(7,3)  NOT NULL CHECK (length_in > 0),
    weight_used_lb      numeric(10,2) NOT NULL CHECK (weight_used_lb > 0),  -- incl. scrap/drop
    scrap_lb            numeric(10,2) NOT NULL DEFAULT 0 CHECK (scrap_lb >= 0),
    operator            text,
    machine             text,
    run_at              timestamptz   NOT NULL DEFAULT now(),
    CHECK (order_item_id IS NOT NULL OR finished_good_id IS NOT NULL),
    CHECK (scrap_lb <= weight_used_lb)
);
CREATE INDEX production_runs_coil_idx  ON production_runs (coil_id);
CREATE INDEX production_runs_item_idx  ON production_runs (order_item_id);

ALTER TABLE coil_transactions
    ADD CONSTRAINT coil_txn_run_fk FOREIGN KEY (production_run_id) REFERENCES production_runs;
ALTER TABLE finished_goods_transactions
    ADD CONSTRAINT fg_txn_item_fk FOREIGN KEY (order_item_id) REFERENCES order_items,
    ADD CONSTRAINT fg_txn_run_fk  FOREIGN KEY (production_run_id) REFERENCES production_runs;

-- A run draws weight off its coil; runs to stock also add finished goods.
CREATE FUNCTION fn_production_run_post() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    remaining numeric;
BEGIN
    SELECT current_weight_lb INTO remaining FROM coils WHERE coil_id = NEW.coil_id FOR UPDATE;
    IF NEW.weight_used_lb > remaining THEN
        RAISE EXCEPTION 'Run uses % lb but coil has only % lb left', NEW.weight_used_lb, remaining;
    END IF;

    INSERT INTO coil_transactions (coil_id, txn_type, weight_delta_lb, production_run_id, performed_by)
    VALUES (NEW.coil_id, 'production', -(NEW.weight_used_lb - NEW.scrap_lb), NEW.production_run_id, NEW.operator);

    IF NEW.scrap_lb > 0 THEN
        INSERT INTO coil_transactions (coil_id, txn_type, weight_delta_lb, production_run_id, performed_by)
        VALUES (NEW.coil_id, 'scrap', -NEW.scrap_lb, NEW.production_run_id, NEW.operator);
    END IF;

    IF NEW.finished_good_id IS NOT NULL THEN
        INSERT INTO finished_goods_transactions
            (finished_good_id, txn_type, qty_delta, production_run_id, performed_by)
        VALUES (NEW.finished_good_id, 'produce', NEW.pieces, NEW.production_run_id, NEW.operator);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER production_run_post AFTER INSERT ON production_runs
    FOR EACH ROW EXECUTE FUNCTION fn_production_run_post();

-- =============================================================================
-- 8. QUICKBOOKS ONLINE SYNC LOG
-- =============================================================================

CREATE TABLE qbo_sync_log (
    sync_id             bigserial PRIMARY KEY,
    entity              text          NOT NULL,                 -- 'Invoice', 'Customer', 'Item'
    local_table         text          NOT NULL,
    local_id            bigint        NOT NULL,
    operation           text          NOT NULL,                 -- 'create', 'update', 'void', 'send'
    request_id          uuid          NOT NULL,                 -- ?requestid= idempotency key
    request_body        jsonb,
    response_status     int,
    response_body       jsonb,
    qbo_id              text,
    succeeded           boolean,
    created_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX qbo_sync_log_local_idx ON qbo_sync_log (local_table, local_id, created_at DESC);

-- =============================================================================
-- 9. VIEWS
-- =============================================================================

-- Coil stock with estimated remaining linear feet at the coil's width.
CREATE VIEW v_coil_inventory AS
SELECT c.coil_id, c.coil_tag, c.heat_number, g.gauge, col.name AS color,
       c.width_in, c.initial_weight_lb, c.current_weight_lb, c.status,
       sl.code AS location,
       round(c.current_weight_lb / (g.weight_lb_per_sqft * c.width_in / 12.0), 1)
           AS est_remaining_lf,
       round(c.current_weight_lb * c.cost_per_lb, 2) AS remaining_value,
       c.received_on
FROM   coils c
JOIN   gauges g          USING (gauge_id)
JOIN   colors col        USING (color_id)
LEFT   JOIN stock_locations sl USING (location_id);

-- Totals by gauge/color/width for purchasing.
CREATE VIEW v_coil_stock_summary AS
SELECT gauge, color, width_in,
       count(*)                AS coils,
       sum(current_weight_lb)  AS total_lb,
       sum(est_remaining_lf)   AS est_total_lf
FROM   v_coil_inventory
WHERE  status IN ('in_stock', 'on_machine')
GROUP  BY gauge, color, width_in;

CREATE VIEW v_finished_goods AS
SELECT fg.finished_good_id, p.sku, p.name AS product, col.name AS color,
       fg.length_in, fn_format_length(fg.length_in) AS length_display,
       fg.qty_on_hand, fg.qty_reserved, fg.qty_on_hand - fg.qty_reserved AS qty_available,
       fg.is_remnant, sl.code AS location
FROM   finished_goods fg
JOIN   products p   USING (product_id)
JOIN   colors col   USING (color_id)
LEFT   JOIN stock_locations sl USING (location_id);

-- Order totals. Sales tax is computed by QuickBooks, not here.
CREATE VIEW v_order_totals AS
SELECT o.order_id, o.order_number,
       COALESCE(sum(oi.line_total), 0)                                  AS lines_subtotal,
       COALESCE(sum(oi.line_total) FILTER (WHERE oi.taxable), 0)        AS taxable_subtotal,
       o.delivery_charge, o.discount_amount, o.deposit_amount,
       COALESCE(sum(oi.line_total), 0) + o.delivery_charge - o.discount_amount AS pre_tax_total
FROM   orders o
LEFT   JOIN order_items oi USING (order_id)
GROUP  BY o.order_id;

-- One row per future QBO invoice line, already shaped for the mapping guide.
CREATE VIEW v_order_invoice_lines AS
SELECT oi.order_id,
       o.order_number,
       os.area,
       os.sort_order                 AS section_sort,
       oi.line_no,
       oi.order_item_id,
       p.sku,
       p.name                        AS product_name,
       p.qbo_item_id,
       oi.pricing_unit,
       oi.pieces,
       oi.length_in,
       oi.width_in,
       oi.billable_qty               AS qbo_qty,
       oi.unit_price                 AS qbo_unit_price,
       oi.line_total                 AS qbo_amount,
       oi.taxable,
       COALESCE(oi.description,
         concat_ws(' | ',
           p.name,
           col.name,
           CASE
             WHEN oi.pricing_unit = 'sqft' THEN
               format('%s pcs @ %s x %s" %s = %s sq ft',
                      trim_scale(oi.pieces)::text,
                      fn_format_length(oi.length_in),
                      trim_scale(oi.width_in)::text,
                      CASE WHEN p.category = 'custom_trim' THEN 'girth' ELSE 'coverage' END,
                      to_char(oi.billable_qty, 'FM999990.00'))
             WHEN oi.pricing_unit = 'lf' THEN
               format('%s pcs @ %s = %s LF',
                      trim_scale(oi.pieces)::text,
                      fn_format_length(oi.length_in),
                      to_char(oi.billable_qty, 'FM999990.00'))
             WHEN oi.length_in IS NOT NULL THEN
               format('%s pcs @ %s', trim_scale(oi.pieces)::text,
                      fn_format_length(oi.length_in))
             ELSE NULL
           END)) AS qbo_description
FROM   order_items oi
JOIN   orders o              USING (order_id)
JOIN   products p            USING (product_id)
LEFT   JOIN colors col       ON col.color_id = oi.color_id
LEFT   JOIN order_sections os ON os.section_id = oi.section_id;

-- =============================================================================
-- 10. SEED DATA (from HPCM Price List effective 2026-10-01)
-- =============================================================================

-- Nominal galvanized/Galvalume steel weights. Confirm against mill certs.
INSERT INTO gauges (gauge, nominal_thickness_in, weight_lb_per_sqft) VALUES
    (22, 0.0299, 1.406),
    (24, 0.0239, 1.156),
    (26, 0.0179, 0.906),
    (29, 0.0142, 0.719);

-- Coverage per HPCM (2026-10-06): Board & Batten 13.5"; Snap Lock and Nail
-- Flange 16"-18" chosen per order line (default 16"). PBR/Tuff Rib 36" is the
-- standard coverage and does not affect price (billed per LF).
INSERT INTO panel_profiles (name, fastening, application, pricing_unit,
                            coverage_width_in, min_coverage_in, max_coverage_in, rib_height_in) VALUES
    ('Board & Batten',              'concealed',        'wall',         'sqft', 13.5, 13.5, 13.5, 1.0),
    ('Snap Lock 1.5"',              'concealed',        'roof',         'sqft', 16,   16,   18,   1.5),
    ('Standing Seam 1" Nail Flange','concealed',        'roof_or_wall', 'sqft', 16,   16,   18,   1.0),
    ('PBR/R Panel',                 'through_fastened', 'roof_or_wall', 'lf',   36,   36,   36,   1.25),
    ('Tuff Rib',                    'through_fastened', 'roof_or_wall', 'lf',   36,   36,   36,   0.75);

INSERT INTO products (sku, name, category, profile_id, gauge_id, pricing_unit,
                      is_cut_to_length, qbo_item_name)
SELECT v.sku, v.name, 'panel', pp.profile_id, g.gauge_id, v.unit::pricing_unit, true, v.name
FROM (VALUES
    ('PNL-BB-24',  'Board & Batten 24 GA',                'Board & Batten',               24, 'sqft'),
    ('PNL-BB-26',  'Board & Batten 26 GA',                'Board & Batten',               26, 'sqft'),
    ('PNL-SL-24',  'Snap Lock 1.5" 24 GA',                'Snap Lock 1.5"',               24, 'sqft'),
    ('PNL-SL-26',  'Snap Lock 1.5" 26 GA',                'Snap Lock 1.5"',               26, 'sqft'),
    ('PNL-NF-24',  'Standing Seam 1" Nail Flange 24 GA',  'Standing Seam 1" Nail Flange', 24, 'sqft'),
    ('PNL-NF-26',  'Standing Seam 1" Nail Flange 26 GA',  'Standing Seam 1" Nail Flange', 26, 'sqft'),
    ('PNL-PBR-26', 'PBR/R Panel 26 GA',                   'PBR/R Panel',                  26, 'lf'),
    ('PNL-TR-26',  'Tuff Rib Panel 26 GA',                'Tuff Rib',                     26, 'lf')
) AS v(sku, name, profile, gauge, unit)
JOIN panel_profiles pp ON pp.name = v.profile
JOIN gauges g          ON g.gauge = v.gauge;

INSERT INTO products (sku, name, category, gauge_id, pricing_unit, is_cut_to_length, qbo_item_name)
SELECT v.sku, v.name, 'custom_trim', g.gauge_id, 'sqft', true, v.name
FROM (VALUES ('TRM-CUST-24', 'Custom Trim 24 GA', 24),
             ('TRM-CUST-26', 'Custom Trim 26 GA', 26)) AS v(sku, name, gauge)
JOIN gauges g ON g.gauge = v.gauge;

-- A representative set of stock trims and accessories (extend from the price list).
INSERT INTO trim_types (name) VALUES
    ('Ridge Cap'), ('Eave Drip (Denver)'), ('J-Channel'), ('Gable 2x4'),
    ('Sidewall'), ('Headwall'), ('Valley'), ('Outside Corner/Corner Gable'), ('Inside Corner');

INSERT INTO products (sku, name, category, trim_type_id, gauge_id, pricing_unit,
                      standard_length_in, pack_size, qbo_item_name)
SELECT v.sku, v.name, v.cat::product_category, tt.trim_type_id, g.gauge_id,
       v.unit::pricing_unit, v.std_len, v.pack, v.name
FROM (VALUES
    ('TRM-RIDGE-24', 'Ridge Cap 24 GA',             'trim',      'Ridge Cap',                   24,   'each', 120, NULL),
    ('TRM-RIDGE-26', 'Ridge Cap 26 GA',             'trim',      'Ridge Cap',                   26,   'each', 120, NULL),
    ('TRM-EAVE',     'Eave Drip (Denver)',          'trim',      'Eave Drip (Denver)',          NULL, 'each', 120, NULL),
    ('TRM-JCH',      'J-Channel',                   'trim',      'J-Channel',                   NULL, 'each', 120, NULL),
    ('TRM-GBL-2X4',  'Gable 2x4',                   'trim',      'Gable 2x4',                   NULL, 'each', 120, NULL),
    ('TRM-SIDEWALL', 'Sidewall',                    'trim',      'Sidewall',                    NULL, 'each', 120, NULL),
    ('TRM-HEADWALL', 'Headwall',                    'trim',      'Headwall',                    NULL, 'each', 120, NULL),
    ('TRM-VALLEY',   'Valley',                      'trim',      'Valley',                      NULL, 'each', 120, NULL),
    ('TRM-OSC',      'Outside Corner/Corner Gable', 'trim',      'Outside Corner/Corner Gable', NULL, 'each', 120, NULL),
    ('TRM-ISC',      'Inside Corner',               'trim',      'Inside Corner',               NULL, 'each', 120, NULL),
    ('BOOT-1-ZIP',   '#1 Zipper Boot',              'boot',      NULL,                          NULL, 'each', NULL, NULL),
    ('JACK-3',       '#3 Pipe Jack',                'jack',      NULL,                          NULL, 'each', NULL, NULL),
    ('SCR-PANHEAD-1','1" Panhead Screws (250 ct)',  'fastener',  NULL,                          NULL, 'bag',  NULL, 250),
    ('SCR-SD-125',   '1.25" Self Drilling Screws',  'fastener',  NULL,                          NULL, 'bag',  NULL, NULL),
    ('ACC-BUTYL',    'Butyl Tape',                  'accessory', NULL,                          NULL, 'roll', NULL, NULL),
    ('ACC-CLIP-15',  'Clips, 1.5"',                 'accessory', NULL,                          NULL, 'each', NULL, NULL),
    ('ACC-CLOS-IO',  'Inner/Outer Closure',         'accessory', NULL,                          NULL, 'each', NULL, NULL)
) AS v(sku, name, cat, trim_name, gauge, unit, std_len, pack)
LEFT JOIN trim_types tt ON tt.name = v.trim_name
LEFT JOIN gauges g      ON g.gauge = v.gauge;

INSERT INTO products (sku, name, category, pricing_unit, taxable, qbo_item_name) VALUES
    ('SVC-DELIVERY', 'Delivery', 'delivery', 'each', false, 'Delivery');

INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT p.product_id, v.price, DATE '2026-10-01', 'HPCM Price List 2026-10-01'
FROM (VALUES
    ('PNL-BB-24', 4.75), ('PNL-BB-26', 3.75),
    ('PNL-SL-24', 4.50), ('PNL-SL-26', 3.65),
    ('PNL-NF-24', 4.50), ('PNL-NF-26', 3.65),
    ('PNL-PBR-26', 5.65), ('PNL-TR-26', 5.00),
    ('TRM-CUST-24', 4.40), ('TRM-CUST-26', 3.40),
    ('TRM-RIDGE-24', 59.45), ('TRM-RIDGE-26', 44.20),
    ('TRM-EAVE', 22.10), ('TRM-JCH', 17.00), ('TRM-GBL-2X4', 38.25),
    ('TRM-SIDEWALL', 35.70), ('TRM-HEADWALL', 35.70), ('TRM-VALLEY', 70.76),
    ('TRM-OSC', 44.20), ('TRM-ISC', 44.20),
    ('BOOT-1-ZIP', 25.00), ('JACK-3', 20.00),
    ('SCR-PANHEAD-1', 38.00), ('SCR-SD-125', 40.00),
    ('ACC-BUTYL', 5.00), ('ACC-CLIP-15', 0.55), ('ACC-CLOS-IO', 1.20)
) AS v(sku, price)
JOIN products p ON p.sku = v.sku;

COMMIT;
