-- Sample data: one coil, one customer, one mixed order (sqft + LF + each + custom trim).
-- Load after hpcm_crm_schema.sql. Ends by printing the QBO-ready invoice lines.
SET search_path = hpcm, public;
INSERT INTO suppliers (name) VALUES ('Coil Supplier A'), ('Coil Supplier B');
INSERT INTO colors (name, supplier_id, finish, is_stock_color, upcharge_pct) VALUES
    ('Charcoal Gray', 1, 'smooth', true, 0), ('Copper Penny', 1, 'smooth', false, 15);
INSERT INTO coils (coil_tag, gauge_id, color_id, width_in, initial_lf, current_lf, cost_per_lf, supplier_id)
SELECT 'T-24-0457', g.gauge_id, c.color_id, 20, 2500, 2500, 1.85, 1 FROM gauges g, colors c WHERE g.gauge=24 AND c.name='Charcoal Gray';
INSERT INTO customers (display_name, company_name, email, phone) VALUES ('Summit Exteriors LLC','Summit Exteriors LLC','ap@summit.example','307-555-0100');
INSERT INTO orders (customer_id, job_name, po_number, job_address_text, fulfillment, need_by, delivery_charge)
VALUES (1, 'Miller Residence', 'SE-2231', '1418 Ridge Rd, Cheyenne WY 82009', 'delivery', '2026-10-15', 75) RETURNING order_number;
INSERT INTO order_sections (order_id, area, sort_order) VALUES (1,'roof',1),(1,'wall',2),(1,'trim',3);
-- roof: snap lock 24ga, 12 pcs @ 14'6" at the default 16" coverage,
-- and 8 @ 9'2-1/2" run at 18" coverage (width_in set on the line)
INSERT INTO order_items (order_id, section_id, product_id, color_id, pieces, length_in)
SELECT 1,1,product_id,1,12,174 FROM products WHERE sku='PNL-SL-24';
INSERT INTO order_items (order_id, section_id, product_id, color_id, pieces, length_in, width_in)
SELECT 1,1,product_id,1,8,110.5,18 FROM products WHERE sku='PNL-SL-24';
-- wall: PBR 26ga special color, 20 @ 10'
INSERT INTO order_items (order_id, section_id, product_id, color_id, pieces, length_in)
SELECT 1,2,product_id,2,20,120 FROM products WHERE sku='PNL-PBR-26';
-- wall: board & batten 26ga, 30 pcs @ 8' 1" (13.5" coverage from the profile)
INSERT INTO order_items (order_id, section_id, product_id, color_id, pieces, length_in)
SELECT 1,2,product_id,1,30,97 FROM products WHERE sku='PNL-BB-26';
-- trim: ridge cap x4, custom trim 6 pcs @ 10'6" girth 11.5
INSERT INTO order_items (order_id, section_id, product_id, color_id, pieces)
SELECT 1,3,product_id,1,4 FROM products WHERE sku='TRM-RIDGE-24';
INSERT INTO order_items (order_id, section_id, product_id, color_id, pieces, length_in, width_in)
SELECT 1,3,product_id,1,6,126,11.5 FROM products WHERE sku='TRM-CUST-24' RETURNING order_item_id;
INSERT INTO order_item_trim_specs (order_item_id, girth_in, bend_count, segments) VALUES ((SELECT max(order_item_id) FROM order_items), 11.5, 4, '[{"leg_in":4,"angle_deg":90}]');
INSERT INTO order_items (order_id, product_id, pieces) SELECT 1, product_id, 2 FROM products WHERE sku='SCR-PANHEAD-1';
-- production
INSERT INTO production_runs (coil_id, order_item_id, pieces, length_in, lf_used, scrap_lf, operator) VALUES (1, 1, 12, 174, 180, 6, 'JR');
INSERT INTO colors (name, supplier_id, finish, upcharge_pct) VALUES
    ('Galvalume', 1, 'smooth', 0), ('Burnished Slate', 1, 'smooth', 0), ('Polar White', 1, 'smooth', 0),
    ('Charcoal Gray', 2, 'smooth', 0), ('Barn Red', 2, 'smooth', 0),
    ('Crinkle Black', 2, 'textured', 12);
