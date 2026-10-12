// Screws for a quote, figured from its panel lines. Shared by the order form
// (live preview) and the server (what gets saved), so both always agree.
//
// For each kind of panel (through-fastened or concealed) and color: squares =
// panel sq ft / 100 (through-fastener panels by their coverage, 36" for PBR and
// Tuff Rib), screws = squares x the rule's screws per square (rounded up), and
// bags = screws / screws per bag (rounded up). Screws match the panel color.
(function (root) {
  const FASTENING_LABEL = { through_fastened: 'Through-fastener panels', concealed: 'Standing seam / Board & Batten' };

  // lines: [{ product_id, color_id, pieces, length_in, width_in }]
  // products: Map of id -> { category, unit, fastening, cov }
  // rules: [{ fastening, framing, length_label, product_id, per_square, pack_size, price, is_default }]
  // opts: { framing: 'wood' | 'steel', length: '1.5"' }
  function figure(lines, products, rules, opts) {
    const groups = new Map();
    for (const l of lines) {
      const p = products.get(Number(l.product_id));
      if (!p || p.category !== 'panel' || !p.fastening) continue;
      const pieces = Number(l.pieces);
      const len = Number(l.length_in);
      const cov = Number(l.width_in) || Number(p.cov);
      if (!(pieces > 0 && len > 0 && cov > 0)) continue;
      const key = `${p.fastening}|${l.color_id || ''}`;
      const g = groups.get(key) || { fastening: p.fastening, color_id: Number(l.color_id) || null, sqft: 0 };
      g.sqft += (pieces * len * cov) / 144;
      groups.set(key, g);
    }
    const out = [];
    const missing = new Set();
    for (const g of groups.values()) {
      const rule = pickRule(rules, g.fastening, opts.framing, opts.length);
      if (!rule) { missing.add(g.fastening); continue; }
      const squares = Math.round((g.sqft / 100) * 100) / 100;
      const screws = Math.ceil((g.sqft / 100) * Number(rule.per_square) - 1e-9);
      const pack = Number(rule.pack_size) || 250;
      const bags = Math.ceil(screws / pack);
      out.push({
        product_id: rule.product_id,
        color_id: g.color_id,
        pieces: bags,
        unit_price: rule.price === null || rule.price === undefined ? '' : Number(rule.price),
        screws,
        squares,
        description: `${screws} screws: ${squares} squares x ${Number(rule.per_square)} per square, ${pack} per bag`,
      });
    }
    return { lines: out, missing: [...missing].map((f) => FASTENING_LABEL[f] || f) };
  }

  function pickRule(rules, fastening, framing, length) {
    const fits = rules.filter((r) => r.fastening === fastening && r.framing === (framing || 'wood'));
    return fits.find((r) => r.length_label === length) || fits.find((r) => r.is_default) || fits[0] || null;
  }

  // Lengths offered for the chosen framing (through-fastener rules first).
  const lengths = (rules, framing) => [...new Set(rules.filter((r) => r.framing === (framing || 'wood'))
    .map((r) => r.length_label))];

  const api = { figure, pickRule, lengths, FASTENING_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Screws = api;
}(this));
