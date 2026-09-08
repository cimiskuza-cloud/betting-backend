const crypto = require("crypto");
const { deposit, withdraw } = require("./wallet");
const { HttpError } = require("./auth");

const PSP_WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET || "dev-only-secret";

async function initiateDepositWithPSP(userId, amount) {
  throw new HttpError(
    501,
    "Integrimi me PSP nuk është konfiguruar ende. Shto kredencialet e ofruesit tuaj të licencuar në payments.js."
  );
}

async function initiateWithdrawalWithPSP(userId, amount) {
  throw new HttpError(
    501,
    "Integrimi me PSP nuk është konfiguruar ende. Shto kredencialet e ofruesit tuaj të licencuar në payments.js."
  );
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const expected = crypto
    .createHmac("sha256", PSP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const provided = Buffer.from(signatureHeader || "", "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return (
    provided.length === expectedBuf.length &&
    crypto.timingSafeEqual(provided, expectedBuf)
  );
}

function handleDepositWebhook({ userId, amount, pspReference }) {
  return deposit(userId, amount, pspReference);
}

module.exports = {
  initiateDepositWithPSP,
  initiateWithdrawalWithPSP,
  verifyWebhookSignature,
  handleDepositWebhook,
};