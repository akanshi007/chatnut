const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const User = require("../models/User");

// POST /signup
router.post("/signup", async (req, res) => {
    try {
        const { fullname, username, email, password } = req.body;
        if (!fullname || !username || !email || !password) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters long." });
        }
        const cleanUsername = username.trim().toLowerCase();
        const cleanEmail = email.trim().toLowerCase();
        const exists = await User.findOne({ $or: [{ email: cleanEmail }, { username: cleanUsername }] });
        if (exists) {
            return res.status(400).json({ success: false, message: "Username or email already exists." });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ fullname: fullname.trim(), username: cleanUsername, email: cleanEmail, password: hashedPassword });
        await newUser.save();
        res.json({ success: true, message: "Signup successful.", username: newUser.username, fullname: newUser.fullname });
    } catch (err) {
        res.status(500).json({ success: false, message: "Signup failed: " + (err.message || "Server error") });
    }
});

// POST /login
router.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: "Username and password are required." });
        }
        const cleanLogin = username.trim().toLowerCase();
        const user = await User.findOne({ $or: [{ username: cleanLogin }, { email: cleanLogin }] });
        if (!user) {
            return res.status(400).json({ success: false, message: "User not found with this username or email." });
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(400).json({ success: false, message: "Incorrect password." });
        }
        res.json({ success: true, username: user.username, fullname: user.fullname });
    } catch (err) {
        res.status(500).json({ success: false, message: "Login failed: " + (err.message || "Server error") });
    }
});

module.exports = router;