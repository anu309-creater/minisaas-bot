require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const multer = require("multer");

const dbHelper = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_minisaas_key_2026";


// =========================
// BASIC MIDDLEWARE
// =========================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// serve public files
app.use(express.static(path.join(__dirname, "public")));


// =========================
// MULTER FILE UPLOAD
// =========================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const name = Date.now() + "-" + file.originalname;
    cb(null, name);
  },
});

const upload = multer({ storage });


// =========================
// AUTH MIDDLEWARE
// =========================

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const token = authHeader.split(" ")[1];

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Forbidden" });

    req.user = user;
    next();
  });
}


// =========================
// AUTH ROUTES
// =========================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, businessName } = req.body;

    if (!email || !password || !businessName)
      return res.status(400).json({ error: "Missing fields" });

    const userId = await dbHelper.createUser(email, password, businessName);

    const token = jwt.sign({ id: userId, email }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ success: true, token, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await dbHelper.getUserByEmail(email);

    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, email }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ success: true, token, userId: user.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await dbHelper.getUserById(req.user.id);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// =========================
// PORTFOLIO API
// =========================

app.get("/api/portfolio", authenticateToken, async (req, res) => {
  try {
    const config = await dbHelper.getPortfolio(req.user.id);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post(
  "/api/portfolio/upload",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    try {
      const config = await dbHelper.getPortfolio(req.user.id);

      config.images.push({
        id: Date.now().toString(),
        filename: req.file.filename,
      });

      await dbHelper.updatePortfolio(req.user.id, config);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


// =========================
// CONTACT FORM
// =========================

app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body;

    const lead = {
      name,
      email,
      message,
      time: new Date(),
    };

    let leads = [];

    if (fs.existsSync("leads.json")) {
      leads = JSON.parse(fs.readFileSync("leads.json"));
    }

    leads.push(lead);

    fs.writeFileSync("leads.json", JSON.stringify(leads, null, 2));

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// =========================
// PAGE ROUTES
// =========================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "signup.html"));
});

app.get("/contact", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "contact.html"));
});


// =========================
// SOCKET.IO
// =========================

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});


// =========================
// SERVER START
// =========================

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 MiniSaaS Server Started");
  console.log("PORT:", PORT);
});