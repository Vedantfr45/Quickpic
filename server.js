// QuickPic - share an image with a short code that expires after 10 minutes.
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- Settings (change these if you want) ----------
const PORT = process.env.PORT || 3000;
const CODE_LENGTH = 6;                 // digits in the code
const EXPIRY_MS = 10 * 60 * 1000;      // 10 minutes
const MAX_FILE_MB = 10;                // biggest image allowed
const MAX_UPLOADS_PER_10_MIN = 20;     // per IP address
const MAX_WRONG_CODES_PER_MIN = 10;    // per IP address
// ---------------------------------------------------------

const UPLOAD_DIR = path.join(__dirname, "uploads");
const ALLOWED_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

// Start clean: anything left from a previous run is already expired.
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// code -> { file, mime, name, expiresAt }
const images = new Map();

function newCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
  } while (images.has(code));
  return code;
}

function removeImage(code) {
  const entry = images.get(code);
  if (!entry) return;
  images.delete(code);
  fs.unlink(entry.file, () => {});
}

function getLive(code) {
  const entry = images.get(code);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    removeImage(code);
    return null;
  }
  return entry;
}

// Delete expired images every 30 seconds.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of images) {
    if (now >= entry.expiresAt) removeImage(code);
  }
}, 30 * 1000).unref();

// ---------- Simple per-IP rate limiting ----------
function makeLimiter(max, windowMs) {
  const hits = new Map(); // ip -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (now >= h.resetAt) hits.delete(ip);
  }, windowMs).unref();

  function current(ip) {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now >= h.resetAt) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(ip, h);
    }
    return h;
  }
  return {
    blocked: (ip) => current(ip).count >= max,
    hit: (ip) => { current(ip).count += 1; },
  };
}

const uploadLimiter = makeLimiter(MAX_UPLOADS_PER_10_MIN, 10 * 60 * 1000);
const wrongCodeLimiter = makeLimiter(MAX_WRONG_CODES_PER_MIN, 60 * 1000);

// ---------- Upload handling ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString("hex") + ALLOWED_TYPES[file.mimetype]),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
    const err = new Error("Only image files are allowed (JPG, PNG, WEBP, GIF, HEIC).");
    err.status = 400;
    cb(err);
  },
});

const app = express();
app.set("trust proxy", 1); // needed on Render/Railway so req.ip is the real visitor
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// Send an image, get a code back.
app.post("/api/upload", (req, res, next) => {
  if (uploadLimiter.blocked(req.ip)) {
    return res.status(429).json({ error: "Too many uploads. Please wait a few minutes." });
  }
  upload.single("image")(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: "No image was sent." });

    uploadLimiter.hit(req.ip);
    const code = newCode();
    const expiresAt = Date.now() + EXPIRY_MS;
    images.set(code, {
      file: req.file.path,
      mime: req.file.mimetype,
      name: "quickpic-" + code + ALLOWED_TYPES[req.file.mimetype],
      expiresAt,
    });
    res.json({ code, expiresAt, expiresInSeconds: Math.round(EXPIRY_MS / 1000) });
  });
});

// Shared check for the two "receive" routes below.
function findByCode(req, res) {
  if (wrongCodeLimiter.blocked(req.ip)) {
    res.status(429).json({ error: "Too many wrong codes. Wait a minute and try again." });
    return null;
  }
  const code = String(req.params.code || "");
  const entry = new RegExp("^\\d{" + CODE_LENGTH + "}$").test(code) ? getLive(code) : null;
  if (!entry) {
    wrongCodeLimiter.hit(req.ip);
    res.status(404).json({ error: "No image found for this code. It may have expired." });
    return null;
  }
  return entry;
}

// Is this code valid, and how long is left?
app.get("/api/info/:code", (req, res) => {
  const entry = findByCode(req, res);
  if (!entry) return;
  res.json({
    name: entry.name,
    expiresInSeconds: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
  });
});

// The image itself. Add ?download=1 to force a download.
app.get("/api/image/:code", (req, res) => {
  const entry = findByCode(req, res);
  if (!entry) return;
  res.setHeader("Content-Type", entry.mime);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Disposition",
    (req.query.download ? "attachment" : "inline") + '; filename="' + entry.name + '"'
  );
  fs.createReadStream(entry.file)
    .on("error", () => res.status(404).end())
    .pipe(res);
});

// Tell the page how the server is configured.
app.get("/api/config", (req, res) => {
  res.json({ codeLength: CODE_LENGTH, maxFileMb: MAX_FILE_MB });
});

// Errors (too big, wrong type, anything unexpected).
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Image is too big. The limit is " + MAX_FILE_MB + " MB." });
  }
  if (err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log("QuickPic is running: http://localhost:" + PORT);
});
