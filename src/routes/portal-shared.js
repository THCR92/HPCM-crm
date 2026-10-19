// Shared by the customer portal and the staff pages that show what customers did there.
const INVITE_DAYS = 14; // how long a set-password link works
const DECLINE_REASONS = {
  changes: 'I need changes to it',
  price: 'Price',
  timing: 'Job delayed or cancelled',
  elsewhere: 'Going with someone else',
  other: 'Other',
};
module.exports = { INVITE_DAYS, DECLINE_REASONS };
