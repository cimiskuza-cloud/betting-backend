const WebSocket = require("ws");
const { updateOdds } = require("./events");

function startOddsFeed(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: "/ws/odds" });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "connected" }));
  });

  function broadcast(update) {
    const payload = JSON.stringify({ type: "odds_update", ...update });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  connectToUpstreamFeed((update) => {
    try {
      const event = updateOdds(update.eventId, update.market, update.odds);
      broadcast({ eventId: event.id, market: update.market, odds: event.markets[update.market] });
    } catch (err) {
      console.error("Odds feed update failed:", err.message);
    }
  });

  return wss;
}

function connectToUpstreamFeed(onUpdate) {
  // Placeholder — connect to your real odds provider here.
}

module.exports = { startOddsFeed };