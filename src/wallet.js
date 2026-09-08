const { db, addLedgerEntry } = require("./store");
const { HttpError } = require("./auth");

function adjustBalance(userId, amount, reason, meta = {}) {
  const user = db.users.get(userId);
  if (!user) throw new HttpError(404, "Përdorues i panjohur.");

  const newBalance = round2(user.balance + amount);
  if (newBalance < 0) {
    throw new HttpError(400, "Bilanc i pamjaftueshëm.");
  }

  user.balance = newBalance;
  addLedgerEntry({ userId, amount, reason, balanceAfter: newBalance, ...meta });
  return user.balance;
}

function deposit(userId, amount, pspReference) {
  if (amount <= 0) throw new HttpError(400, "Shuma duhet të jetë pozitive.");
  return adjustBalance(userId, amount, "deposit", { pspReference });
}

function withdraw(userId, amount, pspReference) {
  if (amount <= 0) throw new HttpError(400, "Shuma duhet të jetë pozitive.");
  return adjustBalance(userId, -amount, "withdrawal", { pspReference });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { adjustBalance, deposit, withdraw };