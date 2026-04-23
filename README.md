# TeleMarketerPro Bot

A professional Telegram automation bot for broadcasting and auto-reply management.

## Features
- 📈 Real-time Dashboard
- ➕ Multi-account support
- 🚀 Fast Broadcasting with stats
- 🤖 Auto-reply management
- 👑 Admin Panel for global control
- 💾 MongoDB persistence for 24/7 live status

## Deployment (Railway & Render)

### Railway Setup:
1. Connect your GitHub repo to Railway.
2. Add a **MongoDB** service in Railway.
3. Go to **Variables** in your Railway service and add:
   - `BOT_TOKEN`: Your main bot token.
   - `LOGGER_BOT_TOKEN`: Your logger bot token.
   - `ADMIN_ID`: Your Telegram ID.
   - `TELEGRAM_API_ID`: Your API ID from my.telegram.org.
   - `TELEGRAM_API_HASH`: Your API HASH from my.telegram.org.
   - `MONGODB_URI`: Railway will automatically provide this if you link the MongoDB service.

### Render Setup:
1. Create a new **Web Service** on Render.
2. Connect your GitHub repository.
3. Set the following environment variables in Render:
   - `BOT_TOKEN`: Your main bot token.
   - `LOGGER_BOT_TOKEN`: Your logger bot token.
   - `ADMIN_ID`: Your Telegram user ID.
   - `TELEGRAM_API_ID`: Your Telegram API ID.
   - `TELEGRAM_API_HASH`: Your Telegram API Hash.
   - `PORT`: 3000 (Render will automatically provide this, but you can set it).
4. Render will automatically detect the `package.json` and use `npm start` to run the bot.
5. Ensure the **Build Command** is `npm install` and the **Start Command** is `npm start`.

## Local Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file based on `.env.example`.
3. Start the bot:
   ```bash
   npm run dev
   ```
