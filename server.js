const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const http = require("http");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");

const User = require("./models/User");
const Message = require("./models/Message");

const app = express();
const server = http.createServer(app);

// ---------------- SOCKET.IO ----------------
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------- MONGODB ----------------
mongoose.connect("mongodb://127.0.0.1:27017/chatApp")
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ MongoDB Error:", err));

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

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/chat", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// ---------------- SIGNUP ----------------
app.post("/signup", async (req, res) => {
    try {
        const { fullname, username, email, password } = req.body;

        const exists = await User.findOne({
            $or: [{ email }, { username }]
        });

        if (exists) {
            return res.status(400).json({
                success: false,
                message: "User already exists."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            fullname,
            username,
            email,
            password: hashedPassword
        });

        await newUser.save();

        res.json({
            success: true,
            message: "Signup successful."
        });

    } catch (err) {
        console.log(err);
        res.status(500).json({
            success: false,
            message: "Signup failed."
        });
    }
});

// ---------------- LOGIN ----------------
app.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await User.findOne({ username });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: "Invalid username."
            });
        }

        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.status(400).json({
                success: false,
                message: "Wrong password."
            });
        }

        res.json({
            success: true,
            username: user.username
        });

    } catch (err) {
        console.log(err);
        res.status(500).json({
            success: false,
            message: "Login failed."
        });
    }
});

// ---------------- USERS LIST ----------------
app.get("/api/users", async (req, res) => {
    try {
        const users = await User.find({}, "username");
        res.json(users);
    } catch (err) {
        res.json([]);
    }
});

// ---------------- SOCKET CHAT ----------------
io.on("connection", (socket) => {

    console.log("📡 Connected:", socket.id);

    socket.on("join room", async (room) => {

        socket.join(room);

        const messages = await Message.find({ room }).sort({ time: 1 });

        socket.emit("load messages", messages);
    });

    socket.on("chat message", async (data) => {

        const message = new Message({
            username: data.username,
            message: data.message,
            room: data.room
        });

        await message.save();

        io.to(data.room).emit("chat message", message);
    });

    socket.on("disconnect", () => {
        console.log("🔌 Disconnected:", socket.id);
    });
});

// ---------------- SERVER ----------------
const PORT = 8000;

server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});