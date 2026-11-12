// How an order leaves the shop (Tyler 2026-11-12 added Run on site: standing seam or Board &
// Batten rolled out at the job). Delivery and Run on site both happen at the job address.
const FULFILL_LABEL = { pickup: 'Pickup', delivery: 'Delivery', run_on_site: 'Run on site' };
const FULFILLMENTS = Object.keys(FULFILL_LABEL);
const fulfillLabel = (f) => FULFILL_LABEL[f] || 'Pickup';
const atJob = (f) => f === 'delivery' || f === 'run_on_site';
module.exports = { FULFILL_LABEL, FULFILLMENTS, fulfillLabel, atJob };
