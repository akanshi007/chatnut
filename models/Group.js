const mongoose = require("mongoose");

const groupSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    sublabel: {
        type: String,
        default: null
    },
    createdBy: {
        type: String,
        default: "anonymous"
    },
    members: {
        type: [String],
        default: []
    },
    pinned: {
        type: Boolean,
        default: false
    },
    muted: {
        type: Boolean,
        default: false
    },
    groupIcon: {
        type: String,
        default: "fa-solid fa-users"
    },
    groupColor: {
        type: String,
        default: "#1e293b"
    },
    subBadgeIcon: {
        type: String,
        default: null
    },
    subBadgeColor: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

module.exports = mongoose.model("Group", groupSchema);
