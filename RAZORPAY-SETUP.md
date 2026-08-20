# Razorpay setup

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_PASSWORD` to a strong private password for the admin panel.
3. Add the Razorpay Test Mode Key ID and Key Secret from the Razorpay Dashboard.
4. Start the site with `node server.js`.
5. Configure the webhook URL as `https://your-domain.com/api/razorpay/webhook` and use the same webhook secret in `.env`.
6. Test first, then replace the test keys with Live Mode keys after Razorpay approval.

The Key Secret stays server-side. The browser receives only the Key ID and the server-created Razorpay order ID. Payment signatures are verified server-side before an order is marked paid.
