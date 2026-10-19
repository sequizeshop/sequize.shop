<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>My Profile | Shoppy</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
    rel="stylesheet"
  >

  <script src="https://unpkg.com/@phosphor-icons/web"></script>

  <style>
    :root {
      --black: #111111;
      --white: #ffffff;
      --gray: #737373;
      --border: #e9e9e9;
      --light: #f6f6f6;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: "Inter", sans-serif;
      background: #f7f7f7;
      color: var(--black);
      min-height: 100vh;
    }

    button,
    a {
      font: inherit;
    }

    a {
      text-decoration: none;
      color: inherit;
    }

    button {
      cursor: pointer;
    }

    .navbar {
      height: 76px;
      background: #fff;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 7%;
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .brand img {
      width: 46px;
      height: 46px;
      object-fit: contain;
    }

    .nav-actions {
      display: flex;
      gap: 22px;
      align-items: center;
    }

    .nav-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 23px;
      color: #222;
    }

    .container {
      width: min(1120px, 92%);
      margin: 42px auto;
    }

    .page-heading {
      margin-bottom: 25px;
    }

    .page-heading h1 {
      font-size: 29px;
      font-weight: 800;
      letter-spacing: -1px;
    }

    .page-heading p {
      margin-top: 8px;
      color: var(--gray);
      font-size: 14px;
    }

    .profile-layout {
      display: grid;
      grid-template-columns: 330px 1fr;
      gap: 24px;
      align-items: start;
    }

    .card {
      background: var(--white);
      border: 1px solid var(--border);
      border-radius: 18px;
      overflow: hidden;
    }

    .profile-card {
      padding: 28px 22px;
      text-align: center;
    }

    .avatar {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      background: #111;
      color: #fff;
      display: flex;
      justify-content: center;
      align-items: center;
      margin: 0 auto 18px;
      font-size: 34px;
      font-weight: 800;
      letter-spacing: -1px;
      text-transform: uppercase;
      border: 5px solid #f0f0f0;
    }

    .profile-name {
      font-size: 21px;
      font-weight: 800;
      overflow-wrap: anywhere;
    }

    .profile-email {
      margin-top: 8px;
      color: var(--gray);
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .member-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 16px;
      padding: 8px 12px;
      border-radius: 30px;
      background: #f3f3f3;
      font-size: 11px;
      font-weight: 700;
    }

    .member-badge i {
      font-size: 15px;
    }

    .profile-divider {
      height: 1px;
      background: var(--border);
      margin: 24px 0;
    }

    .profile-shortcut {
      display: flex;
      align-items: center;
      gap: 13px;
      padding: 14px 4px;
      font-size: 13px;
      font-weight: 600;
      text-align: left;
    }

    .profile-shortcut i {
      font-size: 20px;
    }

    .profile-shortcut .arrow {
      margin-left: auto;
      color: #888;
    }

    .section-heading {
      font-size: 17px;
      font-weight: 800;
      padding: 23px 24px;
      border-bottom: 1px solid var(--border);
    }

    .section-subtitle {
      padding: 18px 24px 7px;
      color: #888;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .menu-item {
      display: flex;
      align-items: center;
      gap: 15px;
      padding: 17px 24px;
      min-height: 62px;
      border-bottom: 1px solid #f1f1f1;
      transition: background 0.2s;
      cursor: pointer;
    }

    .menu-item:last-child {
      border-bottom: none;
    }

    .menu-item:hover {
      background: #f8f8f8;
    }

    .menu-icon {
      width: 40px;
      height: 40px;
      flex-shrink: 0;
      border-radius: 12px;
      background: #f3f3f3;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 21px;
      color: #111;
    }

    .menu-content {
      flex: 1;
      min-width: 0;
    }

    .menu-title {
      font-size: 13px;
      font-weight: 700;
    }

    .menu-description {
      margin-top: 5px;
      font-size: 11px;
      color: var(--gray);
      line-height: 1.5;
    }

    .menu-arrow {
      font-size: 19px;
      color: #999;
      flex-shrink: 0;
    }

    .danger .menu-icon {
      background: #fff0f0;
      color: #d62828;
    }

    .danger .menu-title {
      color: #d62828;
    }

    .bottom-note {
      color: #999;
      text-align: center;
      font-size: 11px;
      padding: 25px 0 35px;
    }

    .status-message {
      padding: 35px;
      text-align: center;
      color: var(--gray);
      font-size: 13px;
    }

    .status-message button {
      display: block;
      margin: 15px auto 0;
      padding: 11px 20px;
      border: none;
      background: #111;
      color: #fff;
      border-radius: 8px;
    }

    @media (max-width: 760px) {
      .navbar {
        height: 65px;
        padding: 0 5%;
      }

      .brand img {
        width: 40px;
        height: 40px;
      }

      .nav-actions {
        gap: 18px;
      }

      .container {
        width: 92%;
        margin: 27px auto;
      }

      .page-heading h1 {
        font-size: 25px;
      }

      .profile-layout {
        grid-template-columns: 1fr;
        gap: 18px;
      }

      .profile-card {
        padding: 25px 20px;
      }

      .section-heading {
        padding: 21px 19px;
      }

      .section-subtitle {
        padding-left: 19px;
      }

      .menu-item {
        padding: 14px 17px;
        gap: 12px;
      }

      .menu-icon {
        width: 39px;
        height: 39px;
      }
    }
  </style>
