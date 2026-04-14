const authForm = document.getElementById('auth-form');

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    const response = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });

    const result = await response.json();
    if (result.success) {
        // Save user data locally
        localStorage.setItem('chatUser', JSON.stringify({ 
            email: result.email, 
            username: result.username 
        }));
        window.location.href = '/chat.html';
    } else {
        alert("Login failed! Check your credentials.");
    }
});