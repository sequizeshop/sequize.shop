<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shopy — Create Account</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
      font-family: Arial, sans-serif;
      background: linear-gradient(135deg, #eef2ff, #fdf2f8);
      color: #1f2937;
    }

    .card {
      width: 100%;
      max-width: 420px;
      padding: 30px;
      background: white;
      border-radius: 18px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.10);
    }

    .logo {
      text-align: center;
      color: #6d28d9;
      font-size: 34px;
      font-weight: bold;
      margin-bottom: 8px;
    }

    h1 {
      text-align: center;
      font-size: 24px;
      margin: 10px 0;
    }

    .subtitle {
      text-align: center;
      color: #6b7280;
      margin-bottom: 25px;
      font-size: 14px;
    }

    label {
      display: block;
      margin: 15px 0 7px;
      font-size: 14px;
      font-weight: bold;
    }

    input {
      width: 100%;
      padding: 13px;
      border: 1px solid #d1d5db;
      border-radius: 9px;
      font-size: 16px;
    }

    input:focus {
      outline: 2px solid #c4b5fd;
      border-color: #7c3aed;
    }

    button {
      width: 100%;
      margin-top: 22px;
      padding: 14px;
      border: none;
      border-radius: 9px;
      background: #6d28d9;
      color: white;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
    }

    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    #message {
      margin-top: 16px;
      text-align: center;
      font-size: 14px;
      overflow-wrap: anywhere;
    }

    .login {
      text-align: center;
      margin-top: 20px;
      font-size: 14px;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">Shopy</div>
    <h1>Create Account</h1>
    <p class="subtitle">अपना नया अकाउंट बनाएँ</p>

    <form id="signupForm">
      <label for="name">पूरा नाम</label>
      <input
        id="name"
        name="name"
        type="text"
        placeholder="अपना नाम लिखें"
        minlength="2"
        maxlength="80"
        autocomplete="name"
        required
      >

      <label for="email">ईमेल</label>
      <input
        id="email"
        name="email"
        type="email"
        placeholder="you@example.com"
        autocomplete="email"
        required
      >

      <label for="password">पासवर्ड</label>
      <input
        id="password"
        name="password"
        type="password"
        placeholder="कम से कम 8 अक्षर"
        minlength="8"
        maxlength="72"
        autocomplete="new-password"
        required
      >

      <button id="submitButton" type="submit">
        Create Account
      </button>

      <p id="message" role="status" aria-live="polite"></p>
    </form>

    <div class="login">
      पहले से अकाउंट है? Login सुविधा जल्द आएगी।
    </div>
  </main>

  <script>
    const form = document.getElementById("signupForm");
    const button = document.getElementById("submitButton");
    const message = document.getElementById("message");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      message.textContent = "";
      button.disabled = true;
      button.textContent = "Please wait...";

      const formData = new FormData(form);

      const payload = {
        name: formData.get("name").trim(),
        email: formData.get("email").trim(),
        password: formData.get("password")
      };

      try {
        const response = await fetch("/api/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (response.ok && result.success) {
          message.style.color = "green";
          message.textContent = "अकाउंट सफलतापूर्वक बन गया! ✅";
          form.reset();
        } else {
          message.style.color = "#dc2626";
          message.textContent =
            result.message || "अकाउंट नहीं बन पाया। दोबारा कोशिश करें।";
        }
      } catch (error) {
        message.style.color = "#dc2626";
        message.textContent =
          "नेटवर्क समस्या है। इंटरनेट और वेबसाइट जाँचें।";
      } finally {
        button.disabled = false;
        button.textContent = "Create Account";
      }
    });
  </script>
</body>
</html>
