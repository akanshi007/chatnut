const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const http = require("http");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");

const User = require("./models/User");
const Message = require("./models/Message");
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
const groups = loadLocalJson("groups.json", []);
const memoryStatuses = loadLocalJson("statuses.json", []);
const onlineUsers = new Map();
const otpStore = new Map();

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
app.use(express.static(path.join(__dirname, "public")));

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/chatApp";
mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 2500
}).then(() => {
    isMongoConnected = true;
    console.log("Connected to MongoDB");
}).catch(err => {
    isMongoConnected = false;
    console.log("MongoDB unavailable, running in local storage fallback mode");
});

mongoose.connection.on("connected", () => { isMongoConnected = true; });
mongoose.connection.on("disconnected", () => { isMongoConnected = false; });
mongoose.connection.on("error", () => { isMongoConnected = false; });

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

        otpStore.set(`signup:${cleanEmail}`, {
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
        const record = otpStore.get(`signup:${cleanEmail}`);

        if (!record) {
            return res.status(400).json({
                success: false,
                message: "No pending verification found or code has expired. Please request a new code."
            });
        }

        if (Date.now() > record.expiresAt) {
            otpStore.delete(`signup:${cleanEmail}`);
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
        otpStore.delete(`signup:${cleanEmail}`);

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

        otpStore.set(`reset:${targetEmail}`, {
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
        const record = otpStore.get(`reset:${cleanEmail}`);

        if (!record) {
            return res.status(400).json({
                success: false,
                message: "No reset request found or code has expired. Please request a new code."
            });
        }

        if (Date.now() > record.expiresAt) {
            otpStore.delete(`reset:${cleanEmail}`);
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

        otpStore.delete(`reset:${cleanEmail}`);

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
            user = await User.findOne({
                $or: [{ username: cleanLogin }, { email: cleanLogin }]
            });
        } else {
            user = memoryUsers.find(u => u.username === cleanLogin || u.email === cleanLogin);
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

        const match = await bcrypt.compare(password, user.password);

        if (!match) {
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

// Users API
app.get("/api/users", async (req, res) => {
    try {
        if (isMongoConnected) {
            const users = await User.find({}, "username fullname email avatarUrl bio createdAt").sort({ username: 1 });
            return res.json(users);
        }
        res.json(memoryUsers.map(u => ({ username: u.username, fullname: u.fullname, email: u.email, avatarUrl: u.avatarUrl || null, bio: u.bio || "Hey there! I am using chatNut.", createdAt: u.createdAt })));
    } catch (err) {
        console.error("Error fetching users:", err);
        res.json([]);
    }
});

// Last messages API
app.get("/api/last-messages", async (req, res) => {
    try {
        const currentUser = (req.query.user || "").trim().toLowerCase();
        if (!currentUser) return res.json({});

        const lastMessages = {};

        if (isMongoConnected) {
            const regex = new RegExp(`(^|--)(${currentUser})($|--)`, "i");
            const msgs = await Message.find({ room: regex }).sort({ time: -1 });

            msgs.forEach(m => {
                if (!lastMessages[m.room]) {
                    lastMessages[m.room] = {
                        message: m.message,
                        time: m.time,
                        username: m.username
                    };
                }
            });
        } else {
            for (let i = memoryMessages.length - 1; i >= 0; i--) {
                const m = memoryMessages[i];
                if (m.room && m.room.toLowerCase().includes(currentUser)) {
                    if (!lastMessages[m.room]) {
                        lastMessages[m.room] = {
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
app.get("/api/groups", (req, res) => {
    res.json(groups);
});

app.post("/api/groups", (req, res) => {
    try {
        const { name, createdBy, members } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: "Group name is required." });
        }

        const id = "group-" + name.trim().toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Math.floor(100 + Math.random() * 900);
        const membersList = Array.isArray(members) ? members.map(m => m.toLowerCase()) : [];
        if (createdBy && !membersList.includes(createdBy.toLowerCase())) {
            membersList.push(createdBy.toLowerCase());
        }

        const newGroup = {
            id,
            name: name.trim(),
            createdBy: createdBy || "anonymous",
            members: membersList,
            createdAt: new Date()
        };
        groups.push(newGroup);
        saveLocalJson("groups.json", groups);

        io.emit("group created", newGroup);
        res.json({ success: true, group: newGroup });
    } catch (err) {
        console.error("Create group error:", err);
        res.status(500).json({ success: false, message: "Failed to create group." });
    }
});

// Statuses API
app.get("/api/statuses", (req, res) => {
    const now = Date.now();
    // Return active statuses within 24 hours
    const active = memoryStatuses.filter(s => (now - new Date(s.createdAt).getTime()) < 24 * 60 * 60 * 1000);
    res.json(active);
});

app.post("/api/statuses", (req, res) => {
    try {
        const { username, fullName, avatarUrl, text, mediaUrl, bgColor, fontStyle } = req.body;
        if (!username || (!text && !mediaUrl)) {
            return res.status(400).json({ success: false, message: "Status text or media is required." });
        }

        const newStatus = {
            id: "status-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5),
            username: username.trim().toLowerCase(),
            fullName: fullName || username,
            avatarUrl: avatarUrl || null,
            text: text || "",
            mediaUrl: mediaUrl || null,
            bgColor: bgColor || "#00a884",
            fontStyle: fontStyle || "sans-serif",
            createdAt: new Date()
        };

        memoryStatuses.unshift(newStatus);
        saveLocalJson("statuses.json", memoryStatuses);
        io.emit("new status", newStatus);

        res.json({ success: true, status: newStatus });
    } catch (err) {
        console.error("Post status error:", err);
        res.status(500).json({ success: false, message: "Failed to post status." });
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

            if (isMongoConnected) {
                const messages = await Message.find({ room }).sort({ time: 1 });
                // Filter out messages deleted for requestingUser
                const filtered = messages.filter(m => !m.deletedFor || !m.deletedFor.includes(requestingUser));
                socket.emit("load messages", filtered);
            } else {
                const messages = memoryMessages.filter(m => m.room === room && (!m.deletedFor || !m.deletedFor.includes(requestingUser)));
                socket.emit("load messages", messages);
            }
        } catch (err) {
            console.error("Error loading messages for room:", err);
        }
    });

    // Send chat message (with optional media attachment)
    socket.on("chat message", async (data) => {
        try {
            if (!data || !data.room || (!data.message && !data.mediaUrl) || !data.username) return;

            const msgData = {
                id: "msg-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6),
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

            if (isMongoConnected) {
                const message = new Message(msgData);
                const saved = await message.save();
                io.to(data.room).emit("chat message", saved);
            } else {
                memoryMessages.push(msgData);
                saveLocalJson("messages.json", memoryMessages);
                io.to(data.room).emit("chat message", msgData);
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