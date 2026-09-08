const { Pool } = require("pg");
const { randomUUID } = require("crypto");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to start the betting backend.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const pendingWrites = new Set();
const pendingWriteErrors = [];
let writeTail = Promise.resolve();

function enqueueWrite(sql, params) {
  const write = writeTail
    .then(() => pool.query(sql, params))
    .catch((error) => {
      pendingWriteErrors.push(error);
      console.error("PostgreSQL write failed:", error.message);
    })
    .finally(() => {
      pendingWrites.delete(write);
    });

  pendingWrites.add(write);
  return write;
}

async function flushPendingWrites() {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites]);
  }

  if (pendingWriteErrors.length > 0) {
    const error = pendingWriteErrors.shift();
    pendingWriteErrors.length = 0;
    throw error;
  }
}

function toIso(value) {
  if (value == null) return value;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value) {
  return value == null ? value : Number(value);
}

const proxyCache = new WeakMap();

function persistentProxy(value, onChange) {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) {
    return value;
  }

  const cached = proxyCache.get(value);
  if (cached) return cached;

  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      return persistentProxy(Reflect.get(target, property, receiver), onChange);
    },
    set(target, property, nextValue, receiver) {
      const changed = Reflect.set(target, property, nextValue, receiver);
      onChange();
      return changed;
    },
    deleteProperty(target, property) {
      const deleted = Reflect.deleteProperty(target, property);
      if (deleted) onChange();
      return deleted;
    },
  });

  proxyCache.set(value, proxy);
  return proxy;
}

class PersistentMap extends Map {
  constructor({ fromRow, toWrite }) {
    super();
    this.fromRow = fromRow;
    this.toWrite = toWrite;
  }

  hydrate(row) {
    const value = this.fromRow(row);
    let wrappedValue;
    wrappedValue = persistentProxy(value, () => this.persist(wrappedValue));
    super.set(value.id, wrappedValue);
  }

  set(key, value) {
    let wrappedValue;
    wrappedValue = persistentProxy(value, () => this.persist(wrappedValue));
    super.set(key, wrappedValue);
    this.persist(wrappedValue);
    return this;
  }

  delete(key) {
    const deleted = super.delete(key);
    if (deleted) {
      enqueueWrite(this.toWrite.deleteSql, [key]);
    }
    return deleted;
  }

  persist(value) {
    const write = this.toWrite.upsert(value);
    enqueueWrite(write.sql, write.params);
  }
}

function userFromRow(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    balance: toNumber(row.balance),
    kycStatus: row.kyc_status,
    selfExcludedUntil: toIso(row.self_excluded_until),
    depositLimitDaily: toNumber(row.deposit_limit_daily),
    createdAt: toIso(row.created_at),
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    league: row.league,
    home: row.home,
    away: row.away,
    startTime: toIso(row.start_time),
    status: row.status,
    markets: row.markets,
    result: row.result,
    updatedAt: toIso(row.updated_at),
  };
}

function betFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    selections: row.selections,
    stake: toNumber(row.stake),
    combinedOdds: toNumber(row.combined_odds),
    potentialReturn: toNumber(row.potential_return),
    status: row.status,
    placedAt: toIso(row.placed_at),
  };
}

function ledgerFromRow(row) {
  return {
    id: row.id,
    timestamp: toIso(row.timestamp),
    userId: row.user_id,
    amount: toNumber(row.amount),
    reason: row.reason,
    balanceAfter: toNumber(row.balance_after),
    ...(row.bet_id ? { betId: row.bet_id } : {}),
    ...(row.psp_reference ? { pspReference: row.psp_reference } : {}),
    ...(row.metadata || {}),
  };
}

const users = new PersistentMap({
  fromRow: userFromRow,
  toWrite: {
    upsert(user) {
      return {
        sql: `
          INSERT INTO users (
            id, username, password_hash, balance, kyc_status,
            self_excluded_until, deposit_limit_daily, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            username = EXCLUDED.username,
            password_hash = EXCLUDED.password_hash,
            balance = EXCLUDED.balance,
            kyc_status = EXCLUDED.kyc_status,
            self_excluded_until = EXCLUDED.self_excluded_until,
            deposit_limit_daily = EXCLUDED.deposit_limit_daily,
            created_at = EXCLUDED.created_at
        `,
        params: [
          user.id,
          user.username,
          user.passwordHash,
          user.balance,
          user.kycStatus,
          user.selfExcludedUntil,
          user.depositLimitDaily,
          user.createdAt,
        ],
      };
    },
    deleteSql: "DELETE FROM users WHERE id = $1",
  },
});

