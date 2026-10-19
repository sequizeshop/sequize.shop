async function loginUser(event) {
  event.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const message = document.getElementById("message");

  message.textContent = "Logging in...";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      message.textContent = data.message || "Login failed.";
      return;
    }

    message.textContent = "Login successful!";

    window.location.href = data.redirect || "/index.html";
  } catch (error) {
    message.textContent = "Server se connect nahi ho paya.";
  }
}
