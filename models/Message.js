const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
    id: String,
    username: String,
    senderFullName: String,
    avatarUrl: String,
    message: String,
    room: String,
    mediaUrl: String,
    mediaType: String, // 'image' | 'file'
    fileName: String,
    fileSize: String,
    isDeleted: {
        type: Boolean,
        default: false
    },
    deletedFor: {
        type: [String],
        default: []
    },
    time: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("Message",messageSchema);