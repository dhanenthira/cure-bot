require("dotenv").config();

const express    = require("express");
const bodyParser = require("body-parser");
const cors       = require("cors");
const bcrypt     = require("bcrypt");
const jwt        = require("jsonwebtoken");
const path       = require("path");
const multer     = require("multer");
const fs         = require("fs");
const sharp      = require("sharp");

const scrapeHealthData = require("./scraper");
const getAIResponse    = require("./ai");
const db               = require("./db");

// ─── Multer setup for file uploads ─────────────────────────────────────────────
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_change_me";

async function ensureDatabase(res) {
    await db.init();
    const dbError = db.getLastConnectionError() || db.getLastInitError();
    if (!dbError) return true;

    const hostedHint = db.isConfiguredForHostedDb()
        ? " Check DB_PORT and SSL settings for your hosted MySQL instance."
        : " Check that your MySQL server is running and the database credentials are correct.";

    return res.status(503).json({
        error: "Database connection is unavailable." + hostedHint
    });
}

function getDatabaseUnavailableMessage() {
    return db.isConfiguredForHostedDb()
        ? "Database connection is unavailable. Check DB_PORT and SSL settings for your hosted MySQL instance."
        : "Database connection is unavailable. Check that your MySQL server is running and the database credentials are correct.";
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));


// ─── Page routes ──────────────────────────────────────────────────────────────
app.get("/",        (req, res) => res.sendFile(path.join(__dirname, "public", "landing.html")));
app.get("/login",   (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/signup",  (req, res) => res.sendFile(path.join(__dirname, "public", "signup.html")));
app.get("/chat",    (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));


// ─── 🔐 SIGNUP ────────────────────────────────────────────────────────────────
app.post("/api/signup", async (req, res) => {
    const { username, email, password } = req.body;

    // --- Input validation ---
    if (!username || username.trim().length < 2) {
        return res.status(400).json({ error: "Username must be at least 2 characters." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Please provide a valid email address." });
    }
    if (!password || password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const dbReady = await ensureDatabase(res);
    if (dbReady !== true) return dbReady;

    try {
        // Check email uniqueness
        const [existing] = await db.query(
            "SELECT id FROM users WHERE email = ? OR name = ?",
            [email.toLowerCase(), username.trim()]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: "An account with this email or username already exists." });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Insert user - map username to the existing name column for schema compatibility
        const [result] = await db.query(
            "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
            [username.trim(), email.toLowerCase(), hashedPassword]
        );

        // Issue JWT
        const token = jwt.sign(
            { id: result.insertId, email: email.toLowerCase(), username: username.trim() },
            JWT_SECRET,
            { expiresIn: "1h" }
        );

        return res.status(201).json({
            message: "Account created successfully.",
            token,
            user: { id: result.insertId, username: username.trim(), email: email.toLowerCase() }
        });

    } catch (err) {
        console.error("Signup error:", err);
        if (db.isConnectionError(err)) {
            return res.status(503).json({ error: getDatabaseUnavailableMessage() });
        }
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ error: "An account with this email or username already exists." });
        }
        return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
});


// ─── 🔑 LOGIN ─────────────────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
    const { email, username, password } = req.body;
    
    // Support either email or username
    const identifier = email || username;

    // --- Input validation ---
    if (!identifier) {
        return res.status(400).json({ error: "Please provide an email or username." });
    }
    if (!password) {
        return res.status(400).json({ error: "Password is required." });
    }

    const dbReady = await ensureDatabase(res);
    if (dbReady !== true) return dbReady;

    try {
        const [rows] = await db.query(
            "SELECT id, name, email, password FROM users WHERE email = ? OR name = ?",
            [identifier.toLowerCase(), identifier.trim()]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: "Invalid email/username or password." });
        }

        const user  = rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.status(401).json({ error: "Invalid email/username or password." });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, username: user.name },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        return res.status(200).json({
            message: "Login successful.",
            token,
            user: { id: user.id, username: user.name, email: user.email }
        });

    } catch (err) {
        console.error("Login error:", err);
        if (db.isConnectionError(err)) {
            return res.status(503).json({ error: getDatabaseUnavailableMessage() });
        }
        return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
});


// ─── 🛡️ JWT Middleware ────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Access denied. No token provided." });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Session expired. Please log in again." });
        }
        return res.status(401).json({ error: "Invalid token." });
    }
}



app.get("/api/me", authMiddleware, async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT id, name AS username, email, created_at FROM users WHERE id = ?",
            [req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "User not found." });
        return res.json({ user: rows[0] });
    } catch (err) {
        return res.status(500).json({ error: "Could not fetch profile." });
    }
});


