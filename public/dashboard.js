// Check authentication immediately
const currentUser = localStorage.getItem("chatUser");
if (!currentUser) {
    window.location.href = "/login";
}

// Display current username
document.addEventListener("DOMContentLoaded", () => {
    const userElem = document.getElementById("current-username");
    if (userElem) {
        const fullName = localStorage.getItem("chatFullName");
        userElem.textContent = fullName ? `${fullName} (@${currentUser})` : currentUser;
    }
});

// Logout function
function logout() {
    localStorage.removeItem("chatUser");
    localStorage.removeItem("chatFullName");
    window.location.href = "/login";
}

// Socket connection
const socket = io();

socket.on("connect", () => {
    console.log("Dashboard socket connected:", socket.id);
});

socket.on("connect_error", (err) => {
    console.warn("Socket connection warning:", err.message);
});

// Helper to escape HTML and avoid XSS
function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Start a 1-on-1 chat
function startChat(targetUsername) {
    // Generate deterministic room ID (e.g. alice--bob)
    const room = [currentUser.toLowerCase(), targetUsername.toLowerCase()].sort().join("--");
    window.location.href = `/chat?username=${encodeURIComponent(currentUser)}&room=${encodeURIComponent(room)}&recipient=${encodeURIComponent(targetUsername)}`;
}

// Load contact list
async function loadUsers() {
    const list = document.getElementById("contact-list");
    if (!list) return;

    try {
        const response = await fetch("/api/users");
        const users = await response.json();

        // Filter out current user from contacts list
        const otherUsers = users.filter(u => u.username.toLowerCase() !== currentUser.toLowerCase());

        if (otherUsers.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <p>No other users found.</p>
                    <small>Open an incognito window and sign up another user to start a conversation!</small>
                </div>
            `;
            return;
        }

        list.innerHTML = "";
        otherUsers.forEach(u => {
            const div = document.createElement("div");
            div.className = "contact-card";
            div.title = `Chat with ${u.username}`;

            const displayName = u.fullname || u.username;
            const initial = displayName.charAt(0).toUpperCase();

            div.innerHTML = `
                <div class="user-avatar">${escapeHtml(initial)}</div>
                <div class="user-details">
                    <h3>${escapeHtml(displayName)}</h3>
                    <p>@${escapeHtml(u.username)}</p>
                </div>
            `;

            div.addEventListener("click", () => startChat(u.username));
            list.appendChild(div);
        });

    } catch (err) {
        console.error("Sidebar Fetch Error:", err);
        list.innerHTML = `<div class="empty-state"><p>Error loading contacts.</p></div>`;
    }
}

// Run on page load
window.onload = loadUsers;