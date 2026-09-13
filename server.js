require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const http = require("http");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");

const User = require("./models/User");
const Message = require("./models/Message");
const Group = require("./models/Group");
const Status = require("./models/Status");
const { sendOtpEmail } = require("./mailer");

const app = express();
const server = http.createServer(app);

// Socket.io configuration
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100 MB for photos & attachments
});

// Local file storage fallback when MongoDB is offline
let isMongoConnected = false;
const DATA_DIR = path.join(__dirname, "local_data");
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function loadLocalJson(filename, defaultValue = []) {
    try {
        const filePath = path.join(DATA_DIR, filename);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf8");
            return JSON.parse(content);
        }
    } catch (e) {
        console.warn(`Could not read ${filename}:`, e.message);
    }
    return defaultValue;
}

function saveLocalJson(filename, data) {
    try {
        const filePath = path.join(DATA_DIR, filename);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        console.warn(`Could not save ${filename}:`, e.message);
    }
}

const memoryUsers = loadLocalJson("users.json", []);
const memoryMessages = loadLocalJson("messages.json", []);
const memoryGroups = loadLocalJson("groups.json", []);
const groups = memoryGroups;
const memoryStatuses = loadLocalJson("statuses.json", []);
const onlineUsers = new Map();
const otpStore = new Map();
const persistentOtps = loadLocalJson("otps.json", {});

function getOtpRecord(key) {
    if (otpStore.has(key)) return otpStore.get(key);
    if (persistentOtps && persistentOtps[key]) return persistentOtps[key];
    return null;
}

function setOtpRecord(key, data) {
    otpStore.set(key, data);
    if (persistentOtps) {
        persistentOtps[key] = data;
        saveLocalJson("otps.json", persistentOtps);
    }
}

function deleteOtpRecord(key) {
    otpStore.delete(key);
    if (persistentOtps && persistentOtps[key]) {
        delete persistentOtps[key];
        saveLocalJson("otps.json", persistentOtps);
    }
}

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Middleware
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Prevent browser from aggressively caching HTML, CSS, JS files and API responses
app.use((req, res, next) => {
    if (req.url.endsWith(".html") || req.url.endsWith(".css") || req.url.endsWith(".js") || req.url === "/" || req.url.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
    }
    next();
});

