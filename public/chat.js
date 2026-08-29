const socket = io();
const params = new URLSearchParams(window.location.search);
const username = params.get("username");
const room = params.get("room");

if (!room || !username) {
    window.location.href = "/dashboard";
}

// Join the specific room
socket.emit("join room", room);

const form = document.getElementById("chat-form");
const input = document.getElementById("msg");
const messagesContainer = document.getElementById("messages");

form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value.trim()) {
        socket.emit("chat message", {
            username: username,
            message: input.value,
            room: room
        });
        input.value = "";
    }
});

socket.on("load messages", (msgs) => {
    messagesContainer.innerHTML = "";
    msgs.forEach(displayMessage);
});

socket.on("chat message", (data) => {
    displayMessage(data);
});

function displayMessage(data) {
    const div = document.createElement("div");
    div.classList.add("message");
    if (data.username === username) div.classList.add("me");
    
    div.innerHTML = `
        <strong>${data.username}</strong>
        <p>${data.message}</p>
        <span class="time">${new Date(data.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
    `;
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}