// Screws (and clips) for a quote, figured from its panel lines. Shared by the
// order form (live preview) and the server (what gets saved), so both agree.
//
// Each panel profile has rules (Admin > Screws). A rule gives a product and how
// many: either per square (100 sq ft of panel, by coverage width) or per spacing
// along each panel (1 every 2'; each panel rounds up to whole spacings). Rules
// with a length are alternatives and the quote picks one (or the usual one);
// rules without a length always apply. Screws match the panel color; amounts
// are added up per product and color, rounded up, then to whole bags.
(function (root) {
  // lines: [{ product_id, color_id, pieces, length_in, width_in }]
  // products: Map of id -> { category, profile_id, profile_name, cov }
  // rules: [{ profile_id, framing, length_label, product_id, basis, qty, spacing_in, color_match, is_default,
  //           product_name, unit, category, pack_size, price }]
  // opts: { framing: 'wood' | 'steel', length: '1.5"' }
  function figure(lines, products, rules, opts) {
    const framing = opts.framing === 'steel' ? 'steel' : 'wood';
    const groups = new Map();
    const missing = new Set();
    for (const l of lines) {
      const p = products.get(Number(l.product_id));
      if (!p || p.category !== 'panel' || !p.profile_id) continue;
      const pieces = Number(l.pieces);
      const len = Number(l.length_in);
      if (!(pieces > 0 && len > 0)) continue;
      const chosen = rulesFor(rules, p.profile_id, framing, opts.length);
      if (!chosen.length) { missing.add(p.profile_name || p.name); continue; }
      for (const r of chosen) {
        const color = r.color_match ? Number(l.color_id) || null : null;
        const key = `${r.product_id}|${color}`;
        const g = groups.get(key) || { rule: r, color_id: color, count: 0, squares: 0, perSquare: 0, spacings: [] };
        if (r.basis === 'square') {
          const cov = Number(l.width_in) || Number(p.cov);
          if (!(cov > 0)) continue;
          const squares = (pieces * len * cov) / 144 / 100;
          g.count += squares * Number(r.qty);
          g.squares += squares;
          g.perSquare = Number(r.qty);
        } else {
          const n = pieces * Math.ceil(len / Number(r.spacing_in) - 1e-9);
          g.count += n * Number(r.qty);
          const s = g.spacings.find((x) => x.qty === Number(r.qty) && x.spacing === Number(r.spacing_in));
          if (s) s.ft += (pieces * len) / 12;
          else g.spacings.push({ qty: Number(r.qty), spacing: Number(r.spacing_in), ft: (pieces * len) / 12 });
        }
        groups.set(key, g);
      }
    }
    const out = [];
    for (const g of groups.values()) {
      const r = g.rule;
      const count = Math.ceil(g.count - 1e-9);
      if (!count) continue;
      const bagged = r.unit === 'bag';
      const pack = Number(r.pack_size) || 250;
      const noun = r.category === 'fastener' ? 'screws' : /clip/i.test(r.product_name || '') ? 'clips' : 'pieces';
      const fmt = (n) => String(Math.round(n * 100) / 100);
      const how = [
        g.squares ? `${fmt(g.squares)} squares x ${fmt(g.perSquare)} per square` : '',
        ...g.spacings.map((s) => `${fmt(s.qty)} every ${fmt(s.spacing / 12)}' on ${fmt(s.ft)}' of panel`),
      ].filter(Boolean).join(' + ');
      out.push({
        product_id: r.product_id,
        color_id: g.color_id,
        pieces: bagged ? Math.ceil(count / pack) : count,
        unit_price: r.price === null || r.price === undefined ? '' : Number(r.price),
        count,
        description: `${count} ${noun}: ${how}${bagged ? `, ${pack} per bag` : ''}`,
      });
    }
    return { lines: out, missing: [...missing] };
  }

  // The rules that apply to one panel profile on this framing at this length.
  function rulesFor(rules, profileId, framing, length) {
    const fits = rules.filter((r) => Number(r.profile_id) === Number(profileId) && (r.framing === framing || r.framing === 'any'));
    const sized = fits.filter((r) => r.length_label);
    const pick = sized.find((r) => r.length_label === length) || sized.find((r) => r.is_default) || sized[0];
    return [...(pick ? [pick] : []), ...fits.filter((r) => !r.length_label)];
  }

  // Lengths a quote can pick for this framing, and the usual one.
  function lengths(rules, framing) {
    const f = framing === 'steel' ? 'steel' : 'wood';
    const fits = rules.filter((r) => r.length_label && (r.framing === f || r.framing === 'any'));
    const def = fits.find((r) => r.is_default) || fits[0];
    return { options: [...new Set(fits.map((r) => r.length_label))], usual: def ? def.length_label : null };
  }

  const api = { figure, rulesFor, lengths };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Screws = api;
}(this));
