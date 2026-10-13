// Screws (and clips) for a quote, figured from its lines. Shared by the order
// form (live preview) and the server (what gets saved), so both agree.
//
// Rules live in Admin > Screws and clips. A rule belongs to a panel profile or
// to a product (trim, accessories), and counts either per square (100 sq ft of
// panel, by coverage width), every N inches of each piece (rounded up per
// piece), or a set number per piece.
//   Panels: rules with a length are alternatives (the quote picks one, or the
//     usual one); rules without a length always apply.
//   Trim and accessories: rules say which panels they go with (through-fastener,
//     standing seam, any). The quote picks which screws its trim gets, starting
//     from the panels on it. A rule with no screw uses the same screw as those
//     panels (so it follows the framing and length). Rules with an option label
//     are choices on the line (ridge cap every 18" or every 9").
// Screws match the color of the line they're for (trim screws the trim color),
// panel and trim screws are separate lines, and amounts round up to whole bags.
(function (root) {
  const SYSTEMS = { through_fastened: 'Through-fastener panels', concealed: 'Standing seam' };

  // lines: [{ product_id, color_id, pieces, length_in, width_in, screw_option }]
  // products: Map of id -> { name, category, profile_id, profile_name, fastening, cov, standard_length_in }
  // rules: [{ profile_id, item_product_id, framing, panel_system, length_label, option_label, product_id,
  //           basis, qty, spacing_in, color_match, is_default, product_name, unit, category, pack_size, price }]
  // opts: { framing: 'wood' | 'steel', length, trimFor: 'through_fastened' | 'concealed' | 'none' | '' }
  function figure(lines, products, rules, opts) {
    const framing = opts.framing === 'steel' ? 'steel' : 'wood';
    const groups = new Map();
    const missing = new Set();
    const add = (kind, rule, color, n, what) => {
      const key = `${kind}|${rule.product_id}|${color}`;
      const g = groups.get(key) || { kind, rule, color_id: color, count: 0, what: new Map() };
      g.count += n;
      g.what.set(what.key, (g.what.get(what.key) || 0) + what.amount);
      groups.set(key, g);
    };

    // Panels
    const systems = new Set();
    for (const l of lines) {
      const p = products.get(Number(l.product_id));
      if (!p || p.category !== 'panel' || !p.profile_id) continue;
      const pieces = Number(l.pieces);
      const len = Number(l.length_in);
      if (!(pieces > 0 && len > 0)) continue;
      if (p.fastening) systems.add(p.fastening);
      const chosen = panelRules(rules, p.profile_id, framing, opts.length);
      if (!chosen.length) { missing.add(p.profile_name || p.name); continue; }
      for (const r of chosen) {
        const color = r.color_match ? Number(l.color_id) || null : null;
        if (r.basis === 'square') {
          const cov = Number(l.width_in) || Number(p.cov);
          if (!(cov > 0)) continue;
          const squares = (pieces * len * cov) / 14400;
          add('panel', r, color, squares * Number(r.qty), { key: `sq|${Number(r.qty)}`, amount: squares });
        } else {
          const per = r.basis === 'each' ? 1 : Math.ceil(len / Number(r.spacing_in) - 1e-9);
          add('panel', r, color, pieces * per * Number(r.qty),
            { key: `sp|${Number(r.qty)}|${Number(r.spacing_in)}`, amount: (pieces * len) / 12 });
        }
      }
    }

    // Trim and accessories
    const trimFor = opts.trimFor || (systems.has('through_fastened') ? 'through_fastened'
      : systems.has('concealed') ? 'concealed' : '');
    let needsTrimChoice = false;
    for (const l of lines) {
      const p = products.get(Number(l.product_id));
      if (!p || p.category === 'panel') continue;
      const own = rules.filter((r) => Number(r.item_product_id) === p.id || Number(r.item_product_id) === Number(l.product_id));
      if (!own.length) continue;
      const pieces = Number(l.pieces);
      if (!(pieces > 0)) continue;
      if (!trimFor) { needsTrimChoice = true; continue; }
      if (trimFor === 'none') continue;
      for (const r of itemRules(own, trimFor, l.screw_option)) {
        const screw = r.product_id ? r : panelScrew(rules, products, trimFor, framing, opts.length);
        if (!screw) { missing.add(p.name); continue; }
        const len = Number(l.length_in) || Number(p.standard_length_in);
        let per;
        if (r.basis === 'each') per = Number(r.qty);
        else if (r.basis === 'spacing' && len > 0) per = Math.ceil(len / Number(r.spacing_in) - 1e-9) * Number(r.qty);
        else continue;
        const color = r.color_match ? Number(l.color_id) || null : null;
        add('trim', screw, color, pieces * per, { key: p.name, amount: pieces });
      }
    }

    const fmt = (n) => String(Math.round(n * 100) / 100);
    const out = [];
    for (const g of groups.values()) {
      const r = g.rule;
      const count = Math.ceil(g.count - 1e-9);
      if (!count) continue;
      const bagged = r.unit === 'bag';
      const pack = Number(r.pack_size) || 250;
      const noun = r.category === 'fastener' ? 'screws' : /clip/i.test(r.product_name || '') ? 'clips' : 'pieces';
      const how = g.kind === 'trim'
        ? `for ${[...g.what].map(([name, n]) => `${fmt(n)} ${name}`).join(', ')}`
        : [...g.what].map(([k, amount]) => {
          const [type, qty, spacing] = k.split('|');
          return type === 'sq' ? `${fmt(amount)} squares x ${qty} per square`
            : `${qty} every ${fmt(Number(spacing) / 12)}' on ${fmt(amount)}' of panel`;
        }).join(' + ');
      out.push({
        kind: g.kind,
        product_id: r.product_id,
        color_id: g.color_id,
        pieces: bagged ? Math.ceil(count / pack) : count,
        unit_price: r.price === null || r.price === undefined ? '' : Number(r.price),
        count,
        description: `${count} ${noun}${g.kind === 'trim' ? ' ' : ': '}${how}${bagged ? `, ${pack} per bag` : ''}`,
      });
    }
    out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'panel' ? -1 : 1));
    return { lines: out, missing: [...missing], needsTrimChoice, trimFor };
  }

  // The rules for one panel profile on this framing at this length.
  function panelRules(rules, profileId, framing, length) {
    const fits = rules.filter((r) => r.profile_id && Number(r.profile_id) === Number(profileId)
      && (r.framing === framing || r.framing === 'any'));
    const sized = fits.filter((r) => r.length_label);
    const pick = sized.find((r) => r.length_label === length) || sized.find((r) => r.is_default) || sized[0];
    return [...(pick ? [pick] : []), ...fits.filter((r) => !r.length_label)];
  }

  // A product's rules for this kind of panel, with the line's choice.
  function itemRules(own, system, option) {
    const fits = own.filter((r) => r.panel_system === system || r.panel_system === 'any');
    const choices = fits.filter((r) => r.option_label);
    const pick = choices.find((r) => r.option_label === option) || choices.find((r) => r.is_default) || choices[0];
    return [...(pick ? [pick] : []), ...fits.filter((r) => !r.option_label)];
  }

  // "Same screw as the panels": the screw (not clip) a panel of that kind gets.
  function panelScrew(rules, products, system, framing, length) {
    const profiles = new Set();
    for (const p of products.values()) if (p.fastening === system && p.profile_id) profiles.add(Number(p.profile_id));
    for (const id of profiles) {
      const r = panelRules(rules, id, framing, length).find((x) => x.category === 'fastener');
      if (r) return r;
    }
    return null;
  }

  // Lengths a quote can pick for this framing, and the usual one.
  function lengths(rules, framing) {
    const f = framing === 'steel' ? 'steel' : 'wood';
    const fits = rules.filter((r) => r.profile_id && r.length_label && (r.framing === f || r.framing === 'any'));
    const def = fits.find((r) => r.is_default) || fits[0];
    return { options: [...new Set(fits.map((r) => r.length_label))], usual: def ? def.length_label : null };
  }

  // Choices offered on a line for this product (e.g. every 18" / every 9").
  function lineOptions(rules, productId) {
    const own = rules.filter((r) => Number(r.item_product_id) === Number(productId) && r.option_label);
    const def = own.find((r) => r.is_default) || own[0];
    return { options: [...new Set(own.map((r) => r.option_label))], usual: def ? def.option_label : null };
  }

  const hasRules = (rules, productId) => rules.some((r) => Number(r.item_product_id) === Number(productId));

  const api = { figure, panelRules, itemRules, lengths, lineOptions, hasRules, SYSTEMS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Screws = api;
}(this));
