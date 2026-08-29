console.log("Dashboard script loaded...");

// Force the client to use polling to bypass the firewall
const socket = io({
    transports: ['polling'], 
    upgrade: false // Do not try to switch to WebSockets yet
});

socket.on("connect", () => {
    console.log("✅ Stable Connection Established! ID:", socket.id);
});

socket.on("connect_error", (err) => {
    console.log("❌ Connection Error Detail:", err.message);
});

// ... rest of your loadSidebar() function ...

async function loadUsers() {
    const list = document.getElementById("contact-list");
    try {
        const response = await fetch("/api/users");
        const users = await response.json();
        
        if (users.length === 0) {
            list.innerHTML = "<p>No users found in database.</p>";
            return;
        }

        list.innerHTML = "";
        users.forEach(u => {
            const div = document.createElement("div");
            div.className = "contact-card";
            div.innerHTML = `<h3>${u.username}</h3>`;
            list.appendChild(div);
        });
        console.log("✅ Sidebar loaded successfully!");
    } catch (err) {
        console.log("❌ Sidebar Fetch Error:", err);
    }
}

// Ensure it only runs once
window.onload = loadUsers;