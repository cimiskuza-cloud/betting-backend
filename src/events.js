const { db, randomUUID } = require("./store");
const { HttpError } = require("./auth");

function createEvent({ league, home, away, startTime, odds }) {
  const event = {
    id: randomUUID(),
    league,
    home,
    away,
    startTime,
    status: "scheduled",
    markets: { "1x2": odds },
    result: null,
    updatedAt: new Date().toISOString(),
  };
  db.events.set(event.id, event);
  return event;
}

function updateOdds(eventId, market, odds) {
  const event = db.events.get(eventId);
  if (!event) throw new HttpError(404, "Eventi nuk u gjet.");
  event.markets[market] = { ...event.markets[market], ...odds };
  event.updatedAt = new Date().toISOString();
  return event;
}

function setResult(eventId, result) {
  const event = db.events.get(eventId);
  if (!event) throw new HttpError(404, "Eventi nuk u gjet.");
  if (event.status === "settled") {
    throw new HttpError(409, "Eventi është shlyer tashmë.");
  }
  event.result = result;
  event.status = "finished";
  event.updatedAt = new Date().toISOString();
  return event;
}

function listEvents({ status } = {}) {
  const all = [...db.events.values()];
  return status ? all.filter((e) => e.status === status) : all;
}

function getEvent(eventId) {
  const event = db.events.get(eventId);
  if (!event) throw new HttpError(404, "Eventi nuk u gjet.");
  return event;
}

module.exports = { createEvent, updateOdds, setResult, listEvents, getEvent };