const events = new PersistentMap({
  fromRow: eventFromRow,
  toWrite: {
    upsert(event) {
      return {
        sql: `
          INSERT INTO events (
            id, league, home, away, start_time, status, markets, result, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
          ON CONFLICT (id) DO UPDATE SET
            league = EXCLUDED.league,
            home = EXCLUDED.home,
            away = EXCLUDED.away,
            start_time = EXCLUDED.start_time,
            status = EXCLUDED.status,
            markets = EXCLUDED.markets,
            result = EXCLUDED.result,
            updated_at = EXCLUDED.updated_at
        `,
        params: [
          event.id,
          event.league,
          event.home,
          event.away,
          event.startTime,
          event.status,
          JSON.stringify(event.markets),
          JSON.stringify(event.result),
          event.updatedAt,
        ],
      };
    },
    deleteSql: "DELETE FROM events WHERE id = $1",
  },
});

const bets = new PersistentMap({
  fromRow: betFromRow,
  toWrite: {
    upsert(bet) {
      return {
        sql: `
          INSERT INTO bets (
            id, user_id, selections, stake, combined_odds,
            potential_return, status, placed_at
          )
          VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            selections = EXCLUDED.selections,
            stake = EXCLUDED.stake,
            combined_odds = EXCLUDED.combined_odds,
            potential_return = EXCLUDED.potential_return,
            status = EXCLUDED.status,
            placed_at = EXCLUDED.placed_at
        `,
        params: [
          bet.id,
          bet.userId,
          JSON.stringify(bet.selections),
          bet.stake,
          bet.combinedOdds,
          bet.potentialReturn,
          bet.status,
          bet.placedAt,
        ],
      };
    },
    deleteSql: "DELETE FROM bets WHERE id = $1",
  },
});

const ledger = [];
const rawLedgerPush = ledger.push.bind(ledger);

function persistLedgerEntry(entry) {
  const knownKeys = new Set([
    "id",
    "timestamp",
    "userId",
    "amount",
    "reason",
    "balanceAfter",
    "betId",
    "pspReference",
  ]);
  const metadata = Object.fromEntries(
    Object.entries(entry).filter(([key]) => !knownKeys.has(key))
  );

  enqueueWrite(
    `
      INSERT INTO ledger (
        id, timestamp, user_id, amount, reason, balance_after,
        bet_id, psp_reference, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        timestamp = EXCLUDED.timestamp,
        user_id = EXCLUDED.user_id,
        amount = EXCLUDED.amount,
        reason = EXCLUDED.reason,
        balance_after = EXCLUDED.balance_after,
        bet_id = EXCLUDED.bet_id,
        psp_reference = EXCLUDED.psp_reference,
        metadata = EXCLUDED.metadata
    `,
    [
      entry.id,
      entry.timestamp,
      entry.userId,
      entry.amount,
      entry.reason,
      entry.balanceAfter ?? null,
      entry.betId ?? null,
      entry.pspReference ?? null,
      JSON.stringify(metadata),
    ]
  );
}

ledger.push = (...entries) => {
  const result = rawLedgerPush(...entries);
  entries.forEach(persistLedgerEntry);
  return result;
};

const db = { users, events, bets, ledger };

async function initializeStore() {
  const [userRows, eventRows, betRows, ledgerRows] = await Promise.all([
    pool.query("SELECT * FROM users ORDER BY created_at ASC"),
    pool.query("SELECT * FROM events ORDER BY updated_at ASC"),
    pool.query("SELECT * FROM bets ORDER BY placed_at ASC"),
    pool.query("SELECT * FROM ledger ORDER BY timestamp ASC"),
  ]);

  userRows.rows.forEach((row) => users.hydrate(row));
  eventRows.rows.forEach((row) => events.hydrate(row));
  betRows.rows.forEach((row) => bets.hydrate(row));
  rawLedgerPush(...ledgerRows.rows.map(ledgerFromRow));

  console.log(
    `Loaded PostgreSQL data: ${users.size} users, ${events.size} events, ` +
      `${bets.size} bets, ${ledger.length} ledger entries`
  );
}

async function closeStore() {
  await flushPendingWrites();
  await pool.end();
}

function addLedgerEntry(entry) {
  ledger.push({ id: randomUUID(), timestamp: new Date().toISOString(), ...entry });
}

module.exports = {
  db,
  randomUUID,
  addLedgerEntry,
  initializeStore,
  flushPendingWrites,
  closeStore,
};