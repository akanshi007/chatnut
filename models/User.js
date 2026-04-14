const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({

    fullname: {
        type: String,
        required: true,
        trim: true,
        minlength: 3
    },

    username: {
        type: String,
        required: true,
        trim: true,
        minlength: 3,
        unique: true
    },

    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },

    password: {
        type: String,
        required: true,
        minlength: 6
    },

    profilePic: { 
        type: String, 
        default: '/uploads/default-avatar.png' } // Default image

}, {
    timestamps: true
});

module.exports = mongoose.model("User", userSchema);