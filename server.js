const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const http = require("http");
const bcrypt = require('bcryptjs');
const { Server } = require("socket.io");

const User = require("./models/User");
const Message = require("./models/Message");

const app = express();
const server = http.createServer(app);

// MODIFIED: In production, it's safer to specify your Render URL, 
// but origin "*" works for initial testing.
const io = new Server(server, { cors: { origin: "*" } });

// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// --- DATABASE CONNECTION ---
// MODIFIED: Use an environment variable (MONGODB_URI) for your Atlas connection string.
// Render will inject this value securely.
const dbURI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/chatApp";

mongoose.connect(dbURI)
    .then(() => console.log("✅ MongoDB Connected Successfully"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- MULTER STORAGE ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, './public/uploads/'); },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + ext); 
    }
});
const upload = multer({ storage: storage });

// --- AUTHENTICATION ROUTES ---

app.post('/signup', async (req, res) => {
    try {
        const { fullname, username, email, password } = req.body;
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).send("User already exists.");

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ fullname, username, email, password: hashedPassword });
        
        await newUser.save();
        res.redirect('/login.html?signup=success');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error creating account.");
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });

        if (user && await bcrypt.compare(password, user.password)) {
            res.json({ 
                success: true, 
                email: user.email, 
                username: user.username 
            });
        } else {
            res.status(401).json({ success: false, message: "Invalid credentials" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post('/api/update-profile', upload.single('profilePic'), async (req, res) => {
    try {
        const { email } = req.body;
        const updateData = {};

        if (req.file) {
            updateData.profilePic = `/uploads/${req.file.filename}`;
        }

        const updatedUser = await User.findOneAndUpdate(
            { email: email },
            { $set: updateData },
            { new: true }
        );

        res.json({ success: true, profilePic: updatedUser.profilePic });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find({}, 'username profilePic'); 
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

// --- REAL-TIME SOCKET LOGIC ---

io.on("connection", (socket) => {
    socket.on("join room", async (data) => {
        try {
            if (!data) return;
            const roomName = typeof data === 'string' 
                ? data 
                : [data.senderId, data.receiverId].sort().join("-");

            socket.join(roomName);
            const messages = await Message.find({ room: roomName })
                .sort({ time: -1 })
                .limit(20);

            socket.emit("load messages", messages.reverse());
        } catch (err) {
            console.error("❌ Join Room Error:", err);
        }
    });

    socket.on("chat message", async (data) => {
        try {
            if (!data.room || !data.username) return;
            const newMsg = new Message({
                username: data.username,
                room: data.room,
                message: data.message || "",
                fileUrl: data.fileUrl || null,
                time: new Date()
            });
            await newMsg.save();
            io.to(data.room).emit("chat message", newMsg);
        } catch (err) {
            console.error("❌ Message Save Error:", err);
        }
    });

    socket.on("typing", (data) => {
        socket.to(data.room).emit("typing", { username: data.username });
    });

    socket.on("stop typing", (room) => {
        socket.to(room).emit("stop typing");
    });
});

// ADDED: Root route to serve your index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- START SERVER ---
// MODIFIED: Use process.env.PORT because Render assigns ports dynamically.
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});