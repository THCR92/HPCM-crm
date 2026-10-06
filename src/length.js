// Lengths are typed as feet + inches, where inches may be "6", "6.5", "6 1/2" or "6-1/2".
function parseInches(s) {
  s = String(s ?? '').trim().replace(/"$/, '');
  if (s === '') return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)?(?:\s*[-\s]\s*)?(?:(\d+)\/(\d+))?$/);
  if (!m || (!m[1] && !m[2])) return NaN;
  return (m[1] ? Number(m[1]) : 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
}

// Feet and inches fields -> total inches; null when both are blank, NaN when unreadable.
function feetInches(ft, inch) {
  const f = String(ft ?? '').trim();
  const i = String(inch ?? '').trim();
  if (f === '' && i === '') return null;
  const feet = f === '' ? 0 : Number(f);
  const inches = parseInches(i);
  if (!Number.isFinite(feet) || feet < 0 || !Number.isFinite(inches)) return NaN;
  return feet * 12 + inches;
}

module.exports = { parseInches, feetInches };
