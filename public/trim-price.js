// Price of one each-priced piece (trim) at a flat width, shared by the order form and
// the server (portal quotes), so both agree. Tyler, 2026-10-21: 26 ga trim is $3.40 per
// inch of flat width (products.price_per_flat_in). The standard width of trim with a set
// flat width (ridge cap 14" flat) stays at its list price. Trim without a rate but with a
// standard flat width scales its list price per standard finished inch.
(function (root) {
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  // p: { price, unit, girth, flat_extra, rate }; width: flat inches; upcharge: color premium %.
  function piecePrice(p, width, upcharge = 0) {
    if (!p) return null;
    const w = Number(width);
    const list = p.price === null || p.price === undefined ? null : Number(p.price);
    let base = list;
    if (p.unit === 'each' && w > 0 && !(Number(p.girth) > 0 && w === Number(p.girth))) {
      if (Number(p.rate) > 0) base = Number(p.rate) * w;
      else if (Number(p.girth) > 0 && list !== null) base = (list / (Number(p.girth) - Number(p.flat_extra || 0))) * w;
    }
    return base === null ? null : round2(base * (1 + (Number(upcharge) || 0) / 100));
  }

  // The flat width a piece at the list price stands for (e.g. $20.40 / $3.40 = 6").
  function standardWidth(p) {
    if (Number(p.girth) > 0) return Number(p.girth);
    if (Number(p.rate) > 0 && p.price !== null && p.price !== undefined) return round2(Number(p.price) / Number(p.rate));
    return null;
  }

  const api = { piecePrice, standardWidth };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrimPrice = api;
}(this));
