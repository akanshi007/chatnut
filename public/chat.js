const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:8000' : '';
const socket = API_BASE ? io(API_BASE) : io();
const params = new URLSearchParams(window.location.search);

// User and room details
let username = params.get("username") || localStorage.getItem("chatUser");
if (typeof username === "string" && username.trim().startsWith("{")) {
    try {
        const parsed = JSON.parse(username);
        username = parsed.username || parsed.fullname || username;
        localStorage.setItem("chatUser", username);
    } catch (e) {}
}
if (!username) {
    username = "User" + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem("chatUser", username);
}

const room = params.get("room") || "general";
const recipient = params.get("recipient") || "chatNut";

// Elements
const chatTitle = document.getElementById("chatTitle");
const headerAvatar = document.getElementById("headerAvatar");
const chatStatusLine = document.getElementById("chatStatusLine");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

if (chatTitle) {
    chatTitle.textContent = recipient;
}
if (headerAvatar) {
    headerAvatar.textContent = recipient.charAt(0).toUpperCase();
}

// Register user online
socket.emit("user online", username);

// Join room
socket.emit("join room", room);

let isRecipientOnline = false;
let currentOnlineUsers = [];

function updateOnlineStatusUI() {
    if (!chatStatusLine) return;

    // Check if recipient is in online list
    isRecipientOnline = currentOnlineUsers.some(u => u.toLowerCase() === recipient.toLowerCase());

    chatStatusLine.innerHTML = `
        <span class="status-indicator-dot ${isRecipientOnline ? 'online' : 'offline'}"></span>
        <span>${isRecipientOnline ? 'Online' : 'Offline'}</span>
    `;
}

// Listen for global online users
socket.on("online users", (users) => {
    currentOnlineUsers = users || [];
    updateOnlineStatusUI();
});

const form = document.getElementById("chat-form");
const input = document.getElementById("msg");
const messagesContainer = document.getElementById("messages");

// Typing indicator
let typingTimeout = null;

input.addEventListener("input", () => {
    if (input.value.trim().length > 0) {
        socket.emit("typing", { room, username });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            socket.emit("stop typing", { room, username });
        }, 1500);
    } else {
        socket.emit("stop typing", { room, username });
    }
});

socket.on("typing", (typingUser) => {
    if (typingUser !== username && chatStatusLine) {
        chatStatusLine.innerHTML = `
            <span class="typing-active">
                <i class="fa-solid fa-pen-nib"></i> typing...
            </span>
        `;
    }
});

socket.on("stop typing", (typingUser) => {
    if (chatStatusLine) {
        updateOnlineStatusUI();
    }
});

// Send message
form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) {
        socket.emit("stop typing", { room, username });
        socket.emit("chat message", {
            username: username,
            message: text,
            room: room
        });
        input.value = "";
        input.focus();
    }
});

// Load message history
socket.on("load messages", (msgs) => {
    messagesContainer.innerHTML = "";
    if (msgs && msgs.length > 0) {
        msgs.forEach(displayMessage);
    } else {
        const placeholder = document.createElement("div");
        placeholder.className = "empty-chat-prompt";
        placeholder.textContent = `No messages yet. Say hi!`;
        messagesContainer.appendChild(placeholder);
    }
    scrollToBottom();
});

// New incoming message
socket.on("chat message", (data) => {
    const placeholder = messagesContainer.querySelector(".empty-chat-prompt");
    if (placeholder) {
        placeholder.remove();
    }
    displayMessage(data);
    scrollToBottom();

    // Sound chime if message from another user
    if (data.username !== username) {
        playChime();
        // Restore status in case they were typing
        updateOnlineStatusUI();
    }
});

// Notification sound
function playChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
    } catch (e) {}
}

function displayMessage(data) {
    const div = document.createElement("div");
    div.classList.add("message");

    const isMe = data.username.toLowerCase() === username.toLowerCase();
    if (isMe) {
        div.classList.add("me");
    }

    // Sender label (for received messages)
    const strong = document.createElement("span");
    strong.className = "sender-name";
    strong.textContent = data.username;
    div.appendChild(strong);

    // Message text
    const p = document.createElement("p");
    p.className = "text-content";
    p.textContent = data.message;
    div.appendChild(p);

    // Timestamp & checkmark
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const date = data.time ? new Date(data.time) : new Date();
    const timeFormatted = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    meta.innerHTML = `
        <span class="time">${timeFormatted}</span>
        ${isMe ? '<i class="fa-solid fa-check-double checkmark"></i>' : ''}
    `;
    div.appendChild(meta);

    messagesContainer.appendChild(div);
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}