app.post("/api/chat", authMiddleware, async (req, res) => {
    const { message, image } = req.body;

    if (!message && !image) {
        return res.status(400).json({ error: "Message or image is required." });
    }

    try {
        // Save user message
        await db.query("INSERT INTO chat_logs (user_id, role, message) VALUES (?, 'user', ?)", [req.user.id, message || '[image]']);

        const researchData = await scrapeHealthData(message || "general health");
        
        // Convert image URL to base64 if provided
        let imageBase64 = null;
        if (image && typeof image === 'string') {
            try {
                // If image is a URL path like /uploads/file.png, convert to base64
                if (image.startsWith('/uploads/')) {
                    const imagePath = path.join(__dirname, 'public', image);
                    if (fs.existsSync(imagePath)) {
                        const imageData = fs.readFileSync(imagePath);
                        const mimeType = image.match(/\.(jpeg|jpg|png|gif|webp)$/i)?.[1] || 'png';
                        const mimeMap = { 'jpg': 'jpeg', 'jpeg': 'jpeg', 'png': 'png', 'gif': 'gif', 'webp': 'webp' };
                        imageBase64 = `data:image/${mimeMap[mimeType.toLowerCase()]};base64,${imageData.toString('base64')}`;
                    }
                } else {
                    // If already base64, use as-is
                    imageBase64 = image;
                }
            } catch (imgErr) {
                console.error("Image conversion error:", imgErr.message);
            }
        }
        
        const aiResponse   = await getAIResponse(message, researchData, imageBase64);

        // Save bot reply
        await db.query("INSERT INTO chat_logs (user_id, role, message) VALUES (?, 'bot', ?)", [req.user.id, aiResponse]);

        return res.json({
            reply: aiResponse,
            user:  { id: req.user.id, username: req.user.username }
        });
    } catch (err) {
        console.error("Chat error:", err.message);
        return res.status(500).json({ error: "AI service error. Please try again." });
    }
});

// ─── File Upload ───────────────────────────────────────────────────────────────
app.post("/api/upload", authMiddleware, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    
    const filePath = req.file.path;
    const filename = req.file.filename;
    const mimeType = req.file.mimetype;
    
    // Check if it's an image and resize it to medium size
    if (mimeType.startsWith('image/')) {
        try {
            // Resize image to max 800x800px while maintaining aspect ratio and quality
            await sharp(filePath)
                .resize(800, 800, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .jpeg({ quality: 80 })  // 80% quality for good balance of size/quality
                .toFile(filePath + '.tmp');
            
            // Replace original with resized version
            fs.unlinkSync(filePath);
            fs.renameSync(filePath + '.tmp', filePath);
            console.log(`✅ Image resized: ${filename}`);
        } catch (resizeErr) {
            console.error("Image resize error:", resizeErr.message);
            // Continue anyway, serve original if resize fails
        }
    }
    
    return res.json({ url: "/uploads/" + filename, filename: req.file.originalname });
});

// ─── Chat History ──────────────────────────────────────────────────────────────
app.get("/api/chat-history", authMiddleware, async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT role, message, created_at FROM chat_logs WHERE user_id = ? ORDER BY created_at ASC",
            [req.user.id]
        );
        return res.json({ history: rows });
    } catch (err) {
        console.error("History error:", err.message);
        return res.status(500).json({ error: "Could not load history." });
    }
});

app.delete("/api/chat-history", authMiddleware, async (req, res) => {
    try {
        await db.query("DELETE FROM chat_logs WHERE user_id = ?", [req.user.id]);
        return res.json({ message: "History cleared." });
    } catch (err) {
        return res.status(500).json({ error: "Could not clear history." });
    }
});


// ─── 🚀 Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ CureBot server running → http://localhost:${PORT}`);
    console.log(`   Login  : http://localhost:${PORT}/`);
    console.log(`   Signup : http://localhost:${PORT}/signup`);
    console.log(`   Chat   : http://localhost:${PORT}/chat`);
});
app.post("/chat", async (req, res) => {
    const userMessage = req.body.message;

    try {
        const researchData = await scrapeHealthData(userMessage);

        const aiResponse = await getAIResponse(userMessage, researchData);

        res.json({
            reply: aiResponse,
            source: "AI"
        });

    } catch (err) {
        console.error(err);
        res.json({
            reply: "Something went wrong",
            source: "error"
        });
    }
});
