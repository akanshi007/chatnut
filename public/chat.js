document.addEventListener("DOMContentLoaded", () => {
    const socket = io();

    // --- SECURITY ---
    const userData = JSON.parse(localStorage.getItem('chatUser'));
    if (!userData) {
        window.location.href = "/login.html";
        return;
    }

    const myUsername = userData.username;
    let currentRoom = null;
    let typingTimer;
    let lastMessageDate = null; // ✅ DATE TRACK

    // --- UI SELECTORS ---
    const inputArea = document.querySelector(".chat-input-area");
    const userList = document.getElementById("user-list");
    const messagesDiv = document.getElementById("messages");
    const chatForm = document.getElementById("chat-form");
    const msgInput = document.getElementById("msg");
    const searchInput = document.getElementById("user-search");
    const statusSpan = document.getElementById("typing-status");
    const backBtn = document.getElementById("back-btn");

    // --- SETTINGS ---
    const settingsToggle = document.getElementById('settings-toggle');
    const closeSettings = document.getElementById('close-settings');
    const sidebarMain = document.getElementById('sidebar-main');
    const settingsPanel = document.getElementById('settings-panel');
    const profileInput = document.getElementById('profile-input');
    const avatarPreview = document.getElementById('settings-avatar-preview');

    // --- INITIAL STATE ---
    inputArea.classList.add("hidden");
    backBtn.style.display = "none";

    // --- LOAD USERS ---
    async function loadSidebar() {
        try {
            const res = await fetch('/api/users');
            const users = await res.json();

            userList.innerHTML = users
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
        } catch (err) {
            console.error("Sidebar error", err);
        }
    }

    // --- START CHAT ---
    window.startChat = (targetUser, element) => {

        document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active'));
        if (element) element.classList.add('active');

        currentRoom = [myUsername, targetUser].sort().join("-");
        lastMessageDate = null; // ✅ reset date

        messagesDiv.innerHTML = "";
        document.getElementById("chat-target-name").innerText = targetUser;
        statusSpan.innerText = "Online";

        inputArea.classList.remove("hidden");

        // Mobile behavior
        if (window.innerWidth <= 768) {
            document.querySelector(".sidebar").classList.add("hide");
            backBtn.style.display = "block";
        }

        socket.emit("join room", {
            senderId: myUsername,
            receiverId: targetUser
        });
    };

    // --- BACK BUTTON ---
    backBtn.onclick = (e) => {
        e.preventDefault();

        currentRoom = null;
        lastMessageDate = null;

        document.getElementById("chat-target-name").innerText = "Select a Chat";

        messagesDiv.innerHTML = `
            <div class="welcome-screen">
                <h3>Welcome to chatNut!</h3>
                <p>Select a friend to start chatting</p>
            </div>
        `;

        inputArea.classList.add("hidden");

        if (window.innerWidth <= 768) {
            document.querySelector(".sidebar").classList.remove("hide");
            backBtn.style.display = "none";
        }

        document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active'));
    };

    // --- SEARCH ---
    searchInput.addEventListener("input", (e) => {
        const val = e.target.value.toLowerCase();
        document.querySelectorAll(".user-item").forEach(item => {
            const name = item.querySelector("strong").innerText.toLowerCase();
            item.style.display = name.includes(val) ? "flex" : "none";
        });
    });

    // --- SEND MESSAGE ---
    chatForm.onsubmit = (e) => {
        e.preventDefault();
        const val = msgInput.value.trim();
        if (!val || !currentRoom) return;

        socket.emit("chat message", {
            room: currentRoom,
            username: myUsername,
            message: val,
            time: new Date()
        });

        msgInput.value = "";
    };

    // Enter key send
    msgInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit'));
        }
    });

    // --- DATE FORMAT ---
    function formatDateLabel(date) {
        const today = new Date();
        const d = new Date(date);

        const isToday =
            d.toDateString() === today.toDateString();

        const yesterday = new Date();
        yesterday.setDate(today.getDate() - 1);

        const isYesterday =
            d.toDateString() === yesterday.toDateString();

        if (isToday) return "Today";
        if (isYesterday) return "Yesterday";

        return d.toLocaleDateString();
    }

    // --- DISPLAY MESSAGE ---
    const displayMessage = (data, isHistory = false) => {

        const msgDate = new Date(data.time).toDateString();

        // DATE SEPARATOR
        if (lastMessageDate !== msgDate) {
            lastMessageDate = msgDate;

            const dateDiv = document.createElement("div");
            dateDiv.className = "date-separator";
            dateDiv.innerText = formatDateLabel(data.time);

            messagesDiv.appendChild(dateDiv);
        }

        const div = document.createElement("div");
        const isMe = data.username === myUsername;

        div.className = `message ${isMe ? 'me' : 'them'}`;

        const time = new Date(data.time).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

        div.innerHTML = `
            <p>${data.message}</p>
            <span class="time">${time}</span>
        `;

        messagesDiv.appendChild(div);

        messagesDiv.scrollTo({
            top: messagesDiv.scrollHeight,
            behavior: isHistory ? "auto" : "smooth"
        });
    };

    socket.on("chat message", data => displayMessage(data));
    socket.on("load messages", msgs => {
        messagesDiv.innerHTML = "";
        lastMessageDate = null;
        msgs.forEach(m => displayMessage(m, true));
    });

    // --- MEDIA ---
    const mediaBtn = document.getElementById('media-btn');
    const mediaInput = document.getElementById('media-input');

    mediaBtn.addEventListener('click', () => mediaInput.click());

    mediaInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file && confirm(`Send ${file.name}?`)) {
            uploadMedia(file);
        }
    });

    // --- TYPING ---
    msgInput.addEventListener('input', () => {
        if (!currentRoom) return;

        socket.emit('typing', {
            username: myUsername,
            room: currentRoom
        });

        clearTimeout(typingTimer);
        typingTimer = setTimeout(() =>
            socket.emit('stop typing', currentRoom), 2000
        );
    });

    socket.on("typing", () => {
        statusSpan.innerText = "typing...";
        statusSpan.style.color = "#25D366";
    });

    socket.on("stop typing", () => {
        statusSpan.innerText = "Online";
        statusSpan.style.color = "white";
    });

    // --- SETTINGS ---
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
            const res = await fetch('/api/update-profile', {
                method: 'POST',
                body: formData
            });

            const result = await res.json();

            if (result.success) {
                avatarPreview.src = result.profilePic;
                userData.profilePic = result.profilePic;
                localStorage.setItem('chatUser', JSON.stringify(userData));
                alert("Profile updated!");
            }
        } catch (err) {
            console.error(err);
        }
    };

    document.getElementById('logout-btn').onclick = () => {
        localStorage.removeItem('chatUser');
        window.location.href = '/login.html';
    };

    loadSidebar();
});