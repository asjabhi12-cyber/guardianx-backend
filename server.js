/**
 * Family Locator - Backend Server
 * ---------------------------------
 * Simple, transparent parental location-tracking backend.
 *
 * Endpoints:
 *   POST /api/pair/create        -> parent creates a pairing code for a child device
 *   POST /api/pair/claim         -> child app claims a pairing code, gets a deviceToken
 *   POST /api/location           -> child app sends a location ping (needs deviceToken)
 *   GET  /api/devices            -> parent dashboard: list of paired devices
 *   GET  /api/devices/:id/history -> parent dashboard: location history of one device
 *   GET  /                       -> live map dashboard (open in browser)
 *
 * Storage: simple JSON file (data.json) - fine for a family-scale app.
 * For production with many users, swap this for a real database.
 */

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");
const PORT = process.env.PORT || 3000;

// ---------- tiny JSON "database" ----------
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { pairingCodes: {}, devices: {} };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- 1. Parent creates a pairing code ----------
// Call this from the parent dashboard before installing the app on the child's phone.
app.post("/api/pair/create", (req, res) => {
  const { deviceLabel } = req.body; // e.g. "Rahul's Phone"
  const data = loadData();

  const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
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

  // keep last 500 points only, to stop file from growing forever
  if (device.history.length > 500) {
    device.history = device.history.slice(-500);
  }

  saveData(data);
  res.json({ ok: true });
});

// ---------- 4. Parent dashboard: list devices ----------
app.get("/api/devices", (req, res) => {
  const data = loadData();
  const list = Object.values(data.devices).map((d) => ({
    deviceId: d.deviceId,
    deviceLabel: d.deviceLabel,
    lastSeen: d.lastSeen,
    lastLocation: d.lastLocation,
  }));
  res.json(list);
});

// ---------- 5. Parent dashboard: history of one device ----------
app.get("/api/devices/:id/history", (req, res) => {
  const data = loadData();
  const device = data.devices[req.params.id];
  if (!device) return res.status(404).json({ error: "Not found" });
  res.json(device.history);
});

app.listen(PORT, () => {
  console.log(`Family Locator server running at http://localhost:${PORT}`);
});
