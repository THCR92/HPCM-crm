// Shared by the customer portal and the staff pages that show what customers did there.
const INVITE_DAYS = 14;
const SHOP_HOURS = 'Monday to Friday, 8 am to 4 pm'; // Tyler 2026-10-19
const SHOP_ADDRESS = '805 E Fox Farm Rd Unit B, Cheyenne, WY 82007';
const SHOP_MAP = 'https://www.google.com/maps/search/?api=1&query=805+E+Fox+Farm+Rd+Unit+B+Cheyenne+WY+82007'; // how long a set-password link works
const DECLINE_REASONS = {
  changes: 'I need changes to it',
  price: 'Price',
  timing: 'Job delayed or cancelled',
  elsewhere: 'Going with someone else',
  other: 'Other',
};
module.exports = { INVITE_DAYS, DECLINE_REASONS, SHOP_HOURS, SHOP_ADDRESS, SHOP_MAP };