</head>

<body>

  <header class="navbar">
    <a href="/index.html" class="brand" aria-label="Home">
      <img
        src="https://i.ibb.co/93qKCKxT/20261019-120246.png"
        alt="Shoppy logo"
      >
    </a>

    <div class="nav-actions">
      <a class="nav-icon" href="/index.html" aria-label="Home">
        <i class="ph ph-house"></i>
      </a>

      <a class="nav-icon" href="/cart.html" aria-label="Cart">
        <i class="ph ph-shopping-cart"></i>
      </a>

      <a class="nav-icon" href="/profile.html" aria-label="My profile">
        <i class="ph ph-user-circle"></i>
      </a>
    </div>
  </header>

  <main class="container">

    <div class="page-heading">
      <h1>My Account</h1>
      <p>Manage your profile, orders and preferences.</p>
    </div>

    <div id="loading" class="card status-message">
      Loading your profile...
    </div>

    <div id="profileLayout" class="profile-layout" hidden>

      <!-- LEFT: USER PROFILE -->
      <aside>

        <section class="card profile-card">

          <div class="avatar" id="avatar">U</div>

          <h2 class="profile-name" id="userName">User</h2>

          <p class="profile-email" id="userEmail"></p>

          <div class="member-badge">
            <i class="ph ph-check-circle"></i>
            SHOPPING MEMBER
          </div>

          <div class="profile-divider"></div>

          <a href="/orders.html" class="profile-shortcut">
            <i class="ph ph-package"></i>
            My Orders
            <i class="ph ph-caret-right arrow"></i>
          </a>

          <a href="/wishlist.html" class="profile-shortcut">
            <i class="ph ph-heart"></i>
            My Wishlist
            <i class="ph ph-caret-right arrow"></i>
          </a>

          <a href="/cart.html" class="profile-shortcut">
            <i class="ph ph-shopping-cart"></i>
            My Cart
            <i class="ph ph-caret-right arrow"></i>
          </a>

        </section>

      </aside>

      <!-- RIGHT: SHOPPING OPTIONS -->
      <section>

        <div class="card">

          <h3 class="section-heading">Your Shopping</h3>

          <div class="section-subtitle">Orders & Shopping</div>

          <a href="/orders.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-package"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">My Orders</div>
              <div class="menu-description">
                View orders, track shipments and check delivery status.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/buy-again.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-arrow-clockwise"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">Buy Again</div>
              <div class="menu-description">
                Quickly find products you purchased before.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/wishlist.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-heart"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">My Wishlist</div>
              <div class="menu-description">
                Products you saved for later.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/cart.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-shopping-cart"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">My Cart</div>
              <div class="menu-description">
                Review your cart and continue shopping.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/index.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-storefront"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">Continue Shopping</div>
              <div class="menu-description">
                Explore products and discover new arrivals.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <div class="section-subtitle">Account & Payments</div>

          <a href="/addresses.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-map-pin"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">Saved Addresses</div>
              <div class="menu-description">
                Manage your delivery addresses.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/payments.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-credit-card"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">My Payments</div>
              <div class="menu-description">
                View available payment options.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/coupons.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-ticket"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">Coupons & Offers</div>
              <div class="menu-description">
                Discover deals and available discounts.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/notifications.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-bell"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">Notifications</div>
              <div class="menu-description">
                Stay updated on orders and offers.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <div class="section-subtitle">Help & Settings</div>

          <a href="/support.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-headset"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">Help & Support</div>
              <div class="menu-description">
                Get help with orders and your account.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/privacy.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-shield-check"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">Privacy & Security</div>
              <div class="menu-description">
                Learn how your account information is protected.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <a href="/about.html" class="menu-item">
            <span class="menu-icon">
              <i class="ph ph-info"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">About Us</div>
              <div class="menu-description">
                Learn more about our shopping store.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </a>

          <button id="logoutButton" class="menu-item danger"
            style="width:100%;background:white;border-top:1px solid #eee;border-left:0;border-right:0;border-bottom:0;text-align:left">

            <span class="menu-icon">
              <i class="ph ph-sign-out"></i>
            </span>

            <span class="menu-content">
              <div class="menu-title">Logout</div>
              <div class="menu-description">
                Sign out of your account securely.
              </div>
            </span>

            <i class="ph ph-caret-right menu-arrow"></i>
          </button>

        </div>

      </section>

    </div>

    <div class="bottom-note">
      Shoppy · Your shopping, all in one place.
    </div>

  </main>

  <script>
    const loading = document.getElementById("loading");
    const profileLayout = document.getElementById("profileLayout");

    function createInitials(name) {
      const words = (name || "").trim().split(/\s+/).filter(Boolean);

      if (!words.length) {
        return "U";
      }

      // One-word names: use up to two letters.
      // Multiple-word names: use the first letter of each of the first two words.
      if (words.length === 1) {
        return Array.from(words[0]).slice(0, 2).join("").toUpperCase();
      }

      return (
        Array.from(words[0])[0] +
        Array.from(words[1])[0]
      ).toUpperCase();
    }

    async function loadProfile() {
      try {
        const response = await fetch("/api/profile", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store"
        });

        const data = await response.json();

        if (response.status === 401) {
          window.location.replace("/login.html");
          return;
        }

        if (!response.ok || !data.success || !data.user) {
          throw new Error(data.message || "Unable to load profile");
        }

        const user = data.user;

        document.getElementById("userName").textContent =
          user.name || "User";

        document.getElementById("userEmail").textContent =
          user.email || "";

        document.getElementById("avatar").textContent =
          createInitials(user.name);

        loading.hidden = true;
        profileLayout.hidden = false;

      } catch (error) {
        loading.textContent = "Unable to load your profile.";

        const button = document.createElement("button");
        button.textContent = "Try Again";
        button.onclick = loadProfile;

        loading.appendChild(button);
      }
    }

    document.getElementById("logoutButton").addEventListener(
      "click",
      async () => {
        const button = document.getElementById("logoutButton");

        button.disabled = true;

        try {
          const response = await fetch("/api/logout", {
            method: "POST",
            credentials: "same-origin"
          });

          const data = await response.json();

          if (response.ok && data.success) {
            window.location.replace(
              data.redirect || "/login.html"
            );
          } else {
            button.disabled = false;
            alert(data.message || "Unable to log out.");
          }
        } catch {
          button.disabled = false;
          alert("Server se connect nahi ho paya.");
        }
      }
    );

    loadProfile();
  </script>

</body>
</html>
