const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const http = require("http");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");

const User = require("./models/User");
const Message = require("./models/Message");
const { sendOtpEmail } = require("./mailer");

const app = express();
const server = http.createServer(app);

// ---------------- SOCKET.IO ----------------
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100 MB for photos & attachments
});

// ---------------- IN-MEMORY FALLBACK & APP STATE ----------------
let isMongoConnected = false;
const memoryUsers = [];
const memoryMessages = [];
const groups = [];
const onlineUsers = new Map(); // username -> Set of socket IDs
const otpStore = new Map(); // key: `${type}:${cleanEmail}` -> { otp, expiresAt, payload }

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------------- MIDDLEWARE ----------------
// Enable CORS for all requests (supports Live Server on port 5500, etc.)
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

// ---------------- MONGODB ----------------
mongoose.connect("mongodb://127.0.0.1:27017/chatApp", {
    serverSelectionTimeoutMS: 2500
}).then(() => {
    isMongoConnected = true;
    console.log("✅ MongoDB Connected");
}).catch(err => {
    isMongoConnected = false;
    console.warn("⚠️ MongoDB offline on 127.0.0.1:27017. Running in in-memory fallback mode so all features work!");
});

mongoose.connection.on("connected", () => { isMongoConnected = true; });
mongoose.connection.on("disconnected", () => { isMongoConnected = false; });
mongoose.connection.on("error", () => { isMongoConnected = false; });

// ---------------- PAGE ROUTES ----------------
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

// ---------------- OTP & REAL-TIME EMAIL REGISTRATION ----------------
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

// ---------------- FORGOT PASSWORD & RESET OTP ----------------
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

// ---------------- DIRECT SIGNUP (BACKWARD COMPATIBLE) ----------------
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

// ---------------- LOGIN ----------------
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
            return res.status(400).json({
                success: false,
                message: "User not found with this username or email."
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

// ---------------- USERS LIST ----------------
app.get("/api/users", async (req, res) => {
    try {
        if (isMongoConnected) {
            const users = await User.find({}, "username fullname email createdAt").sort({ username: 1 });
            return res.json(users);
        }
        res.json(memoryUsers.map(u => ({ username: u.username, fullname: u.fullname, email: u.email, createdAt: u.createdAt })));
    } catch (err) {
        console.error("Error fetching users:", err);
        res.json([]);
    }
});

// ---------------- LAST MESSAGES API ----------------
app.get("/api/last-messages", async (req, res) => {
    try {
        const currentUser = (req.query.user || "").trim().toLowerCase();
        if (!currentUser) return res.json({});

        const lastMessages = {}; // room -> { message, time, username }

        if (isMongoConnected) {
            // Find messages from rooms involving this user
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
    console.error("Error fetching last messages:", err);
    res.json({});
}
});  

// ---------------- DELETE CONVERSATION API ----------------
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

        // Notify room members in real-time
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

// ---------------- GROUPS API ----------------
app.get("/api/groups", (req, res) => {
    res.json(groups);
});

app.post("/api/groups", (req, res) => {
    const { name, createdBy } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: "Group name is required." });
    }

    const id = name.trim().toLowerCase().replace(/\s+/g, "-") + "-" + Math.floor(100 + Math.random() * 900);
    const newGroup = {
        id,
        name: name.trim(),
        createdBy: createdBy || "anonymous",
        createdAt: new Date()
    };
    groups.push(newGroup);

    res.json({ success: true, group: newGroup });
});

// ---------------- ONLINE USERS API ----------------
app.get("/api/online-users", (req, res) => {
    res.json(Array.from(onlineUsers.keys()));
});

// ---------------- SOCKET CHAT ----------------
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
                        memMsg.deletedFor.push(cleanUser);
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

// ---------------- SERVER ----------------
const PORT = process.env.PORT || 8000;

server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});