const mongoose = require("mongoose");

const statusSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true
    },
    username: {
        type: String,
        required: true,
        index: true
    },
    fullName: {
        type: String,
        default: ""
    },
    avatarUrl: {
        type: String,
        default: null
    },
    type: {
        type: String,
        enum: ["text", "image"],
        default: "text"
    },
    text: {
        type: String,
        default: ""
    },
    mediaUrl: {
        type: String,
        default: null
    },
    bgColor: {
        type: String,
        default: "#00a884"
    },
    fontStyle: {
        type: String,
        default: "normal"
    },
    caption: {
        type: String,
        default: ""
    },
    viewers: {
        type: [String],
        default: []
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: 0 } // MongoDB TTL index to automatically purge expired statuses after 24h
    }
}, {
    timestamps: true
});

module.exports = mongoose.model("Status", statusSchema);
