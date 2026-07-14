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
 * Storage: MongoDB Atlas (free tier) - this does NOT depend on the hosting
 * platform's local filesystem, so it survives every restart/redeploy even
 * on Render's free instance type (which does not support persistent disks).
 *
 * Required environment variable:
 *   MONGODB_URI - your MongoDB Atlas connection string, e.g.
 *   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/guardianx?retryWrites=true&w=majority
 */

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { MongoClient } = require("mongodb");

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// ⚠️ Dashboard password - isse Render ke Environment Variables me DASHBOARD_PASSWORD
// naam se set karein (recommended), warna ye default use hoga.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme123";

// ---------- Reverse geocoding (lat/long -> human-readable address) ----------
// Uses OpenStreetMap's free Nominatim service. Free tier limits: max ~1
// request/second, and requires a descriptive User-Agent. Our usage (one
// lookup per location ping, every few minutes per device) is well within
// this. Note: this gives street/area/city-level addresses, not exact
// property "plot numbers" - those live in land-registry records, not GPS.
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1&zoom=18`;
    const res = await fetch(url, {
      headers: {
        // Replace the email below with your own - Nominatim's usage policy
        // asks for a way to contact you if there's ever an issue.
        "User-Agent": "GuardianX-FamilyLocationApp/1.0 (family use; contact: your-email@example.com)",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const a = data.address || {};
    return {
      formatted: data.display_name || null,
      road: a.road || a.pedestrian || null,
      area: a.neighbourhood || a.suburb || a.residential || null,
      city: a.city || a.town || a.village || a.county || null,
      state: a.state || null,
      postcode: a.postcode || null,
    };
  } catch (e) {
    console.error("Reverse geocode failed:", e.message);
    return null;
  }
}

if (!MONGODB_URI) {
  console.error(
    "FATAL: MONGODB_URI environment variable is not set. Add it in Render -> Environment."
  );
  process.exit(1);
}

// ---------- MongoDB connection ----------
// Two collections, matching the old data.json shape:
//   pairingCodes: _id = the 6-digit code
//   devices:      _id = deviceId
let db;
let pairingCodes;
let devices;

async function connectToMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(); // uses the database name from the connection string
  pairingCodes = db.collection("pairingCodes");
  devices = db.collection("devices");
  // Helpful for fast lookups, harmless if they already exist
  await pairingCodes.createIndex({ createdAt: 1 });
  await devices.createIndex({ lastSeen: 1 });
  console.log("Connected to MongoDB Atlas");
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
app.post("/api/pair/create", requireDashboardAuth, async (req, res) => {
  try {
    const { deviceLabel } = req.body;
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await pairingCodes.insertOne({
      _id: code,
      deviceLabel: deviceLabel || "Unnamed device",
      createdAt: Date.now(),
      claimed: false,
    });

    res.json({ code });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- 2. Child app claims the pairing code on first launch ----------
app.post("/api/pair/claim", async (req, res) => {
  try {
    const { code } = req.body;
    const entry = await pairingCodes.findOne({ _id: code });

    if (!entry || entry.claimed) {
      return res.status(400).json({ error: "Invalid or already used code" });
    }

    const deviceId = uuidv4();
    const deviceToken = uuidv4();

    await pairingCodes.updateOne({ _id: code }, { $set: { claimed: true } });

    await devices.insertOne({
      _id: deviceId,
      deviceId,
      deviceToken,
      deviceLabel: entry.deviceLabel,
      pairedAt: Date.now(),
      lastSeen: null,
      lastLocation: null,
      history: [],
    });

    res.json({ deviceId, deviceToken, deviceLabel: entry.deviceLabel });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- 3. Child app sends a location ping ----------
app.post("/api/location", async (req, res) => {
  try {
    const { deviceId, deviceToken, latitude, longitude, accuracy, battery } = req.body;
    const device = await devices.findOne({ _id: deviceId });

    if (!device || device.deviceToken !== deviceToken) {
      return res.status(401).json({ error: "Unauthorized device" });
    }

    const address = await reverseGeocode(latitude, longitude);

    const point = {
      latitude,
      longitude,
      accuracy: accuracy || null,
      battery: battery || null,
      timestamp: Date.now(),
      address,
    };

    // Whatever was "current" a moment ago now becomes "previous" -
    // this is what lets the dashboard show "was here, now here".
    const previousLocation = device.lastLocation || null;

    await devices.updateOne(
      { _id: deviceId },
      {
        $set: {
          lastSeen: point.timestamp,
          lastLocation: point,
          previousLocation: previousLocation,
        },
        // keep only the most recent 500 points, same as before
        $push: { history: { $each: [point], $slice: -500 } },
      }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- 4. Parent dashboard: list devices ----------
app.get("/api/devices", requireDashboardAuth, async (req, res) => {
  try {
    const all = await devices.find({}).toArray();
    const list = all.map((d) => ({
      deviceId: d.deviceId,
      deviceLabel: d.deviceLabel,
      pairedAt: d.pairedAt || null,
      lastSeen: d.lastSeen,
      lastLocation: d.lastLocation,
      previousLocation: d.previousLocation || null,
    }));
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- 5. Parent dashboard: history of one device ----------
app.get("/api/devices/:id/history", requireDashboardAuth, async (req, res) => {
  try {
    const device = await devices.findOne({ _id: req.params.id });
    if (!device) return res.status(404).json({ error: "Not found" });
    res.json(device.history || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- 6. Rename a device ----------
app.patch("/api/devices/:id", requireDashboardAuth, async (req, res) => {
  try {
    const { deviceLabel } = req.body;
    const device = await devices.findOne({ _id: req.params.id });
    if (!device) return res.status(404).json({ error: "Not found" });

    await devices.updateOne(
      { _id: req.params.id },
      { $set: { deviceLabel: deviceLabel || device.deviceLabel } }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- 7. Remove a device (and its location history) ----------
app.delete("/api/devices/:id", requireDashboardAuth, async (req, res) => {
  try {
    const result = await devices.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- Start server only after MongoDB is connected ----------
connectToMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GuardianX server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });
