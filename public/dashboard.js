// Ensure DOM is fully loaded before running script
window.onload = () => {

    // Get username from URL
    const params = new URLSearchParams(window.location.search);
    const currentUser = params.get("username");

    // Redirect if no username found
    if (!currentUser) {
        alert("No username found. Redirecting...");
        window.location.href = `/chat?username=${currentUser}&room=${room}`;
        return;
    }

    // Set welcome text
    document.getElementById("welcome").innerText = "Welcome back,";
    document.getElementById("current-username").innerText = currentUser;

    // Load users (contacts)
    loadUsers(currentUser);
};

// Load all users from backend
async function loadUsers(currentUser) {
    try {
        const res = await fetch("/api/users");
        if (!res.ok) throw new Error("Failed to fetch users");

        const users = await res.json();
        const container = document.getElementById("contact-list");
        container.innerHTML = "";

        if (!users || users.length === 0) {
            container.innerHTML = "<p style='padding:10px; opacity:0.7;'>No users found</p>";
            return;
        }

        users.forEach(user => {
            // Don't show yourself in the list
            if (user.username === currentUser) return;

            const div = document.createElement("div");
            div.innerText = user.username;
            div.classList.add("contact-item");
            
            div.onclick = () => {
                // Room name is always 'alphabetical-alphabetical' so both users find the same room
                const room = [currentUser, user.username].sort().join("-");
                window.location.href = `/chat?username=${currentUser}&room=${room}`;
            };

            container.appendChild(div);
        });
    } catch (err) {
        console.error("Error:", err);
        document.getElementById("contact-list").innerHTML = "<p style='color:red;'>Error loading contacts</p>";
    }
}

// Logout function
function logout() {
    window.location.href = "/";
}

//functtion that hidsor shows the contact list based on what user types in the search box
function filterUsers() {
    // 1. Get the search text and convert to lowercase
    const input = document.getElementById('userSearch');
    const filter = input.value.toLowerCase();

    // 2. Get the contact list container
    const container = document.getElementById('contact-list');

    // 3. Get all the contact divs (they have the 'contact-item' class)
    const contacts = container.getElementsByClassName('contact-item');

    // 4. Loop through all contacts and hide those that don't match
    for (let i = 0; i < contacts.length; i++) {
        const username = contacts[i].innerText.toLowerCase();

        if (username.includes(filter)) {
            contacts[i].style.display = ""; // Show
        } else {
            contacts[i].style.display = "none"; // Hide
        }
    }
}

function openModal() {
    document.getElementById('addContactModal').style.display = 'flex';
}

function closeModal() {
    document.getElementById('addContactModal').style.display = 'none';
    document.getElementById('searchError').style.display = 'none';
    // Clear the text box so it's fresh next time
    document.getElementById('newContactUsername').value = "";
}

async function searchAndAddContact() {
    const targetInput = document.getElementById('newContactUsername');
    const targetUsername = targetInput.value.trim();
    const errorMsg = document.getElementById('searchError');
    const currentUser = new URLSearchParams(window.location.search).get('username');

    if (!targetUsername) return;

    // Prevent adding self
    if (targetUsername.toLowerCase() === currentUser.toLowerCase()) {
        errorMsg.innerText = "You can't add yourself!";
        errorMsg.style.display = 'block';
        return;
    }

    const response = await fetch('/api/users');
    const users = await response.json();

    // Fix: Case-insensitive search
    const foundUser = users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());

    if (foundUser) {
        const room = [currentUser, foundUser.username].sort().join("-");
        window.location.href = `/chat?username=${currentUser}&room=${room}`;
    } else {
        errorMsg.innerText = "User not found!";
        errorMsg.style.display = 'block';
    }
}

/** Allow pressing Enter in the search box to trigger the search */
document.getElementById('newContactUsername').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        searchAndAddContact();
    }
});