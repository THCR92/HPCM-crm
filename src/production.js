// Production runs: cutting pieces from a coil, for an order line or for stock.
// Coils are tracked by linear feet. The database triggers take the footage off
// the coil and add stock when a run is made to stock; this module adds the
// default footage and the undo.

// Coil footage for pieces x length (the coil feeds lengthwise). Trim is slit
// from the coil: when a piece's flat width (girth) is known, as many pieces as
// fit across the coil come out of each length of coil.
function footage(pieces, lengthIn, { girth, coilWidth } = {}) {
  if (!(pieces > 0 && lengthIn > 0)) return null;
  const across = girth > 0 && coilWidth >= girth ? Math.floor(coilWidth / girth) : 1;
  return Math.round(((Math.ceil(pieces / across) * lengthIn) / 12) * 10) / 10;
}

async function undoRun(db, runId) {
  const { rows: [run] } = await db.query(
    'SELECT * FROM production_runs WHERE production_run_id = $1 FOR UPDATE', [runId]);
  if (!run) return null;
  // Put the footage back on the coil and remove the stock the run added.
  await db.query(`
    UPDATE coils SET current_lf = current_lf + $2,
           status = CASE WHEN status = 'depleted' THEN 'in_stock'::coil_status ELSE status END
    WHERE coil_id = $1`, [run.coil_id, run.lf_used]);
  await db.query('DELETE FROM coil_transactions WHERE production_run_id = $1', [runId]);
  if (run.finished_good_id) {
    await db.query('UPDATE finished_goods SET qty_on_hand = qty_on_hand - $2 WHERE finished_good_id = $1',
      [run.finished_good_id, run.pieces]);
    await db.query('DELETE FROM finished_goods_transactions WHERE production_run_id = $1', [runId]);
  }
  await db.query('DELETE FROM production_runs WHERE production_run_id = $1', [runId]);
  return run;
}

// Database messages worth showing to a person as-is.
const runError = (err) => {
  if (err.code === '23514' && /qty_on_hand/.test(err.message)) {
    return "Some of those pieces have already left stock, so this can't be undone.";
  }
  if (err.code === '23514' && /current_lf/.test(err.message)) {
    return 'That would put more footage back on the coil than it came with.';
  }
  if (err.code === 'P0001') return err.message;
  return null;
};

module.exports = { footage, undoRun, runError };
