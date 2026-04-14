document.addEventListener("DOMContentLoaded", () => {
    const socket = io();

    // 1. Security Check
    const userData = JSON.parse(localStorage.getItem('chatUser'));
    if (!userData) {
        window.location.href = "/login.html";
        return;
    }

    const myUsername = userData.username;
    let currentRoom = null;
    let typingTimer;

    // UI Selectors
    const userList = document.getElementById("user-list");
    const messagesDiv = document.getElementById("messages");
    const chatForm = document.getElementById("chat-form");
    const msgInput = document.getElementById("msg");
    const searchInput = document.getElementById("user-search");
    const statusSpan = document.getElementById("typing-status");
    const backBtn = document.getElementById("back-btn");

    // Settings Selectors
    const settingsToggle = document.getElementById('settings-toggle');
    const closeSettings = document.getElementById('close-settings');
    const sidebarMain = document.getElementById('sidebar-main');
    const settingsPanel = document.getElementById('settings-panel');
    const profileInput = document.getElementById('profile-input');
    const avatarPreview = document.getElementById('settings-avatar-preview');

    // 2. Sidebar Logic (Optimized to prevent flickering)
    async function loadSidebar() {
        try {
            const res = await fetch('/api/users');
            const users = await res.json();
            const newListHTML = users
                .filter(u => u.username !== myUsername)
                .map(u => `
                    <div class="user-item" onclick="startChat('${u.username}', this)">
                        <div class="user-avatar-container">
                            <img src="${u.profilePic || '/uploads/default-avatar.png'}" 
     class="contact-avatar" 
     onerror="this.src='https://ui-avatars.com/api/?name=${u.username}'">
                        </div>
                        <div class="user-info-text"><strong>${u.username}</strong></div>
                    </div>
                `).join('');

            if (userList.innerHTML !== newListHTML) {
                userList.innerHTML = newListHTML;
            }
        } catch (err) { console.error("Error loading sidebar", err); }
    }

    // 3. Chat Navigation & Mobile Toggle
    window.startChat = (targetUser, element) => {
        document.querySelectorAll('.user-item').forEach(item => item.classList.remove('active'));
        if (element) element.classList.add('active');

        currentRoom = [myUsername, targetUser].sort().join("-");
        messagesDiv.innerHTML = "";
        document.getElementById("chat-target-name").innerText = targetUser;
        statusSpan.innerText = "Online";

        socket.emit("join room", { senderId: myUsername, receiverId: targetUser });

        // Mobile: Show chat, hide sidebar
        if (window.innerWidth <= 768) {
            document.querySelector(".sidebar").style.display = "none";
            document.querySelector(".chat-container").style.display = "flex";
        }
    };

    // Functional Back Button
    if (backBtn) {
        backBtn.onclick = (e) => {
            e.preventDefault();
            currentRoom = null;
            document.getElementById("chat-target-name").innerText = "Select a Chat";
            messagesDiv.innerHTML = `
                <div class="welcome-screen" style="text-align:center; margin-top:50px;">
                    <h3>Welcome to chatNut!</h3>
                    <p>Select a friend from the sidebar to start chatting.</p>
                </div>`;

            // Mobile: Show sidebar, hide chat
            if (window.innerWidth <= 768) {
                document.querySelector(".sidebar").style.display = "flex";
                document.querySelector(".chat-container").style.display = "none";
            }
            document.querySelectorAll('.user-item').forEach(item => item.classList.remove('active'));
        };
    }

    // 4. Search Filter
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            const searchTerm = e.target.value.toLowerCase();
            document.querySelectorAll(".user-item").forEach(item => {
                const userName = item.querySelector("strong").innerText.toLowerCase();
                item.style.display = userName.includes(searchTerm) ? "flex" : "none";
            });
        });
    }

    // 5. Messaging & Keyboard Support
    chatForm.onsubmit = (e) => {
        e.preventDefault();
        const val = msgInput.value.trim();
        if (!val || !currentRoom) return;
        socket.emit("chat message", { room: currentRoom, username: myUsername, message: val, time: new Date() });
        msgInput.value = "";
    };

    msgInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit'));
        }
    });

    const displayMessage = (data, isHistory = false) => {
        const div = document.createElement("div");
        const isMe = data.username === myUsername;
        div.className = `message ${isMe ? 'me' : 'them'}`;
        const time = new Date(data.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = `<p>${data.message}</p><span class="time">${time}</span>`;
        messagesDiv.appendChild(div);
        messagesDiv.scrollTo({ top: messagesDiv.scrollHeight, behavior: isHistory ? "auto" : "smooth" });
    };

    socket.on("chat message", (data) => displayMessage(data));
    socket.on("load messages", (msgs) => { messagesDiv.innerHTML = ""; msgs.forEach(m => displayMessage(m, true)); });

    // 6. Typing Indicators
    msgInput.addEventListener('input', () => {
        if (!currentRoom) return;
        socket.emit('typing', { username: myUsername, room: currentRoom });
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => socket.emit('stop typing', currentRoom), 2000);
    });

    socket.on("typing", (data) => {
        if (statusSpan) { statusSpan.innerText = "typing..."; statusSpan.style.color = "#25D366"; }
    });

    socket.on("stop typing", () => {
        if (statusSpan) { statusSpan.innerText = "Online"; statusSpan.style.color = "white"; }
    });

    // 7. Settings & Profile Logic
    settingsToggle.onclick = () => {
        sidebarMain.style.display = 'none';
        settingsPanel.style.display = 'flex';
        document.getElementById('profile-username-display').innerText = userData.username;
        document.getElementById('profile-email-display').innerText = userData.email;
        avatarPreview.src = userData.profilePic || "/uploads/default-avatar.png";
    };

    closeSettings.onclick = () => {
        settingsPanel.style.display = 'none';
        sidebarMain.style.display = 'block';
    };

    profileInput.onchange = async () => {
        const file = profileInput.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('profilePic', file);
        formData.append('email', userData.email);
        try {
            const response = await fetch('/api/update-profile', { method: 'POST', body: formData });
            const result = await response.json();
            if (result.success) {
                avatarPreview.src = result.profilePic;
                userData.profilePic = result.profilePic;
                localStorage.setItem('chatUser', JSON.stringify(userData));
                alert("Profile Picture Updated!");
            }
        } catch (err) { console.error("Upload failed", err); }
    };

    document.getElementById('logout-btn').onclick = () => {
        localStorage.removeItem('chatUser');
        window.location.href = '/login.html';
    };

    loadSidebar();
});