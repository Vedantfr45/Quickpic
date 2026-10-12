// QuickPic - share a file with a short code that expires after 10 minutes.
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- Settings (change these if you want) ----------
const PORT = process.env.PORT || 3000;
const CODE_LENGTH = 6;                 // digits in the code
const EXPIRY_MS = 10 * 60 * 1000;      // 10 minutes
const MAX_FILE_MB = 50;                // biggest file allowed
const MAX_UPLOADS_PER_10_MIN = 20;     // per IP address
const MAX_WRONG_CODES_PER_MIN = 10;    // per IP address
// ---------------------------------------------------------

// Allowed files, decided by extension. The server picks the content type
// itself instead of trusting what the browser says.
const FILE_TYPES = {
  ".jpg":  { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".png":  { mime: "image/png", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".gif":  { mime: "image/gif", kind: "image" },
  ".heic": { mime: "image/heic", kind: "image" },
  ".heif": { mime: "image/heif", kind: "image" },
  ".pdf":  { mime: "application/pdf", kind: "pdf" },
  ".txt":  { mime: "text/plain; charset=utf-8", kind: "text" },
  ".mp3":  { mime: "audio/mpeg", kind: "audio" },
  ".m4a":  { mime: "audio/mp4", kind: "audio" },
  ".wav":  { mime: "audio/wav", kind: "audio" },
  ".mp4":  { mime: "video/mp4", kind: "video" },
  ".mov":  { mime: "video/quicktime", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
};
// Phones sometimes send a photo without an extension; fall back on its type.
const MIME_TO_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic", "image/heif": ".heif" };

function extOf(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (FILE_TYPES[ext]) return ext;
  if (!ext && MIME_TO_EXT[file.mimetype]) return MIME_TO_EXT[file.mimetype];
  return null;
}

// Keep the original name for downloads, minus anything unsafe.
function cleanName(original, ext, code) {
  let base = path.basename(original || "", path.extname(original || ""));
  base = base.normalize("NFKC").replace(/[^\p{L}\p{N} ._()-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return (base || "quickpic-" + code) + ext;
}

const UPLOAD_DIR = path.join(__dirname, "uploads");

// Start clean: anything left from a previous run is already expired.
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// code -> { file, ext, name, size, expiresAt }
const files = new Map();

function newCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
  } while (files.has(code));
  return code;
}

function removeFile(code) {
  const entry = files.get(code);
  if (!entry) return;
  files.delete(code);
  fs.unlink(entry.file, () => {});
}

function getLive(code) {
  const entry = files.get(code);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    removeFile(code);
    return null;
  }
  return entry;
}

// Delete expired files every 30 seconds.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of files) {
    if (now >= entry.expiresAt) removeFile(code);
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
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + extOf(file)),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (extOf(file)) return cb(null, true);
    const err = new Error("This file type is not supported. Send a photo, video, MP3, PDF or text file.");
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

// Send a file, get a code back.
app.post("/api/upload", (req, res, next) => {
  if (uploadLimiter.blocked(req.ip)) {
    return res.status(429).json({ error: "Too many uploads. Please wait a few minutes." });
  }
  upload.single("file")(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: "No file was sent." });

    uploadLimiter.hit(req.ip);
    const ext = path.extname(req.file.filename);
    const code = newCode();
    const expiresAt = Date.now() + EXPIRY_MS;
    files.set(code, {
      file: req.file.path,
      ext,
      name: cleanName(req.file.originalname, ext, code),
      size: req.file.size,
      expiresAt,
    });
    res.json({ code, name: files.get(code).name, expiresAt, expiresInSeconds: Math.round(EXPIRY_MS / 1000) });
  });
});

// Shared check for the "receive" routes below.
function findByCode(req, res) {
  if (wrongCodeLimiter.blocked(req.ip)) {
    res.status(429).json({ error: "Too many wrong codes. Wait a minute and try again." });
    return null;
  }
  const code = String(req.params.code || "");
  const entry = new RegExp("^\\d{" + CODE_LENGTH + "}$").test(code) ? getLive(code) : null;
  if (!entry) {
    wrongCodeLimiter.hit(req.ip);
    res.status(404).json({ error: "Nothing found for this code. It may have expired." });
    return null;
  }
  return entry;
}

// Is this code valid, what is it, and how long is left?
app.get("/api/info/:code", (req, res) => {
  const entry = findByCode(req, res);
  if (!entry) return;
  res.json({
    name: entry.name,
    kind: FILE_TYPES[entry.ext].kind,
    size: entry.size,
    expiresInSeconds: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
  });
});

// The file itself. Add ?download=1 to force a download.
// Supports range requests, so videos and audio can be skipped through.
function serveFile(req, res) {
  const entry = findByCode(req, res);
  if (!entry) return;
  const type = FILE_TYPES[entry.ext];
  const ascii = entry.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  res.sendFile(entry.file, {
    acceptRanges: true,
    cacheControl: false,
    headers: {
      "Content-Type": type.mime,
      "Cache-Control": "no-store",
      "Content-Disposition": (req.query.download ? "attachment" : "inline") +
        `; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    },
  }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
}
app.get("/api/file/:code", serveFile);
app.get("/api/image/:code", serveFile); // old address, still works

// Tell the page how the server is configured.
app.get("/api/config", (req, res) => {
  res.json({ codeLength: CODE_LENGTH, maxFileMb: MAX_FILE_MB, extensions: Object.keys(FILE_TYPES) });
});

// Errors (too big, wrong type, anything unexpected).
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File is too big. The limit is " + MAX_FILE_MB + " MB." });
  }
  if (err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log("QuickPic is running: http://localhost:" + PORT);
});
