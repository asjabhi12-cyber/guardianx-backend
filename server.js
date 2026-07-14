/**
 * GuardianX - Backend Server
 * ---------------------------------
 * Simple, transparent parental location-tracking backend.
 *
 * Endpoints:
 *   POST /api/login               -> parent dashboard login (password check)
 *   POST /api/pair/create         -> parent creates a pairing code for a child device
 *   POST /api/pair/claim          -> child app claims a pairing code, gets a deviceToken
 *   POST /api/location            -> child app sends a location ping (needs deviceToken)
 *   GET  /api/devices             -> parent dashboard: list of paired devices (needs dashboard password)
 *   GET  /api/devices/:id/history -> parent dashboard: location history of one device
 *   PATCH /api/devices/:id        -> rename a device
 *   DELETE /api/devices/:id       -> remove a device + its history
 *   GET  /                        -> live map dashboard (open in browser)
 *
 * Storage: simple JSON file (data.json) - fine for a family-scale app.
 *
 * ⚠️ IMPORTANT (Render / most PaaS hosts):
 * The default filesystem on most hosting platforms is EPHEMERAL - it resets
 * on every restart, redeploy, or scale event. If DATA_DIR is not pointed at
 * a persistent disk, all paired devices and location history will silently
 * disappear whenever the service restarts. This is almost always the cause
 * of "devices/locations keep disappearing on their own".
 *
 * To fix on Render:
 *   1. In the Render dashboard, add a "Disk" to this service (Render ->
 *      your service -> Disks -> Add Disk), mounted at e.g. /var/data.
 *   2. Set an environment variable DATA_DIR=/var/data on the service.
 *   3. Redeploy. From then on, data.json lives on the persistent disk and
 *      survives restarts/redeploys.
 */

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

// Point this at a persistent disk mount in production (see note above).
// Defaults to a local "data" folder next to server.js for local dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const PORT = process.env.PORT || 3000;

// ⚠️ Dashboard password - isse Render ke Environment Variables me DASHBOARD_PASSWORD
// naam se set karein (recommended), warna ye default use hoga.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme123";

// ---------- tiny JSON "database" ----------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}
function loadData() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    return { pairingCodes: {}, devices: {} };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Simple dashboard auth middleware ----------
// Parent dashboard requests must send header: x-dashboard-password
function requireDashboardAuth(req, res, next) {
  const pass = req.headers["x-dashboard-password"];
  if (pass !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---------- Login check (dashboard calls this first) ----------
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Galat password" });
});

// ---------- 1. Parent creates a pairing code ----------
app.post("/api/pair/create", requireDashboardAuth, (req, res) => {
  const { deviceLabel } = req.body;
  const data = loadData();

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  data.pairingCodes[code] = {
    deviceLabel: deviceLabel || "Unnamed device",
    createdAt: Date.now(),
    claimed: false,
  };
  saveData(data);

  res.json({ code });
});

// ---------- 2. Child app claims the pairing code on first launch ----------
app.post("/api/pair/claim", (req, res) => {
  const { code } = req.body;
  const data = loadData();

  const entry = data.pairingCodes[code];
  if (!entry || entry.claimed) {
    return res.status(400).json({ error: "Invalid or already used code" });
  }

  const deviceId = uuidv4();
  const deviceToken = uuidv4();

  entry.claimed = true;
  data.devices[deviceId] = {
    deviceId,
    deviceToken,
    deviceLabel: entry.deviceLabel,
    pairedAt: Date.now(),
    lastSeen: null,
    lastLocation: null,
    history: [],
  };
  saveData(data);

  res.json({ deviceId, deviceToken, deviceLabel: entry.deviceLabel });
});

// ---------- 3. Child app sends a location ping ----------
app.post("/api/location", (req, res) => {
  const { deviceId, deviceToken, latitude, longitude, accuracy, battery } = req.body;
  const data = loadData();

  const device = data.devices[deviceId];
  if (!device || device.deviceToken !== deviceToken) {
    return res.status(401).json({ error: "Unauthorized device" });
  }

  const point = {
    latitude,
    longitude,
    accuracy: accuracy || null,
    battery: battery || null,
    timestamp: Date.now(),
  };

  device.lastSeen = point.timestamp;
  device.lastLocation = point;
  device.history.push(point);

  if (device.history.length > 500) {
    device.history = device.history.slice(-500);
  }

  saveData(data);
  res.json({ ok: true });
});

// ---------- 4. Parent dashboard: list devices ----------
app.get("/api/devices", requireDashboardAuth, (req, res) => {
  const data = loadData();
  const list = Object.values(data.devices).map((d) => ({
    deviceId: d.deviceId,
    deviceLabel: d.deviceLabel,
    pairedAt: d.pairedAt || null,
    lastSeen: d.lastSeen,
    lastLocation: d.lastLocation,
  }));
  res.json(list);
});

// ---------- 5. Parent dashboard: history of one device ----------
app.get("/api/devices/:id/history", requireDashboardAuth, (req, res) => {
  const data = loadData();
  const device = data.devices[req.params.id];
  if (!device) return res.status(404).json({ error: "Not found" });
  res.json(device.history);
});

// ---------- 6. Rename a device ----------
app.patch("/api/devices/:id", requireDashboardAuth, (req, res) => {
  const { deviceLabel } = req.body;
  const data = loadData();
  const device = data.devices[req.params.id];
  if (!device) return res.status(404).json({ error: "Not found" });

  device.deviceLabel = deviceLabel || device.deviceLabel;
  saveData(data);
  res.json({ ok: true });
});

// ---------- 7. Remove a device (and its location history) ----------
app.delete("/api/devices/:id", requireDashboardAuth, (req, res) => {
  const data = loadData();
  if (!data.devices[req.params.id]) {
    return res.status(404).json({ error: "Not found" });
  }
  delete data.devices[req.params.id];
  saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`GuardianX server running at http://localhost:${PORT}`);
});
