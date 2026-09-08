const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db, randomUUID } = require("./store");

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";

async function register({ username, password, dateOfBirth }) {
  const age = getAge(dateOfBirth);
  if (age < 18) {
    throw new HttpError(403, "Duhet të keni të paktën 18 vjeç për t'u regjistruar.");
  }
  if ([...db.users.values()].some((u) => u.username === username)) {
    throw new HttpError(409, "Ky përdorues ekziston tashmë.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = {
    id: randomUUID(),
    username,
    passwordHash,
    balance: 0,
    kycStatus: "pending",
    selfExcludedUntil: null,
    depositLimitDaily: null,
    createdAt: new Date().toISOString(),
  };
  db.users.set(user.id, user);
  return sanitizeUser(user);
}

async function login({ username, password }) {
  const user = [...db.users.values()].find((u) => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, "Kredenciale të pasakta.");
  }
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "12h" });
  return { token, user: sanitizeUser(user) };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Mungon token i autentikimit." });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.get(payload.sub);
    if (!user) return res.status(401).json({ error: "Përdorues i pavlefshëm." });

    if (user.selfExcludedUntil && new Date(user.selfExcludedUntil) > new Date()) {
      return res.status(403).json({
        error: `Llogaria është nën vetë-përjashtim deri më ${user.selfExcludedUntil}.`,
      });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Token i pavlefshëm ose i skaduar." });
  }
}

function requireKyc(req, res, next) {
  if (req.user.kycStatus !== "verified") {
    return res.status(403).json({
      error: "Verifikimi i identitetit (KYC) kërkohet përpara vendosjes së basteve ose tërheqjes së parave.",
    });
  }
  next();
}

function verifyUserKyc(userId) {
  const user = db.users.get(userId);
  if (!user) {
    throw new HttpError(404, "Përdoruesi nuk u gjet.");
  }
  user.kycStatus = "verified";
  return sanitizeUser(user);
}

function getAge(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const diff = Date.now() - dob.getTime();
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
}

function sanitizeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { register, login, authMiddleware, requireKyc, verifyUserKyc, HttpError };