// Provide a sleek default avatar if /uploads/default-avatar.png or /default-avatar.png is ever requested
app.get(["/uploads/default-avatar.png", "/default-avatar.png"], (req, res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
        <defs>
            <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#00a884"/>
                <stop offset="100%" stop-color="#059669"/>
            </linearGradient>
        </defs>
        <circle cx="60" cy="60" r="60" fill="url(#g)"/>
        <circle cx="60" cy="45" r="20" fill="#ffffff"/>
        <path d="M26,102 C30,78 44,70 60,70 C76,70 90,78 94,102 Z" fill="#ffffff"/>
    </svg>`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
});

app.use(express.static(path.join(__dirname, "public")));

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/chatApp";
console.log(`Connecting to MongoDB at: ${MONGO_URI}...`);

mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000
}).then(async () => {
    isMongoConnected = true;
    console.log(` Connected to MongoDB successfully: ${MONGO_URI}`);
    await syncMongoUsersToCache();
}).catch(err => {
    isMongoConnected = false;
    console.warn("MongoDB unavailable, running in local storage fallback mode:", err.message);
});

mongoose.connection.on("connected", async () => {
    isMongoConnected = true;
    console.log(" MongoDB connection active");
    await syncMongoUsersToCache();
});
mongoose.connection.on("disconnected", () => {
    isMongoConnected = false;
    console.warn(" MongoDB connection disconnected");
});
mongoose.connection.on("error", (err) => {
    isMongoConnected = false;
    console.error(" MongoDB error:", err.message);
});

function getCleanAvatarUrl(userDoc) {
    if (!userDoc) return null;
    const url = userDoc.avatarUrl || userDoc.profilePic;
    if (!url || typeof url !== "string") return null;
    const trimmed = url.trim();
    if (!trimmed || trimmed === "null" || trimmed === "undefined" || trimmed.includes("default-avatar") || trimmed.startsWith("/uploads/")) return null;
    return trimmed;
}

// Synchronize real database users into local cache
async function syncMongoUsersToCache() {
    try {
        if (!isMongoConnected) return;
        const mongoUsers = await User.find({}, "username fullname email avatarUrl profilePic bio createdAt updatedAt").lean();
        if (mongoUsers && mongoUsers.length > 0) {
            memoryUsers.length = 0; // Clear any old hardcoded data
            mongoUsers.forEach(u => {
                memoryUsers.push({
                    username: u.username,
                    fullname: u.fullname || u.username,
                    email: u.email,
                    avatarUrl: getCleanAvatarUrl(u),
                    bio: u.bio || "Hey there! I am using chatNut.",
                    createdAt: u.createdAt,
                    updatedAt: u.updatedAt
                });
            });
            saveLocalJson("users.json", memoryUsers);
            console.log(` Synced ${mongoUsers.length} real database users from MongoDB.`);
        }
    } catch (e) {
        console.warn("Could not sync mongo users:", e.message);
    }
}

// Page routes
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/signup", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "signup.html"));
});

app.get("/aftersignup", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "aftersignup.html"));
});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "aftersignup.html"));
});

app.get("/chat", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "aftersignup.html"));
});

// Signup & OTP verification
app.post("/api/send-signup-otp", async (req, res) => {
    try {
        const { fullname, username, email, password } = req.body;

        if (!fullname || !username || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "All fields are required."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters long."
            });
        }

        const cleanUsername = username.trim().toLowerCase();
        const cleanEmail = email.trim().toLowerCase();

        // Check if user already exists
        if (isMongoConnected) {
            const exists = await User.findOne({
                $or: [{ email: cleanEmail }, { username: cleanUsername }]
            });
            if (exists) {
                return res.status(400).json({
                    success: false,
                    message: "Username or email is already registered."
                });
            }
        } else {
            const exists = memoryUsers.find(u => u.username === cleanUsername || u.email === cleanEmail);
            if (exists) {
                return res.status(400).json({
                    success: false,
                    message: "Username or email is already registered."
                });
            }
        }

        // Generate 6-digit OTP
        const otp = generateOtp();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

        setOtpRecord(`signup:${cleanEmail}`, {
            otp,
            expiresAt,
            payload: {
                fullname: fullname.trim(),
                username: cleanUsername,
                email: cleanEmail,
                password
            }
        });

        // Send OTP email in real-time
        const mailResult = await sendOtpEmail(cleanEmail, otp, "signup", fullname.trim());

        res.json({
            success: true,
            message: `Verification code sent to ${cleanEmail}. Please enter the 6-digit code.`,
            email: cleanEmail,
            devOtp: mailResult.devMode ? otp : undefined
        });

    } catch (err) {
        console.error("Send signup OTP error:", err);
        res.status(500).json({
            success: false,
            message: "Failed to send verification code: " + (err.message || "Server error")
        });
    }
});

app.post("/api/verify-signup-otp", async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({
                success: false,
                message: "Email and OTP code are required."
            });
        }

        const cleanEmail = email.trim().toLowerCase();
        const record = getOtpRecord(`signup:${cleanEmail}`);

        if (!record) {
            return res.status(400).json({
                success: false,
                message: "No pending verification found or code has expired. Please request a new code."
            });
        }

        if (Date.now() > record.expiresAt) {
            deleteOtpRecord(`signup:${cleanEmail}`);
            return res.status(400).json({
                success: false,
                message: "Verification code has expired. Please request a new code."
            });
        }

        if (record.otp.trim() !== otp.toString().trim()) {
            return res.status(400).json({
                success: false,
                message: "Incorrect verification code. Please check and try again."
            });
        }

        const { fullname, username, password } = record.payload;

        // Hash password and store user
        const hashedPassword = await bcrypt.hash(password, 10);

        if (isMongoConnected) {
            const newUser = new User({
                fullname,
                username,
                email: cleanEmail,
                password: hashedPassword
            });
            await newUser.save();
        } else {
            memoryUsers.push({
                fullname,
                username,
                email: cleanEmail,
                password: hashedPassword,
                createdAt: new Date()
            });
            saveLocalJson("users.json", memoryUsers);
        }

        // Clean up OTP store
        deleteOtpRecord(`signup:${cleanEmail}`);

        res.json({
            success: true,
            message: "Email verified! Account created successfully.",
            username,
            fullname,
            email: cleanEmail
        });

    } catch (err) {
        console.error("Verify signup OTP error:", err);
        res.status(500).json({
            success: false,
            message: "Verification failed: " + (err.message || "Server error")
        });
    }
});

// Password reset OTP
app.post("/api/send-reset-otp", async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Please enter your registered email address."
            });
        }

        const cleanEmail = email.trim().toLowerCase();
        let user = null;

        if (isMongoConnected) {
            user = await User.findOne({
                $or: [{ email: cleanEmail }, { username: cleanEmail }]
            });
        } else {
            user = memoryUsers.find(u => u.email === cleanEmail || u.username === cleanEmail);
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "No account found with this email or username."
            });
        }

        const targetEmail = user.email.toLowerCase();
        const otp = generateOtp();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

        setOtpRecord(`reset:${targetEmail}`, {
            otp,
            expiresAt,
            username: user.username
        });

        const mailResult = await sendOtpEmail(targetEmail, otp, "reset", user.fullname || user.username);

        res.json({
            success: true,
            message: `Password reset code sent to ${targetEmail}.`,
            email: targetEmail,
            devOtp: mailResult.devMode ? otp : undefined
        });

    } catch (err) {
        console.error("Send reset OTP error:", err);
        res.status(500).json({
            success: false,
            message: "Failed to send reset code: " + (err.message || "Server error")
        });
    }
});

app.post("/api/reset-password", async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;

        if (!email || !otp || !newPassword) {
            return res.status(400).json({
                success: false,
                message: "Email, reset code, and new password are required."
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters long."
            });
        }

        const cleanEmail = email.trim().toLowerCase();
        const record = getOtpRecord(`reset:${cleanEmail}`);

        if (!record) {
            return res.status(400).json({
                success: false,
                message: "No reset request found or code has expired. Please request a new code."
            });
        }

        if (Date.now() > record.expiresAt) {
            deleteOtpRecord(`reset:${cleanEmail}`);
            return res.status(400).json({
                success: false,
                message: "Reset code has expired. Please request a new code."
            });
        }

        if (record.otp.trim() !== otp.toString().trim()) {
            return res.status(400).json({
                success: false,
                message: "Incorrect reset code. Please recheck."
            });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        if (isMongoConnected) {
            await User.updateOne({ email: cleanEmail }, { $set: { password: hashedPassword } });
        } else {
            const u = memoryUsers.find(user => user.email === cleanEmail);
            if (u) {
                u.password = hashedPassword;
                saveLocalJson("users.json", memoryUsers);
            }
        }

        deleteOtpRecord(`reset:${cleanEmail}`);

        res.json({
            success: true,
            message: "Password has been successfully reset! You can now log in."
        });

    } catch (err) {
        console.error("Reset password error:", err);
        res.status(500).json({
            success: false,
            message: "Password reset failed: " + (err.message || "Server error")
        });
    }
});

// Direct signup endpoint
app.post("/signup", async (req, res) => {
    try {
        const { fullname, username, email, password } = req.body;

        if (!fullname || !username || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "All fields are required."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters long."
            });
        }

        const cleanUsername = username.trim().toLowerCase();
        const cleanEmail = email.trim().toLowerCase();

        // Check if user already exists
        if (isMongoConnected) {
            const exists = await User.findOne({
                $or: [{ email: cleanEmail }, { username: cleanUsername }]
            });
            if (exists) {
                return res.status(400).json({
                    success: false,
                    message: "Username or email already exists."
                });
            }
        } else {
            const exists = memoryUsers.find(u => u.username === cleanUsername || u.email === cleanEmail);
            if (exists) {
                return res.status(400).json({
                    success: false,
                    message: "Username or email already exists."
                });
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        if (isMongoConnected) {
            const newUser = new User({
                fullname: fullname.trim(),
                username: cleanUsername,
                email: cleanEmail,
                password: hashedPassword
            });
            await newUser.save();
        } else {
            memoryUsers.push({
                fullname: fullname.trim(),
                username: cleanUsername,
                email: cleanEmail,
                password: hashedPassword,
                createdAt: new Date()
            });
            saveLocalJson("users.json", memoryUsers);
        }

        res.json({
            success: true,
            message: "Signup successful.",
            username: cleanUsername,
            fullname: fullname.trim(),
            email: cleanEmail
        });

    } catch (err) {
        console.error("Signup error:", err);
        res.status(500).json({
            success: false,
            message: "Signup failed: " + (err.message || "Server error")
        });
    }
});

// User login
app.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: "Username and password are required."
            });
        }

        const cleanLogin = username.trim().toLowerCase();
        let user = null;

        if (isMongoConnected) {
            try {
                user = await User.findOne({
                    $or: [{ username: cleanLogin }, { email: cleanLogin }]
                });
            } catch (e) {}
        }
        if (!user) {
            user = memoryUsers.find(u => (u.username || "").toLowerCase() === cleanLogin || (u.email || "").toLowerCase() === cleanLogin);
        }

        if (!user) {
            if (password.length < 4) {
                return res.status(400).json({
                    success: false,
                    message: "Password must be at least 4 characters."
                });
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            const cleanName = cleanLogin.split("@")[0];
            const formattedName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
            const userEmail = cleanLogin.includes("@") ? cleanLogin : `${cleanName}@chatnut.local`;

            const newUserObj = {
                fullname: formattedName,
                username: cleanName,
                email: userEmail,
                password: hashedPassword,
                createdAt: new Date()
            };

            if (isMongoConnected) {
                const dbUser = new User(newUserObj);
                await dbUser.save();
                user = dbUser;
            } else {
                memoryUsers.push(newUserObj);
                saveLocalJson("users.json", memoryUsers);
                user = newUserObj;
            }

            return res.json({
                success: true,
                message: "Account created successfully.",
                username: user.username,
                fullname: user.fullname,
                email: user.email
            });
        }

        // If user exists but has no password (e.g., demo seed user like Hitesh)
        if (user && !user.password) {
            user.password = await bcrypt.hash(password, 10);
            if (isMongoConnected) {
                try {
                    await User.updateOne({ username: user.username }, { $set: { password: user.password } }, { upsert: true });
                } catch (e) {}
            } else {
                saveLocalJson("users.json", memoryUsers);
            }
            return res.json({
                success: true,
                username: user.username,
                fullname: user.fullname,
                email: user.email
            });
        }

        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            // Testing convenience for existing database accounts (hitesh, vinay, krisha, abc)
            if (["hitesh", "vinay", "krisha", "abc"].includes(user.username.toLowerCase())) {
                user.password = await bcrypt.hash(password, 10);
                if (isMongoConnected) {
                    try {
                        await User.updateOne({ username: user.username }, { $set: { password: user.password } });
                    } catch (e) {}
                } else {
                    saveLocalJson("users.json", memoryUsers);
                }
                return res.json({
                    success: true,
                    username: user.username,
                    fullname: user.fullname,
                    email: user.email
                });
            }

            return res.status(400).json({
                success: false,
                message: "Incorrect password."
            });
        }

        res.json({
            success: true,
            username: user.username,
            fullname: user.fullname,
            email: user.email
        });

    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({
            success: false,
            message: "Login failed: " + (err.message || "Server error")
        });
    }
});

// Users API: Loads pure database records from MongoDB
app.get("/api/users", async (req, res) => {
    try {
        if (isMongoConnected) {
            try {
                const mongoUsers = await User.find({}, "username fullname email avatarUrl profilePic bio createdAt updatedAt").lean();
                if (mongoUsers && mongoUsers.length > 0) {
                    const formatted = mongoUsers.map(u => ({
                        username: u.username,
                        fullname: u.fullname || u.username,
                        email: u.email,
                        avatarUrl: getCleanAvatarUrl(u),
                        bio: u.bio || "Hey there! I am using chatNut.",
                        createdAt: u.createdAt,
                        updatedAt: u.updatedAt
                    }));
                    return res.json(formatted);
                }
            } catch (e) {
                console.warn("Could not query mongo users for /api/users:", e.message);
            }
        }

        // Fallback only if MongoDB is offline
        const userMap = new Map();
        memoryUsers.forEach(u => {
            userMap.set((u.username || "").toLowerCase(), {
                username: u.username,
                fullname: u.fullname || u.username,
                email: u.email,
                avatarUrl: getCleanAvatarUrl(u),
                bio: u.bio || "Hey there! I am using chatNut.",
                createdAt: u.createdAt
            });
        });
        res.json(Array.from(userMap.values()));
    } catch (err) {
        console.error("Error fetching users:", err);
        res.json([]);
    }
});

// Database Health and Status API
app.get("/api/db-status", async (req, res) => {
    try {
        const isConnected = mongoose.connection.readyState === 1;
        const status = {
            database: "MongoDB",
            connected: isConnected,
            readyState: mongoose.connection.readyState, // 1 = connected
            host: mongoose.connection.host || "127.0.0.1",
            dbName: mongoose.connection.name || "chatApp",
            collections: {}
        };

        if (isConnected) {
            status.collections.users = await User.countDocuments();
            status.collections.messages = await Message.countDocuments();
            status.collections.groups = await Group.countDocuments();
            status.collections.statuses = await Status.countDocuments();
        } else {
            status.collections.cachedUsers = memoryUsers.length;
            status.collections.cachedMessages = memoryMessages.length;
            status.collections.cachedGroups = memoryGroups.length;
        }

        res.json(status);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Messages history REST API
app.get("/api/messages", async (req, res) => {
    try {
        const { room, user } = req.query;
        if (!room) return res.json([]);
        const requestingUser = (user || "").trim().toLowerCase();

        // Support both room separators: double dash "--" and single dash "-"
        let roomQuery = { room };
        if (room.includes("--")) {
            const alt = room.replace("--", "-");
            roomQuery = { $or: [{ room }, { room: alt }] };
        } else if (room.includes("-")) {
            const alt = room.replace("-", "--");
            roomQuery = { $or: [{ room }, { room: alt }] };
        }

        if (isMongoConnected) {
            const msgs = await Message.find(roomQuery).sort({ time: 1 }).lean();
            const filtered = msgs.filter(m => !m.deletedFor || !m.deletedFor.includes(requestingUser));
            return res.json(filtered || []);
        } else {
            const msgs = memoryMessages.filter(m => {
                const matches = m.room === room || (roomQuery.$or && roomQuery.$or.some(r => r.room === m.room));
                return matches && (!m.deletedFor || !m.deletedFor.includes(requestingUser));
            });
            return res.json(msgs || []);
        }
    } catch (err) {
        console.error("Fetch messages error:", err);
        res.json([]);
    }
});

// Last messages API
app.get("/api/last-messages", async (req, res) => {
    try {
        const currentUser = (req.query.user || "").trim().toLowerCase();
        if (!currentUser) return res.json({});

        const lastMessages = {};

        let userGroupIds = [];
        if (isMongoConnected) {
            try {
                const gList = await Group.find({ members: currentUser }, 'id').lean();
                userGroupIds = gList.map(g => g.id);
            } catch (e) {}
        } else {
            userGroupIds = memoryGroups.filter(g => (g.members || []).map(m => (m || '').toLowerCase()).includes(currentUser)).map(g => g.id);
        }

        if (isMongoConnected) {
            const regex = new RegExp(`(^|[-_])(${currentUser})($|[-_])`, "i");
            const query = userGroupIds.length > 0
                ? { $or: [{ room: regex }, { room: { $in: userGroupIds } }] }
                : { room: regex };
            const msgs = await Message.find(query).sort({ time: -1 });

            msgs.forEach(m => {
                let normRoom = m.room;
                if (normRoom && normRoom.includes("-") && !normRoom.includes("--")) {
                    normRoom = normRoom.replace("-", "--");
                }
                if (!lastMessages[normRoom]) {
                    lastMessages[normRoom] = {
                        message: m.message,
                        time: m.time,
                        username: m.username
                    };
                }
                if (!lastMessages[m.room]) {
                    lastMessages[m.room] = lastMessages[normRoom];
                }
            });
        } else {
            for (let i = memoryMessages.length - 1; i >= 0; i--) {
                const m = memoryMessages[i];
                const matchesUser = m.room && (m.room.toLowerCase().includes(currentUser) || userGroupIds.includes(m.room));
                if (matchesUser) {
                    let normRoom = m.room;
                    if (normRoom && normRoom.includes("-") && !normRoom.includes("--")) {
                        normRoom = normRoom.replace("-", "--");
                    }
                    if (!lastMessages[normRoom]) {
                        lastMessages[normRoom] = {
                            message: m.message,
                            time: m.time,
                            username: m.username
                        };
                    }
                }
            }
        }

        res.json(lastMessages);
    } catch (err) {
        console.error("Last messages error:", err);
        res.json({});
    }
});

// Delete conversation API
app.post("/api/delete-conversation", async (req, res) => {
    try {
        const { user, contact } = req.body;
        if (!user || !contact) {
            return res.status(400).json({ success: false, message: "User and contact are required." });
        }

        const cleanUser = user.trim().toLowerCase();
        const cleanContact = contact.trim().toLowerCase();
        const room = [cleanUser, cleanContact].sort().join("--");

        if (isMongoConnected) {
            await Message.deleteMany({ room });
        }

        for (let i = memoryMessages.length - 1; i >= 0; i--) {
            if (memoryMessages[i].room === room) {
                memoryMessages.splice(i, 1);
            }
        }

        io.to(room).emit("conversation deleted", { room, user: cleanUser, contact: cleanContact });

        res.json({
            success: true,
            message: "Conversation and messages deleted successfully.",
            room
        });
    } catch (err) {
        console.error("Delete conversation error:", err);
        res.status(500).json({ success: false, message: "Failed to delete conversation: " + (err.message || "Server error") });
    }
});

// Groups API
app.get("/api/groups", async (req, res) => {
    try {
        const currentUser = (req.query.user || "").trim().toLowerCase();
        let groupList = [];
        if (isMongoConnected) {
            try {
                if (currentUser) {
                    groupList = await Group.find({ members: currentUser }).sort({ updatedAt: -1 }).lean();
                } else {
                    groupList = await Group.find({}).sort({ updatedAt: -1 }).lean();
                }
            } catch (e) {
                groupList = [];
            }
        }
        if (!groupList || groupList.length === 0) {
            if (currentUser) {
                groupList = memoryGroups.filter(g => (g.members || []).map(m => (m || "").toLowerCase()).includes(currentUser));
            } else {
                groupList = memoryGroups;
            }
        }
        res.json(groupList || []);
    } catch (err) {
        console.error("Error fetching groups:", err);
        res.json([]);
    }
});

app.post("/api/groups", async (req, res) => {
    try {
        const { name, createdBy, members, groupIcon, groupColor } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: "Group name is required." });
        }

        const cleanMembers = Array.isArray(members)
            ? members.map(m => String(m).trim().toLowerCase())
            : [];
        const cleanCreator = (createdBy || "").trim().toLowerCase();
        if (cleanCreator && !cleanMembers.includes(cleanCreator)) {
            cleanMembers.push(cleanCreator);
        }

        const groupId = "group-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6);
        const groupData = {
            id: groupId,
            name: name.trim(),
            createdBy: cleanCreator,
            members: cleanMembers,
            groupIcon: groupIcon || "fa-solid fa-users",
            groupColor: groupColor || "linear-gradient(135deg, #128c7e, #075e54)",
            sublabel: `${cleanMembers.length} members`,
            pinned: false,
            muted: false,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        if (isMongoConnected) {
            const saved = await Group.create(groupData);
            io.emit("group created", saved);
            return res.json({ success: true, group: saved });
        } else {
            memoryGroups.unshift(groupData);
            saveLocalJson("groups.json", memoryGroups);
            io.emit("group created", groupData);
            return res.json({ success: true, group: groupData });
        }
    } catch (err) {
        console.error("Create group error:", err);
        res.status(500).json({ success: false, message: "Failed to create group: " + err.message });
    }
});

// Add contact API
app.post("/api/contacts/add", async (req, res) => {
    try {
        const { user, contactUsername } = req.body;
        if (!user || !contactUsername) {
            return res.status(400).json({ success: false, message: "User and contact username/email are required." });
        }
        const cleanUser = user.trim().toLowerCase();
        const cleanTarget = contactUsername.trim().replace(/^@/, '').toLowerCase();

        if (cleanUser === cleanTarget) {
            return res.status(400).json({ success: false, message: "You cannot add yourself as a contact." });
        }

        let targetUser = null;
        if (isMongoConnected) {
            try {
                const escapedTarget = cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // 1. Try exact match first
                const regexTarget = new RegExp(`^${escapedTarget}$`, 'i');
                targetUser = await User.findOne({
                    $or: [
                        { username: { $regex: regexTarget } },
                        { email: { $regex: regexTarget } },
                        { fullname: { $regex: regexTarget } }
                    ]
                }, "username fullname email avatarUrl profilePic bio createdAt").lean();

                // 2. If not found, try partial match
                if (!targetUser) {
                    const partialRegex = new RegExp(escapedTarget, 'i');
                    targetUser = await User.findOne({
                        $or: [
                            { username: { $regex: partialRegex } },
                            { email: { $regex: partialRegex } },
                            { fullname: { $regex: partialRegex } }
                        ]
                    }, "username fullname email avatarUrl profilePic bio createdAt").lean();
                }

                // 3. Save contact to current user's document
                if (targetUser) {
                    await User.updateOne(
                        { username: new RegExp(`^${cleanUser}$`, 'i') },
                        { $addToSet: { contacts: targetUser.username } }
                    );
                }
            } catch (e) {
                console.warn("MongoDB findOne in /api/contacts/add error:", e.message);
            }
        }
        if (!targetUser) {
            targetUser = memoryUsers.find(u => 
                (u.username || "").toLowerCase() === cleanTarget || 
                (u.email || "").toLowerCase() === cleanTarget || 
                (u.fullname || "").toLowerCase() === cleanTarget
            ) || memoryUsers.find(u =>
                (u.username || "").toLowerCase().includes(cleanTarget) || 
                (u.email || "").toLowerCase().includes(cleanTarget) || 
                (u.fullname || "").toLowerCase().includes(cleanTarget)
            );
        }

        if (!targetUser) {
            return res.status(404).json({ success: false, message: `No registered user found for "${contactUsername}".` });
        }

        res.json({
            success: true,
            message: `Contact "${targetUser.fullname || targetUser.username}" ready to chat!`,
            contact: {
                username: targetUser.username,
                fullname: targetUser.fullname || targetUser.username,
                email: targetUser.email,
                avatarUrl: getCleanAvatarUrl(targetUser),
                bio: targetUser.bio || "Hey there! I am using chatNut."
            }
        });
    } catch (err) {
        console.error("Add contact error:", err);
        res.status(500).json({ success: false, message: "Server error adding contact." });
    }
});

// Get user saved contacts API
app.get("/api/contacts", async (req, res) => {
    try {
        const currentUser = (req.query.user || "").trim().toLowerCase();
        if (!currentUser) return res.json([]);
        if (isMongoConnected) {
            const u = await User.findOne({ username: new RegExp(`^${currentUser}$`, 'i') }, 'contacts').lean();
            if (u && Array.isArray(u.contacts) && u.contacts.length > 0) {
                const contactUsers = await User.find({ username: { $in: u.contacts } }, 'username fullname email avatarUrl profilePic bio createdAt').lean();
                return res.json(contactUsers.map(c => ({
                    ...c,
                    avatarUrl: getCleanAvatarUrl(c)
                })));
            }
        }
        res.json([]);
    } catch (e) {
        res.json([]);
    }
});

// Clear conversation chat history API
app.post("/api/clear-chat", async (req, res) => {
    try {
        const { room, user } = req.body;
        if (!room) return res.status(400).json({ success: false, message: "Room is required." });

        if (isMongoConnected) {
            await Message.deleteMany({ room });
        }
        const remaining = memoryMessages.filter(m => m.room !== room);
        memoryMessages.length = 0;
        memoryMessages.push(...remaining);
        saveLocalJson("messages.json", memoryMessages);

        io.to(room).emit("chat cleared", { room });
        res.json({ success: true, message: "Chat history cleared." });
    } catch (err) {
        console.error("Clear chat error:", err);
        res.status(500).json({ success: false, message: "Failed to clear chat." });
    }
});

// Statuses API
app.get("/api/statuses", async (req, res) => {
    try {
        if (isMongoConnected) {
            const active = await Status.find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
            return res.json(active || []);
        }
        const now = Date.now();
        const active = memoryStatuses.filter(s => (now - new Date(s.createdAt).getTime()) < 24 * 60 * 60 * 1000);
        res.json(active || []);
    } catch (err) {
        console.error("Fetch statuses error:", err);
        res.json([]);
    }
});

app.post("/api/statuses", async (req, res) => {
    try {
        const { username, fullName, avatarUrl, text, mediaUrl, bgColor, fontStyle } = req.body;
        if (!username || (!text && !mediaUrl)) {
            return res.status(400).json({ success: false, message: "Status text or media is required." });
        }

        const statusData = {
            id: "status-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5),
            username: username.trim().toLowerCase(),
            fullName: fullName || username,
            avatarUrl: avatarUrl || null,
            text: text || "",
            mediaUrl: mediaUrl || null,
            bgColor: bgColor || "#00a884",
            fontStyle: fontStyle || "sans-serif",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        };

        if (isMongoConnected) {
            const saved = await Status.create(statusData);
            io.emit("new status", saved);
            return res.json({ success: true, status: saved });
        } else {
            memoryStatuses.unshift(statusData);
            saveLocalJson("statuses.json", memoryStatuses);
            io.emit("new status", statusData);
            return res.json({ success: true, status: statusData });
        }
    } catch (err) {
        console.error("Post status error:", err);
        res.status(500).json({ success: false, message: "Failed to post status: " + err.message });
    }
});


// Profile update API (avatar & bio)
app.post("/api/update-profile", async (req, res) => {
    try {
        const { username, avatarUrl, bio, fullname } = req.body;
        if (!username) return res.status(400).json({ success: false, message: "Username is required." });

        const clean = username.trim().toLowerCase();
        const updateFields = {};
        if (avatarUrl !== undefined) updateFields.avatarUrl = avatarUrl;
        if (bio !== undefined) updateFields.bio = bio;
        if (fullname) updateFields.fullname = fullname;

        if (isMongoConnected) {
            await User.updateOne({ username: clean }, { $set: updateFields });
        }

        const u = memoryUsers.find(user => user.username === clean);
        if (u) {
            if (avatarUrl !== undefined) u.avatarUrl = avatarUrl;
            if (bio !== undefined) u.bio = bio;
            if (fullname) u.fullname = fullname;
            saveLocalJson("users.json", memoryUsers);
        }

        io.emit("user profile updated", { username: clean, avatarUrl, bio, fullname });
        res.json({ success: true, message: "Profile updated successfully.", avatarUrl, bio });
    } catch (err) {
        console.error("Profile update error:", err);
        res.status(500).json({ success: false, message: "Failed to update profile." });
    }
});

// Online users API
app.get("/api/online-users", (req, res) => {
    res.json(Array.from(onlineUsers.keys()));
});

// Socket.IO events
io.on("connection", (socket) => {
    let currentSocketUser = null;

    // Track online user
    socket.on("user online", (username) => {
        if (!username) return;
        const clean = username.trim().toLowerCase();
        currentSocketUser = clean;

        // Automatically join private user room for direct cross-room notifications
        socket.join("user:" + clean);

        if (!onlineUsers.has(clean)) {
            onlineUsers.set(clean, new Set());
        }
        onlineUsers.get(clean).add(socket.id);

        io.emit("online users", Array.from(onlineUsers.keys()));
    });

    // Room join & load message history
    socket.on("join room", async (param) => {
        try {
            const room = typeof param === "object" ? param.room : param;
            const requestingUser = (typeof param === "object" && param.user) ? param.user.toLowerCase() : (currentSocketUser || "");

            if (!room) return;
            socket.join(room);

            // Support both room separators: double dash "--" and single dash "-"
            let roomQuery = { room };
            if (room.includes("--")) {
                const alt = room.replace("--", "-");
                socket.join(alt);
                roomQuery = { $or: [{ room }, { room: alt }] };
            } else if (room.includes("-")) {
                const alt = room.replace("-", "--");
                socket.join(alt);
                roomQuery = { $or: [{ room }, { room: alt }] };
            }

            if (isMongoConnected) {
                const messages = await Message.find(roomQuery).sort({ time: 1 }).lean();
                // Filter out messages deleted for requestingUser
                const filtered = messages.filter(m => !m.deletedFor || !m.deletedFor.includes(requestingUser));
                socket.emit("load messages", filtered || []);
            } else {
                const messages = memoryMessages.filter(m => {
                    const matches = m.room === room || (roomQuery.$or && roomQuery.$or.some(r => r.room === m.room));
                    return matches && (!m.deletedFor || !m.deletedFor.includes(requestingUser));
                });
                socket.emit("load messages", messages || []);
            }
        } catch (err) {
            console.error("Error loading messages for room:", err);
            socket.emit("load messages", []);
        }
    });

    // Send chat message (with optional media attachment)
    socket.on("chat message", async (data) => {
        try {
            if (!data || !data.room || (!data.message && !data.mediaUrl) || !data.username) return;

            const msgData = {
                id: data.id || ("msg-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6)),
                username: data.username,
                senderFullName: data.senderFullName || data.username,
                avatarUrl: data.avatarUrl || null,
                message: data.message || "",
                room: data.room,
                mediaUrl: data.mediaUrl || null,
                mediaType: data.mediaType || null, // 'image' | 'file'
                fileName: data.fileName || null,
                fileSize: data.fileSize || null,
                isDeleted: false,
                deletedFor: [],
                time: new Date()
            };

            let outMessage = msgData;
            if (isMongoConnected) {
                const message = new Message(msgData);
                outMessage = await message.save();
            } else {
                memoryMessages.push(msgData);
                saveLocalJson("messages.json", memoryMessages);
            }

            // 1. Deliver to all clients currently inside this chat room (and alternate representation)
            io.to(data.room).emit("chat message", outMessage);
            if (data.room.includes("--")) {
                io.to(data.room.replace("--", "-")).emit("chat message", outMessage);
            } else if (data.room.includes("-") && !data.room.startsWith("group-")) {
                io.to(data.room.replace("-", "--")).emit("chat message", outMessage);
            }

            // 2. Also deliver to recipient's personal user room so they receive real-time notifications anywhere in the app
            const roomStr = data.room || "";
            if (!roomStr.startsWith("group-") && (roomStr.includes("--") || roomStr.includes("-"))) {
                const parts = roomStr.includes("--") ? roomStr.split("--") : roomStr.split("-");
                parts.forEach(u => {
                    const cleanU = (u || "").trim().toLowerCase();
                    if (cleanU && cleanU !== data.username.toLowerCase()) {
                        io.to("user:" + cleanU).emit("chat message", outMessage);
                    }
                });
            } else if (roomStr.startsWith("group-")) {
                let gObj = null;
                if (isMongoConnected) {
                    try { gObj = await Group.findOne({ id: roomStr }).lean(); } catch (e) {}
                }
                if (!gObj) {
                    gObj = memoryGroups.find(g => g.id === roomStr);
                }
                if (gObj && Array.isArray(gObj.members)) {
                    gObj.members.forEach(member => {
                        const cleanM = (member || "").trim().toLowerCase();
                        if (cleanM && cleanM !== data.username.toLowerCase()) {
                            io.to("user:" + cleanM).emit("chat message", outMessage);
                        }
                    });
                }
            }

            // Auto-reply if message sent to chatnut bot
            const roomLower = (data.room || "").toLowerCase();
            const senderLower = (data.username || "").toLowerCase();
            if (roomLower.includes("chatnut") && senderLower !== "chatnut") {
                io.to(data.room).emit("typing", "chatnut");
                setTimeout(async () => {
                    io.to(data.room).emit("stop typing", "chatnut");
                    const userText = (data.message || "").toLowerCase().trim();
                    let botReplyText = "Hello! 👋 I am chatNut Assistant. You can send messages, emojis, and media attachments right here!";

                    if (userText.includes("hi") || userText.includes("hello") || userText.includes("hey")) {
                        botReplyText = `Hey ${data.senderFullName || data.username}! 👋 How are you doing today?`;
                    } else if (userText.includes("how are you")) {
                        botReplyText = "I'm doing great, thank you! Ready to chat whenever you are. 😊";
                    } else if (userText.includes("help") || userText.includes("feature")) {
                        botReplyText = "Here are things you can try in chatNut: send text, attachments & emojis, post a 24-hour status update, create group chats, or switch themes using the icon at the top! 🚀";
                    } else if (userText.includes("who are you")) {
                        botReplyText = "I'm the built-in chatNut Assistant bot, designed to help you explore and test all real-time features. 🤖";
                    } else if (userText.includes("bye") || userText.includes("good night")) {
                        botReplyText = "Goodbye! Have an amazing day ahead! ✨";
                    } else if (data.mediaUrl) {
                        botReplyText = "Nice attachment! 👍 Thanks for sharing!";
                    }

                    const botMsg = {
                        id: "msg-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6),
                        username: "chatnut",
                        senderFullName: "chatNut Bot",
                        avatarUrl: "https://cdn-icons-png.flaticon.com/512/8943/8943377.png",
                        message: botReplyText,
                        room: data.room,
                        mediaUrl: null,
                        mediaType: null,
                        fileName: null,
                        fileSize: null,
                        isDeleted: false,
                        deletedFor: [],
                        time: new Date()
                    };

                    if (isMongoConnected) {
                        try {
                            const bMsg = new Message(botMsg);
                            const savedBotMsg = await bMsg.save();
                            io.to(data.room).emit("chat message", savedBotMsg);
                        } catch (e) {
                            io.to(data.room).emit("chat message", botMsg);
                        }
                    } else {
                        memoryMessages.push(botMsg);
                        saveLocalJson("messages.json", memoryMessages);
                        io.to(data.room).emit("chat message", botMsg);
                    }
                }, 900);
            }
        } catch (err) {
            console.error("Error saving chat message:", err);
        }
    });

    // Delete message (everyone or for me)
    socket.on("delete message", async (data) => {
        try {
            if (!data || !data.messageId) return;
            const { messageId, room, deleteType, username } = data;
            const cleanUser = (username || currentSocketUser || "").toLowerCase();

            if (deleteType === "everyone") {
                if (isMongoConnected) {
                    if (mongoose.Types.ObjectId.isValid(messageId)) {
                        await Message.findByIdAndUpdate(messageId, { isDeleted: true, message: "This message was deleted", mediaUrl: null });
                    } else {
                        await Message.updateOne({ id: messageId }, { isDeleted: true, message: "This message was deleted", mediaUrl: null });
                    }
                }
                const memMsg = memoryMessages.find(m => m.id === messageId || m._id == messageId);
                if (memMsg) {
                    memMsg.isDeleted = true;
                    memMsg.message = "This message was deleted";
                    memMsg.mediaUrl = null;
                    saveLocalJson("messages.json", memoryMessages);
                }
                io.to(room).emit("message deleted", { messageId, deleteType: "everyone" });
            } else if (deleteType === "me") {
                if (cleanUser) {
                    if (isMongoConnected) {
                        if (mongoose.Types.ObjectId.isValid(messageId)) {
                            await Message.findByIdAndUpdate(messageId, { $addToSet: { deletedFor: cleanUser } });
                        } else {
                            await Message.updateOne({ id: messageId }, { $addToSet: { deletedFor: cleanUser } });
                        }
                    }
                    const memMsg = memoryMessages.find(m => m.id === messageId || m._id == messageId);
                    if (memMsg) {
                        if (!memMsg.deletedFor) memMsg.deletedFor = [];
                        if (!memMsg.deletedFor.includes(cleanUser)) {
                            memMsg.deletedFor.push(cleanUser);
                            saveLocalJson("messages.json", memoryMessages);
                        }
                    }
                    socket.emit("message deleted", { messageId, deleteType: "me" });
                }
            }
        } catch (err) {
            console.error("Delete message error:", err);
        }
    });

    // Typing indicators
    socket.on("typing", (data) => {
        if (data && data.room) {
            socket.to(data.room).emit("typing", data.username);
        }
    });

    socket.on("stop typing", (data) => {
        if (data && data.room) {
            socket.to(data.room).emit("stop typing", data.username);
        }
    });

    // Audio & Video Call signaling
    socket.on("call user", (data) => {
        if (!data) return;
        const targetUsername = (data.to || "").toLowerCase();
        const callPayload = {
            from: data.from,
            callerFullName: data.callerFullName || data.from,
            room: data.room,
            callType: data.callType || "voice"
        };
        if (targetUsername && onlineUsers.has(targetUsername)) {
            const socketIds = onlineUsers.get(targetUsername);
            socketIds.forEach(sId => io.to(sId).emit("incoming call", callPayload));
        } else if (data.room) {
            socket.to(data.room).emit("incoming call", callPayload);
        }
    });

    socket.on("end call", (data) => {
        if (!data) return;
        const targetUsername = (data.to || "").toLowerCase();
        if (targetUsername && onlineUsers.has(targetUsername)) {
            const socketIds = onlineUsers.get(targetUsername);
            socketIds.forEach(sId => io.to(sId).emit("call ended", { room: data.room }));
        } else if (data.room) {
            socket.to(data.room).emit("call ended", { room: data.room });
        }
    });

    // Disconnect cleanup
    socket.on("disconnect", () => {
        if (currentSocketUser && onlineUsers.has(currentSocketUser)) {
            const set = onlineUsers.get(currentSocketUser);
            set.delete(socket.id);
            if (set.size === 0) {
                onlineUsers.delete(currentSocketUser);
            }
            io.emit("online users", Array.from(onlineUsers.keys()));
        }
    });
});

// Server start
const PORT = process.env.PORT || 8000;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});