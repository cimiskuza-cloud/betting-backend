const express = require("express");
const http = require("http");

const {
  register,
  login,
  authMiddleware,
  requireKyc,
  verifyUserKyc,
  HttpError,
} = require("./auth");
const { createEvent, updateOdds, setResult, listEvents, getEvent } = require("./events");
const { placeBet, settleBetsForEvent, listBetsForUser } = require("./bets");
const { deposit, withdraw } = require("./wallet");
const {
  initiateDepositWithPSP,
  initiateWithdrawalWithPSP,
  verifyWebhookSignature,
  handleDepositWebhook,
} = require("./payments");
const { startOddsFeed } = require("./odds-feed");
const { initializeStore, flushPendingWrites, closeStore } = require("./store");

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      if (req.path === "/api/webhooks/psp") {
        req.rawBody = Buffer.from(buf);
      }
    },
  })
);
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  const originalSendStatus = res.sendStatus.bind(res);

  res.json = (body) =>
    flushPendingWrites()
      .then(() => originalJson(body))
      .catch(next);
  res.sendStatus = (statusCode) =>
    flushPendingWrites()
      .then(() => originalSendStatus(statusCode))
      .catch(next);

  next();
});
app.use(express.static("public"));

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const user = await register(req.body);
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const result = await login(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get("/api/events", (req, res, next) => {
  try {
    res.json(listEvents({ status: req.query.status }));
  } catch (err) {
    next(err);
  }
});

app.get("/api/events/:id", (req, res, next) => {
  try {
    res.json(getEvent(req.params.id));
  } catch (err) {
    next(err);
  }
});

function requireAdmin(req, res, next) {
  if (req.user.username !== process.env.ADMIN_USERNAME) {
    return res.status(403).json({ error: "Kërkohet qasje admini." });
  }
  next();
}

app.post("/api/admin/events", authMiddleware, requireAdmin, (req, res, next) => {
  try {
    res.status(201).json(createEvent(req.body));
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/users/:id/verify-kyc", authMiddleware, requireAdmin, (req, res, next) => {
  try {
    res.json(verifyUserKyc(req.params.id));
  } catch (err) {
    next(err);
  }
});

app.patch("/api/admin/events/:id/odds", authMiddleware, requireAdmin, (req, res, next) => {
  try {
    const { market, odds } = req.body;
    res.json(updateOdds(req.params.id, market, odds));
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/events/:id/result", authMiddleware, requireAdmin, (req, res, next) => {
  try {
    setResult(req.params.id, req.body.result);
    const affectedBets = settleBetsForEvent(req.params.id);
    res.json({ event: getEvent(req.params.id), settledBets: affectedBets.length });
  } catch (err) {
    next(err);
  }
});

app.post("/api/bets", authMiddleware, requireKyc, (req, res, next) => {
  try {
    res.status(201).json(placeBet(req.user.id, req.body));
  } catch (err) {
    next(err);
  }
});

app.get("/api/bets/me", authMiddleware, (req, res, next) => {
  try {
    res.json(listBetsForUser(req.user.id));
  } catch (err) {
    next(err);
  }
});

app.post("/api/wallet/deposit", authMiddleware, requireKyc, async (req, res, next) => {
  try {
    const result = await initiateDepositWithPSP(req.user.id, req.body.amount);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post("/api/wallet/withdraw", authMiddleware, requireKyc, async (req, res, next) => {
  try {
    const result = await initiateWithdrawalWithPSP(req.user.id, req.body.amount);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post(
  "/api/webhooks/psp",
  express.raw({ type: "*/*" }),
  (req, res, next) => {
    try {
      const signature = req.headers["x-psp-signature"];
      const rawBody = req.rawBody || req.body;
      if (!verifyWebhookSignature(rawBody, signature)) {
        return res.status(401).json({ error: "Nënshkrim i pavlefshëm." });
      }
      const event = JSON.parse(rawBody.toString("utf8"));
      if (event.type === "deposit.succeeded") {
        handleDepositWebhook({
          userId: event.userId,
          amount: event.amount,
          pspReference: event.reference,
        });
      }
      res.sendStatus(200);
    } catch (err) {
      next(err);
    }
  }
);

app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Gabim i brendshëm i serverit." });
});

const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

async function startServer() {
  await initializeStore();
  startOddsFeed(server);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Betting API running on http://localhost:${PORT}`);
    console.log(`Live odds WebSocket at ws://localhost:${PORT}/ws/odds`);
  });
}

async function shutdown(signal) {
  console.log(`Received ${signal}; flushing PostgreSQL writes.`);
  try {
    await closeStore();
    process.exit(0);
  } catch (error) {
    console.error("Failed to flush PostgreSQL writes during shutdown:", error);
    process.exit(1);
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

startServer().catch((error) => {
  console.error("Failed to start betting backend:", error);
  process.exitCode = 1;
});

module.exports = app;