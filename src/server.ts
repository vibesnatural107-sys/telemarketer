import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { getDB, syncDB } from './lib/supabase.js';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

let mainBotStatus = 'offline';
let loggerBotStatus = 'offline';
let mainBotError = '';
let loggerBotError = '';

app.get('/api/health', (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  res.json({ 
    status: 'ok',
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    bots: {
      main: { status: mainBotStatus, error: mainBotError, username: botUsername },
      logger: { status: loggerBotStatus, error: loggerBotError }
    },
    env: {
      node_env: process.env.NODE_ENV,
      port: PORT
    }
  });
});

// Self-ping log to keep internal event loop active
setInterval(() => {
  const mainErr = mainBotStatus === 'error' ? ` (${mainBotError})` : '';
  const loggerErr = loggerBotStatus === 'error' ? ` (${loggerBotError})` : '';
  console.log(`[Keep-Alive] Bot is active. Uptime: ${Math.floor(process.uptime())}s | Main: ${mainBotStatus}${mainErr} | Logger: ${loggerBotStatus}${loggerErr}`);
}, 5 * 60 * 1000); // Every 5 minutes

let bot: Telegraf | null = null;
let loggerBot: Telegraf | null = null;
let botUsername = '';

const cleanToken = (token: string | undefined) => {
  if (!token) return undefined;
  // Remove all whitespace, including newlines and tabs
  let t = token.replace(/\s/g, '');
  // Remove wrapping quotes if present
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.substring(1, t.length - 1);
  }
  // Remove any non-printable characters
  t = t.replace(/[^\x20-\x7E]/g, '');
  // Final trim just in case
  return t.trim();
};

const BOT_TOKEN = cleanToken(process.env.BOT_TOKEN || '8682961726:AAGO8B5WiXpiC8c9TERQzyhTcD4SUi_lTIo');
const LOGGER_BOT_TOKEN = cleanToken(process.env.LOGGER_BOT_TOKEN || '8496816756:AAGLrbl4f_u7C8h4cyrAhPP6lp-Jxs-NTUo');

const maskToken = (token: string | undefined) => {
  if (!token) return 'MISSING';
  if (token.length < 10) return 'INVALID FORMAT (TOO SHORT)';
  if (!token.includes(':')) return 'INVALID FORMAT (MISSING COLON)';
  
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
};

console.log(`🔍 Main Bot Token: ${maskToken(BOT_TOKEN)}`);
console.log(`🔍 Logger Bot Token: ${maskToken(LOGGER_BOT_TOKEN)}`);

if (!BOT_TOKEN) {
  console.error('❌ CRITICAL: BOT_TOKEN is missing or empty in environment variables!');
  mainBotStatus = 'error';
  mainBotError = 'BOT_TOKEN is missing or empty in Settings -> Secrets';
}
if (!LOGGER_BOT_TOKEN) {
  console.error('❌ CRITICAL: LOGGER_BOT_TOKEN is missing or empty in environment variables!');
  loggerBotStatus = 'error';
  loggerBotError = 'LOGGER_BOT_TOKEN is missing or empty in Settings -> Secrets';
}

const ADMIN_ID = parseInt(process.env.ADMIN_ID || '8020575078');
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '32275179');
const API_HASH = process.env.TELEGRAM_API_HASH || 'e645eb69ea4a3889e2d3c1e63142a99d';

if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
  console.warn('⚠️ TELEGRAM_API_ID or TELEGRAM_API_HASH is using default values. This might cause login issues.');
}
const SUPPORT_OWNER = process.env.SUPPORT_OWNER_USERNAME || '@Its_Me_Shiva3';

// Simple JSON database helper
const DB_FILE = path.join(process.cwd(), 'database.json');
let db: any = { 
  users: {}, 
  accounts: [], 
  templates: [], 
  loggerUsers: [], 
  bannedUsers: [], 
  admins: [], 
  globalStats: { totalMessagesSent: 0, totalGroupsMessaged: 0 } 
};

const loadDB = async () => {
  try {
    const cloudData = await getDB();
    if (cloudData) {
      db = { ...db, ...cloudData };
      console.log('✅ DB loaded from Supabase.');
    } else if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      if (content && content.trim()) {
        const data = JSON.parse(content);
        db = { ...db, ...data };
        await syncDB(db); // Migration to Supabase
        console.log('✅ DB migrated from local to Supabase.');
      }
    }
    return db;
  } catch (e) {
    console.error('❌ Error loading DB:', e);
  }
  return db;
};

const saveDB = async (data?: any) => {
  if (data) {
    db = data;
  }
  try {
    await syncDB(db);
    // Also keep local fallback for extreme cases
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log(`✅ DB synced to Supabase. Accounts: ${db.accounts.length}`);
  } catch (e) {
    console.error('❌ Error saving DB:', e);
  }
};

// Start bot
const startApp = async () => {
  console.log('🔄 Application startup initiated...');

  try {
    // 1. Vite middleware / Static Assets FIRST
    if (process.env.NODE_ENV !== 'production') {
      try {
        console.log('🔄 Initializing Vite middleware...');
        const vite = await createViteServer({
          server: { middlewareMode: true },
          appType: 'spa',
        });
        app.use(vite.middlewares);
        console.log('✅ Vite middleware ready');
      } catch (err) {
        console.error('❌ Failed to initialize Vite:', err);
      }
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }

    // 2. Bind to port AFTER middleware is added
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server is listening on port ${PORT}`);
    });

    // 3. Background initialization (Post-listening)
    (async () => {
      try {
        console.log('🔄 Syncing with Supabase...');
        await loadDB().catch(err => console.error('Failed to load DB:', err));
        console.log(`✅ Supabase Sync complete. Accounts: ${db.accounts.length}`);

        // Launch bots
        const launchMainBot = async () => {
          try {
            if (!BOT_TOKEN || BOT_TOKEN.trim() === '') {
              mainBotStatus = 'error';
              mainBotError = 'BOT_TOKEN missing in Secrets';
              return false;
            }
            bot = new Telegraf(BOT_TOKEN);
            const me = await bot.telegram.getMe();
            botUsername = me.username;
            mainBotStatus = 'online';
            await bot.telegram.deleteWebhook();
            bot.launch().catch(err => {
              mainBotStatus = 'error';
              console.error('Main Bot launch error:', err);
            });
            if (bot) setupBotHandlers(bot);
            console.log(`🤖 Main Bot: @${botUsername}`);
            return true;
          } catch (err: any) {
            mainBotStatus = 'error';
            mainBotError = err.message || String(err);
            console.error('❌ Main Bot launch failed:', mainBotError);
            return false;
          }
        };

        const launchLoggerBot = async () => {
          try {
            if (!LOGGER_BOT_TOKEN || LOGGER_BOT_TOKEN.trim() === '') {
               loggerBotStatus = 'error';
               return false;
            }
            loggerBot = new Telegraf(LOGGER_BOT_TOKEN);
            await loggerBot.telegram.getMe();
            loggerBotStatus = 'online';
            await loggerBot.telegram.deleteWebhook();
            loggerBot.launch().catch(err => {
              loggerBotStatus = 'error';
              console.error('Logger Bot launch error:', err);
            });
            if (loggerBot) setupLoggerHandlers(loggerBot);
            console.log('🤖 Logger Bot: ONLINE');
            return true;
          } catch (err: any) {
            loggerBotStatus = 'error';
            return false;
          }
        };

        await launchMainBot();
        await launchLoggerBot();

        // Worker threads
        initClients().catch(err => console.error('❌ Worker init error:', err));
        
        // Periodic branding
        setInterval(async () => {
          for (const acc of db.accounts) {
            try {
              let client = activeClients[acc.phone];
              let localClient = false;
              if (!client || !client.connected) {
                client = new TelegramClient(new StringSession(acc.session), API_ID, API_HASH, {
                  connectionRetries: 3,
                  requestRetries: 3,
                  timeout: 30000,
                  useWSS: true,
                  deviceModel: 'Samsung Galaxy S23 Ultra',
                  systemVersion: 'Android 13.0',
                  appVersion: '3.0.0',
                });
                await client.connect();
                localClient = true;
              }
              await enforceProfile(client, acc.userId, acc.phone);
              if (localClient) await client.disconnect();
            } catch (e) {}
            await new Promise(res => setTimeout(res, 5000));
          }
        }, 15 * 60 * 1000);

      } catch (err) {
        console.error('❌ Background init crashed:', err);
      }
    })();

  } catch (err) {
    console.error('❌ Emergency startup crash:', err);
  }
};

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason);
});

const CHANNELS = ['@TeleMarketerProNews', '@TeleMarketerProChatss', '@smartkeysdailyofficial'];

// Improved state management for clean UI
const userStates: Record<number, { 
  step: string; 
  data?: any;
  client?: TelegramClient;
  resolveOTP?: (code: string) => void;
  resolve2FA?: (password: string) => void;
  rejectAuth?: (err: any) => void;
  lastBotMsgId?: number;
  lastAccountsPage?: number;
  accountSearchQuery?: string;
}> = {};

// Helper to send message and delete previous bot message for clean UI
const smartReply = async (ctx: any, text: string, extra?: any) => {
  const userId = ctx.from?.id;
  if (userId) {
    const state = userStates[userId];
    if (state?.lastBotMsgId) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, state.lastBotMsgId).catch(() => {}); } catch (e) {}
    }
  }

  try {
    const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
    if (userId) {
      if (!userStates[userId]) userStates[userId] = { step: 'none', data: {} };
      userStates[userId].lastBotMsgId = sent.message_id;
    }
    return sent;
  } catch (err: any) {
    const errMsg = err.message || String(err);
    if (errMsg.includes('bot was blocked by the user')) {
      console.warn(`[SmartReply] User ${userId} has blocked the bot. Skipping message.`);
    } else {
      console.error('SmartReply Error:', err);
    }
  }
};

// Helper to retry Telegram operations
const withRetry = async <T>(fn: () => Promise<T>, label: string, maxRetries: number = 3): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const msg = (err.message || String(err)).toUpperCase();
      if (msg.includes('TIMEOUT') || msg.includes('UNSUCCESSFUL') || msg.includes('ECONNRESET') || msg.includes('DISCONNECTED')) {
        const delay = (i + 1) * 2000;
        console.log(`[Retry] ${label} failed (attempt ${i + 1}/${maxRetries}): ${err.message}. Retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
};

const enforceProfile = async (client: TelegramClient, userId: number, phone: string) => {
  if (isAdmin(userId)) return false;
  if (db.brandingExempt && db.brandingExempt.includes(userId)) return false;
  if (!client.connected) return false;
  try {
    if (!bot) return false;
    if (!botUsername) {
      try {
        const botMe = await bot.telegram.getMe();
        botUsername = botMe.username;
      } catch (e) {
        console.warn('Could not fetch bot username for branding fallback');
        return false;
      }
    }
    const me = await client.getMe() as any;
    const expectedNameSuffix = `via @${botUsername}`;
    const expectedBio = `Free Automation Manage By @${botUsername}`;
    
    let needsUpdate = false;
    let newFirstName = me.firstName || '';
    let newBio = expectedBio;

    console.log(`[Branding] Checking ${phone} (User: ${userId})...`);

    // Check Name
    const maxNameLen = 64;
    const currentFirstName = me.firstName || '';
    if (!currentFirstName.includes(expectedNameSuffix)) {
      let baseName = currentFirstName;
      // Remove any existing "via @" suffix if it's different
      if (baseName.includes('via @')) {
        baseName = baseName.split('via @')[0].trim();
      }
      
      if (baseName.length + expectedNameSuffix.length + 1 > maxNameLen) {
        baseName = baseName.substring(0, maxNameLen - expectedNameSuffix.length - 1).trim();
      }
      newFirstName = `${baseName} ${expectedNameSuffix}`.trim();
      needsUpdate = true;
    }

    // Check Bio
    const fullUser = await client.invoke(new Api.users.GetFullUser({ id: me.id })) as any;
    const currentBio = fullUser.fullUser.about || '';
    if (currentBio !== expectedBio) {
      needsUpdate = true;
    }

    if (needsUpdate) {
      console.log(`[Branding] Enforcing branding for ${phone}...`);
      if (!db.users[userId]) db.users[userId] = { violations: 0 };
      db.users[userId].violations = (db.users[userId].violations || 0) + 1;
      
      if (db.users[userId].violations >= 3) {
        if (!db.bannedUsers) db.bannedUsers = [];
        if (!db.bannedUsers.includes(userId)) {
          db.bannedUsers.push(userId);
          await saveDB();
          logToAdmin(`🚫 *User Auto-Banned:* \`${userId}\` (Reason: Profile Hint: Tampering)`);
          try {
            if (bot) await bot.telegram.sendMessage(userId, '❌ *Access Denied!*\n\nYou have been banned for repeatedly removing the bot\'s profile branding.', { parse_mode: 'Markdown' });
          } catch (e) {}
        }
        return true;
      } else {
        // Send Warning
        try {
          if (bot) await bot.telegram.sendMessage(userId, `⚠️ *Warning!* (${db.users[userId].violations}/3)\n\nPlease do not remove the bot's branding from your profile. Repeated removal will lead to an automatic ban.`, { parse_mode: 'Markdown' });
        } catch (e) {}
        await saveDB();
      }

      // Update Name
      try {
        await client.invoke(new Api.account.UpdateProfile({
          firstName: newFirstName,
        }));
      } catch (e) {
        console.error(`[Branding] Failed to update name for ${phone}:`, e);
      }
      
      // Update Bio
      try {
        await client.invoke(new Api.account.UpdateProfile({
          about: newBio,
        }));
      } catch (e) {
        console.error(`[Branding] Failed to update bio for ${phone}:`, e);
      }
      
      await saveDB();
      
      try {
        if (bot) await bot.telegram.sendMessage(userId, `⚠️ *Warning:* Please do not remove the bot's branding from your profile. It has been re-applied. (Violation ${db.users[userId].violations}/3)`, { parse_mode: 'Markdown' });
      } catch (e) {}
      
      console.log(`Profile enforced for ${phone} (User: ${userId})`);
      return true;
    }
  } catch (e) {
    console.error(`Error enforcing profile for ${phone}:`, e);
  }
  return false;
};

// Helper to send verification code
const sendVerificationCode = async (ctx: any, userId: number, phone: string) => {
  const connMsg = await smartReply(ctx, '🌐 *Connecting to Telegram Servers...*\n\n_This might take up to 60 seconds..._');
  try {
    const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 5, 
      requestRetries: 5,
      timeout: 30000,
      useWSS: true,
      deviceModel: 'Samsung Galaxy S23 Ultra',
      systemVersion: 'Android 13.0',
      appVersion: '3.0.0',
    });
    
    await client.connect();

    userStates[userId] = { 
      ...userStates[userId],
      step: 'awaiting_code', 
      data: { ...userStates[userId]?.data, phone },
      client 
    };

    client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        const sentMsg = await smartReply(ctx, `📩 *Step 2: Verification Code*\n\nA code has been sent to \`${phone}\` via Telegram.\n\n*Please enter the code below:*`, Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Cancel', 'back_to_main')]
        ]));
        
        return new Promise((resolve, reject) => {
          userStates[userId].resolveOTP = resolve;
          userStates[userId].rejectAuth = (err: any) => reject(err);
        });
      },
      password: async () => {
        await smartReply(ctx, '🔐 *Two-Factor Authentication (2FA) Detected*\n\nYour account has 2FA enabled. Please enter your 2FA password to continue:', Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Cancel', 'back_to_main')]
        ]));
        userStates[userId].step = 'awaiting_2fa';

        return new Promise((resolve, reject) => {
          userStates[userId].resolve2FA = resolve;
          userStates[userId].rejectAuth = (err: any) => reject(err);
        });
      },
      onError: async (err: any): Promise<boolean> => {
        console.error('Auth Error callback:', err);
        const errMsg = (err.message || String(err)).toUpperCase();
        let userFriendlyMsg = `❌ *Auth Error:* ${err.message || err}`;
        
        if (errMsg.includes('FLOOD_WAIT')) {
          userFriendlyMsg = '⚠️ *Telegram Limit:* Too many login attempts. Please wait 24 hours and try again.';
        } else if (errMsg.includes('REQUEST_WAS_UNSUCCESSFUL')) {
          userFriendlyMsg = '⚠️ *Network Error:* Telegram API request failed. This often happens on VPS. Retrying...';
        } else if (errMsg.includes('PHONE_NUMBER_INVALID')) {
          userFriendlyMsg = '❌ *Invalid Number:* Please check the phone number and country code.';
        } else if (errMsg.includes('PHONE_CODE_EXPIRED')) {
          userFriendlyMsg = '❌ *Code Expired:* The verification code has expired. Please try again from Step 1.';
        } else if (errMsg.includes('PHONE_CODE_INVALID')) {
          userFriendlyMsg = '❌ *Invalid Code:* The code you entered is incorrect. Please try again.';
        } else if (errMsg.includes('DISCONNECTED')) {
          userFriendlyMsg = '❌ *Connection Lost:* The connection was lost. Please check your internet and try again.';
        } else if (errMsg.includes('TIMEOUT')) {
          userFriendlyMsg = '❌ *Timeout:* Telegram servers are taking too long to respond. Please try again later.';
        } else if (errMsg.includes('SESSION_PASSWORD_NEEDED')) {
           return true;
        }

        await smartReply(ctx, userFriendlyMsg);
        await client.disconnect().catch(() => {});
        if (userStates[userId]) {
          delete userStates[userId].client;
          userStates[userId].step = 'none';
        }
        return true;
      }
    }).then(async () => {
      // Success
      const sessionString = client.session.save() as unknown as string;
      
      const existingIndex = db.accounts.findIndex((a: any) => a.phone === phone && a.userId === userId);
      if (existingIndex !== -1) {
        db.accounts[existingIndex].session = sessionString;
        db.accounts[existingIndex].addedAt = new Date().toISOString();
      } else {
        db.accounts.push({
          userId,
          phone,
          session: sessionString,
          addedAt: new Date().toISOString(),
          autoReply: false
        });
      }
      await saveDB();
      
      const procMsg = await smartReply(ctx, '⏳ *Processing Account...*\n\nApplying professional branding and security checks. Please wait a few seconds...');
      
      try {
        await enforceProfile(client, userId, phone);
      } catch (e) {
        console.error('Initial enforceProfile error:', e);
      }
      
      await client.disconnect().catch(() => {});
      userStates[userId].step = 'none';
      delete userStates[userId].client;
      
      await smartReply(ctx, `✅ *Account Successfully Added!*\n\nAccount \`${phone}\` is now connected and professional branding has been applied.`, getMainMenu(userId));
      logToAdmin(`📱 *New Account Added:* \`${phone}\` by User \`${userId}\``);
    }).catch(async (err: any) => {
      console.error('Auth Promise Catch:', err);
      if (userStates[userId]?.client) {
        await smartReply(ctx, `❌ *Connection Failed:* ${err.message || 'Unknown error'}`);
        await client.disconnect().catch(() => {});
        delete userStates[userId].client;
        userStates[userId].step = 'none';
      }
    });

  } catch (error: any) {
    console.error('Error starting auth:', error);
    await smartReply(ctx, `❌ *Connection Error:* ${error.message}\n\nCould not reach Telegram servers.`);
    userStates[userId].step = 'none';
  }
};



// Client Manager to handle multiple accounts
const activeClients: Record<string, TelegramClient> = {};

const startAutoReply = async (account: any) => {
  if (activeClients[account.phone]) return;

  try {
    const client = new TelegramClient(new StringSession(account.session), API_ID, API_HASH, {
      connectionRetries: 5,
      requestRetries: 5,
      timeout: 30000, 
      useWSS: true,
      deviceModel: 'Samsung Galaxy S23 Ultra',
      systemVersion: 'Android 13.0',
      appVersion: '3.0.0',
    });
    
    await withRetry(() => client.connect(), `AutoReply Connect for ${account.phone}`);
    activeClients[account.phone] = client;
    
    // Enforce branding when auto-reply starts
    await enforceProfile(client, account.userId, account.phone);
    
    client.addEventHandler(async (event: any) => {
      // Simple auto-reply logic
      if (event.message && event.message.isPrivate && !event.message.out) {
        try {
          const sender = await withRetry(() => event.message.getSender(), `GetSender for ${account.phone}`) as any;
          
          // Check if this is a new chat (no history)
          const history = await withRetry(() => client.getMessages(event.message.peerId, { limit: 2 }), `GetHistory for ${account.phone}`);
          if (history.length > 1) {
            console.log(`[AutoReply] Skipping ${sender?.username || sender?.id} on ${account.phone}: Chat history exists (${history.length} messages).`);
            return;
          }

          // Show typing status
          try {
            await client.invoke(new Api.messages.SetTyping({
              peer: event.message.peerId,
              action: new Api.SendMessageTypingAction()
            }));
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (e) {}

          const user = db.users[account.userId] || {};
          const customMsg = user.autoReplyMessage || "Hello! I am currently away. This is an automated response from TeleMarketerPro Bot. 🚀";

          console.log(`Auto-replying to ${sender?.username || sender?.id} from ${account.phone}`);
          
          // You can customize the auto-reply message here
          await withRetry(() => client.sendMessage(event.message.peerId, {
            message: customMsg,
          }), `AutoReply SendMessage for ${account.phone}`);
          logToAdmin(`🤖 *Auto-Reply Sent:* From \`${account.phone}\` to User \`${sender?.username || sender?.id}\``);
        } catch (err) {
          console.error(`Auto-reply error for ${account.phone}:`, err);
        }
      }
    }, new NewMessage({}));
    
    console.log(`Auto-reply started for ${account.phone}`);
  } catch (e) {
    console.error(`Failed to start auto-reply for ${account.phone}:`, e);
  }
};

const stopAutoReply = async (phone: string) => {
  if (activeClients[phone]) {
    try {
      await activeClients[phone].disconnect();
      delete activeClients[phone];
      console.log(`Auto-reply stopped for ${phone}`);
    } catch (e) {
      console.error(`Error stopping auto-reply for ${phone}:`, e);
    }
  }
};

// Pagination helper for accounts
const ACCOUNTS_PER_PAGE = 8;
const renderAccountList = async (ctx: any, userId: number, page: number = 0) => {
  const searchQuery = userStates[userId]?.accountSearchQuery?.toLowerCase();
  
  let userAccounts = db.accounts.filter((acc: any) => acc.userId === userId);
  
  if (searchQuery) {
    userAccounts = userAccounts.filter((acc: any) => 
      acc.phone.toLowerCase().includes(searchQuery) || 
      (acc.name && acc.name.toLowerCase().includes(searchQuery))
    );
  }

  const total = userAccounts.length;
  const start = page * ACCOUNTS_PER_PAGE;
  const end = start + ACCOUNTS_PER_PAGE;
  const pageAccounts = userAccounts.slice(start, end);
  const totalPages = Math.ceil(total / ACCOUNTS_PER_PAGE);

  let msg = `📊 *Your Accounts (${total})*\n\n`;
  if (searchQuery) {
    msg += `🔍 _Filtered by: "${searchQuery}"_\n\n`;
  }

  if (total === 0) {
    msg += searchQuery ? 'No accounts match your search.' : 'You have 0 accounts added.';
    const buttons = [];
    if (searchQuery) {
      buttons.push([Markup.button.callback('🧹 Clear Search', 'clear_search')]);
    }
    buttons.push([Markup.button.callback('➕ Add Account', 'add_account')]);
    buttons.push([Markup.button.callback('🔙 Back', 'back_to_main')]);
    return smartReply(ctx, msg, Markup.inlineKeyboard(buttons));
  }

  msg += `Select an account to manage (Page ${page + 1}/${totalPages || 1}):\n\n🟢 = Connected\n⚪️ = Session Valid (Stored)\n🔴 = Expired/Broken`;
  
  const buttons = pageAccounts.map((acc: any) => {
    // Determine status
    let statusIcon = '⚪️';
    if (activeClients[acc.phone]?.connected) {
      statusIcon = '🟢';
    } else if (acc.status === 'expired') {
      statusIcon = '🔴';
    }
    
    return [Markup.button.callback(`${statusIcon} ${acc.phone}`, `manage_acc_${acc.phone}`)];
  });

  // Pagination row
  const navRow = [];
  if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `my_accounts_page_${page - 1}`));
  if (end < total) navRow.push(Markup.button.callback('Next ➡️', `my_accounts_page_${page + 1}`));
  if (navRow.length > 0) buttons.push(navRow);

  // Search and Action row
  buttons.push([
    Markup.button.callback(searchQuery ? '🧹 Clear Search' : '🔍 Search', searchQuery ? 'clear_search' : 'search_accounts'),
    Markup.button.callback('➕ Add Account', 'add_account')
  ]);
  
  buttons.push([Markup.button.callback('🔙 Back to Main', 'back_to_main')]);

  if (userStates[userId]) userStates[userId].lastAccountsPage = page;
  
  return smartReply(ctx, msg, Markup.inlineKeyboard(buttons));
};

// Initialize active clients on startup
const initClients = async () => {
  if (!API_ID || !API_HASH) {
    console.warn('API_ID or API_HASH missing, skipping client initialization');
    return;
  }
  await loadDB();
  
  const accountsToStart = db.accounts.filter((acc: any) => acc.autoReply);
  console.log(`Initializing ${accountsToStart.length} auto-reply accounts (Total: ${db.accounts.length})...`);
  
  for (const acc of accountsToStart) {
    if (Object.keys(activeClients).length >= 100) {
      console.warn('[Init] Auto-reply connection limit reached (100)');
      break;
    }
    try {
      await startAutoReply(acc);
      // Small delay between account connections
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      console.error(`[Init] Failed to start auto-reply for ${acc.phone}:`, e);
    }
  }
  console.log('✅ Background initialization completed.');
};

// Helper to check if user is admin
const isAdmin = (userId: number) => {
  return userId === ADMIN_ID || (db.admins && db.admins.includes(userId));
};

// Helper to get main menu markup
const getMainMenu = (userId?: number) => {
  const buttons: any[][] = [
    [Markup.button.callback('📈 Dashboard', 'user_dashboard')],
    [Markup.button.callback('➕ Add Account', 'add_account'), Markup.button.callback('📊 My Accounts', 'my_accounts')],
  ];

  if (userId && activeBroadcasts[userId]) {
    buttons.push([Markup.button.callback('🛑 Stop Broadcast', `stop_broadcast_${userId}`)]);
  } else {
    buttons.push([Markup.button.callback('🚀 Start Broadcast', 'create_ad')]);
    buttons.push([Markup.button.callback('📢 Post Ad Menu', 'post_ad'), Markup.button.callback('🤖 Auto Reply', 'auto_reply')]);
  }

  const lastRow = [Markup.button.url('👨‍💻 Support/Owner', `https://t.me/${SUPPORT_OWNER.replace('@', '')}`)];
  buttons.push(lastRow);
  
  if (userId && isAdmin(userId)) {
    buttons.push([Markup.button.callback('👑 Admin Panel', 'admin_dashboard')]);
  }

  buttons.push([Markup.button.callback('ℹ️ About', 'about')]);
  
  return Markup.inlineKeyboard(buttons);
};

// Helper to check if user started logger bot
const isLoggerStarted = (userId: number) => {
  return (db.loggerUsers && db.loggerUsers.includes(userId)) || isAdmin(userId);
};

// Middleware to check if user is banned
const checkBan = async (ctx: any, next: () => Promise<void>) => {
  const userId = ctx.from?.id;
  if (userId && !isAdmin(userId)) {
    if (db.bannedUsers && db.bannedUsers.includes(userId)) {
      return ctx.reply('❌ *Access Denied!*\n\nYou are banned from using this bot.', { parse_mode: 'Markdown' });
    }
  }
  return next();
};

// Middleware to track users
const trackUser = async (ctx: any, next: () => Promise<void>) => {
  if (ctx.from) {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    
    if (!db.users) db.users = {};
    if (!db.users[userId]) db.users[userId] = {};
    
    let changed = false;
    if (db.users[userId].username !== username) {
      db.users[userId].username = username;
      changed = true;
    }
    if (db.users[userId].firstName !== firstName) {
      db.users[userId].firstName = firstName;
      changed = true;
    }
    
    if (changed) {
      await saveDB();
    }
  }
  return next();
};

// Middleware to check if user joined channels
const checkJoin = async (ctx: any, next: () => Promise<void>) => {
  if (ctx.from) {
    const userId = ctx.from.id;
    
    // Only enforce join check in private chats
    if (ctx.chat?.type !== 'private') return next();

    // Admins skip join check
    if (isAdmin(userId)) return next();

    // Exclude /start and check_joined action from the check to avoid infinite loops
    const text = ctx.message?.text || '';
    const callbackData = ctx.callbackQuery?.data || '';
    
    if (text.startsWith('/start') || callbackData === 'check_joined') {
      return next();
    }

    let allJoined = true;
    for (const channel of CHANNELS) {
      try {
        const member = await ctx.telegram.getChatMember(channel, userId);
        if (['left', 'kicked'].includes(member.status)) {
          allJoined = false;
          break;
        }
      } catch (e) {
        // If bot is not in the channel or can't see members, we might get 400
        // We log it but don't necessarily block if it's a bot configuration issue
        console.error(`Error checking join for ${channel}:`, e);
        // If it's a "member list is inaccessible" error, it means bot needs to be admin
        if ((e as any).description?.includes('member list is inaccessible')) {
           console.warn(`[Config Error] Bot must be an admin in ${channel} to check membership.`);
        }
        // For safety, we keep it true if we can't verify (or false if you want strict)
        // User wants it mandatory, so I'll keep it as false to force join if error occurs
        allJoined = false;
        break;
      }
    }

    if (!allJoined) {
      const joinMsg = '⚠️ *Access Denied!*\n\nYou must join our official channels to use this bot.';
      const joinKeyboard = Markup.inlineKeyboard([
        [Markup.button.url('🔹 News Channel', 'https://t.me/TeleMarketerProNews')],
        [Markup.button.url('🔹 Chats Group', 'https://t.me/TeleMarketerProChatss')],
        [Markup.button.url('🔹 Official Channel', 'https://t.me/smartkeysdailyofficial')],
        [Markup.button.callback('✅ Joined', 'check_joined')]
      ]);

      if (ctx.callbackQuery) {
        try {
          await ctx.answerCbQuery('❌ You must join our channels first!', { show_alert: true });
        } catch (e) {}
      }
      
      // Always use smartReply to ensure we don't have multiple join prompts
      await smartReply(ctx, joinMsg, joinKeyboard);
      return;
    }
  }
  return next();
};

const setupBotHandlers = (botInstance: Telegraf) => {
  botInstance.use(trackUser);
  botInstance.use(checkBan);
  botInstance.use(checkJoin);

  botInstance.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && db.bannedUsers?.includes(userId)) {
      if (ctx.callbackQuery) return ctx.answerCbQuery('❌ You are banned.', { show_alert: true });
      return ctx.reply('❌ *Access Denied!*\n\nYou are banned from using this bot.', { parse_mode: 'Markdown' });
    }
    return next();
  });

  botInstance.catch((err, ctx) => {
    console.error(`Telegraf error for ${ctx.updateType}:`, err);
    if (ctx.from?.id === ADMIN_ID) {
      ctx.reply(`❌ *Bot Error:* \`${(err as Error).message}\``, { parse_mode: 'Markdown' }).catch(() => {});
    }
  });

  botInstance.start(async (ctx) => {
    const welcomeMsg = `🚀 *Welcome to TeleMarketerPro Bot!*\n\nThe most professional ad management bot on Telegram.\n\n*Features:*\n✅ Unlimited Accounts\n✅ Instant Ad Posting\n✅ No Lag / High Speed\n✅ Professional UI\n\nUse the buttons below to navigate:`;
    
    await smartReply(ctx, welcomeMsg, getMainMenu(ctx.from.id));
  });

  botInstance.action('check_joined', async (ctx) => {
    const userId = ctx.from.id;
    
    let allJoined = true;
    for (const channel of CHANNELS) {
      try {
        const member = await ctx.telegram.getChatMember(channel, userId);
        if (['left', 'kicked', 'restricted'].includes(member.status)) {
          allJoined = false;
          break;
        }
      } catch (e) {
        allJoined = false;
        break;
      }
    }

    if (allJoined) {
      await ctx.answerCbQuery('✅ Verification Successful!');
      // State reset or main menu
      const welcomeMsg = `🚀 *Welcome back!*\n\nYou have joined all channels. You can now use the bot.`;
      await smartReply(ctx, welcomeMsg, getMainMenu(userId));
    } else {
      await ctx.answerCbQuery('❌ You haven\'t joined all channels yet!', { show_alert: true });
    }
  });

  botInstance.action('add_account', async (ctx) => {
    const userId = ctx.from.id;
    
    if (!API_ID || !API_HASH) {
      return smartReply(ctx, '⚠️ *Configuration Error*\n\nAPI_ID and API_HASH are not set in the environment.');
    }

    await smartReply(ctx, '📱 *Step 1: Enter Phone Number*\n\nPlease send your Telegram phone number in international format (e.g., +919876543210).', Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Cancel', 'back_to_main')]
    ]));

    if (!userStates[userId]) userStates[userId] = { step: 'none', data: {} };
    userStates[userId].step = 'awaiting_phone';
  });

  botInstance.on('message', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const state = userStates[userId];
    if (!state) return next();

    if (state.step === 'awaiting_phone') {
      const phone = (ctx.message as any).text.trim().replace(/\s+/g, '');
      if (!phone.startsWith('+') || phone.length < 10) {
        return ctx.reply('❌ *Invalid Format!*\n\nPlease enter a valid phone number starting with `+` and country code (e.g., +919876543210).');
      }
      
      // Delete user's message and bot's previous message
      try { await ctx.deleteMessage(); } catch (e) {}
      if (state.data?.lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, state.data.lastMsgId); } catch (e) {}
      }

      await sendVerificationCode(ctx, userId, phone);
    } else if (state.step === 'awaiting_code') {
      const code = (ctx.message as any).text.trim();
      
      // Delete user's message and bot's previous message
      try { await ctx.deleteMessage(); } catch (e) {}
      if (state.data?.lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, state.data.lastMsgId); } catch (e) {}
      }

      if (state.resolveOTP) {
        state.resolveOTP(code);
      }
    } else if (state.step === 'awaiting_2fa') {
      const password = (ctx.message as any).text.trim();
      
      // Delete user's message and bot's previous message
      try { await ctx.deleteMessage(); } catch (e) {}
      if (state.data?.lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, state.data.lastMsgId); } catch (e) {}
      }

      if (state.resolve2FA) {
        state.resolve2FA(password);
      }
    } else if (state.step === 'awaiting_template_name') {
      const name = (ctx.message as any).text.trim();
      if (!name) return ctx.reply('❌ Please enter a valid name.');
      
      try { await ctx.deleteMessage(); } catch (e) {}
      if (state.data?.lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, state.data.lastMsgId); } catch (e) {}
      }
      
      state.step = 'awaiting_template_text';
      state.data.templateName = name;
      
      const sentMsg = await ctx.reply(`📝 *Create Template: Step 2*\n\nTemplate Name: \`${name}\`\n\n*Now, please enter the text for your ad template:*`, Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Cancel', 'ad_templates')]
      ]));
      state.data.lastMsgId = sentMsg.message_id;
      
    } else if (state.step === 'awaiting_admin_id') {
      const targetId = parseInt((ctx.message as any).text.trim());
      if (isNaN(targetId)) return ctx.reply('❌ *Invalid ID!*\n\nPlease enter a numeric Telegram User ID.');

      if (!db.admins) db.admins = [];
      if (!db.admins.includes(targetId)) {
        db.admins.push(targetId);
        await saveDB();
        await ctx.reply(`✅ *User \`${targetId}\` is now an Admin!*`, { parse_mode: 'Markdown' });
        logToAdmin(`👑 *New Admin Promotion:* \`${targetId}\` (By: ${userId})`);
      } else {
        await ctx.reply('⚠️ *User is already an Admin.*');
      }
      delete userStates[userId];
      
    } else if (state.step === 'awaiting_template_text') {
      const text = (ctx.message as any).text;
      if (!text) return ctx.reply('❌ Please enter valid text.');
      
      const { templateName, lastMsgId } = state.data;
      
      db.templates.push({
        id: Math.random().toString(36).substring(2, 9),
        userId,
        name: templateName,
        text: text,
        createdAt: new Date().toISOString()
      });
      await saveDB();
      
      try { await ctx.deleteMessage(); } catch (e) {}
      if (lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, lastMsgId); } catch (e) {}
      }
      
      delete userStates[userId];
      await ctx.reply(`✅ *Template Created Successfully!*\n\nTemplate \`${templateName}\` is now saved.`, Markup.inlineKeyboard([
        [Markup.button.callback('📋 View Templates', 'ad_templates')],
        [Markup.button.callback('🔙 Back to Menu', 'back_to_main')]
      ]));
      
    } else if (state.step === 'awaiting_auto_reply_msg') {
      if (state.data?.lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, state.data.lastMsgId); } catch (e) {}
      }

      if (!db.users[userId]) db.users[userId] = {};
      db.users[userId].autoReplyMessage = (ctx.message as any).text;
      await saveDB();

      delete userStates[userId];
      await ctx.reply('✅ *Auto-Reply Message Updated!*', Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Auto Reply', 'auto_reply')]
      ]));

    } else if (state.step === 'editing_template_name') {
      const name = (ctx.message as any).text.trim();
      try { await ctx.deleteMessage(); } catch (e) {}
      if (state.data?.lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, state.data.lastMsgId); } catch (e) {}
      }

      if (name.toLowerCase() !== 'skip') {
        state.data.newName = name;
      } else {
        state.data.newName = state.data.oldName;
      }

      state.step = 'editing_template_text';
      const sentMsg = await ctx.reply(`📝 *Edit Template: ${state.data.newName}*\n\nDo you want to change the *Text*? If yes, enter new text. If no, send "skip":`, Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Cancel', 'ad_templates')]
      ]));
      state.data.lastMsgId = sentMsg.message_id;

    } else if (state.step === 'awaiting_search_query') {
      const query = (ctx.message as any).text.trim();
      try { await ctx.deleteMessage(); } catch (e) {}
      
      userStates[userId].accountSearchQuery = query;
      userStates[userId].step = 'none';
      
      await renderAccountList(ctx, userId, 0);
    } else if (state.step === 'awaiting_account_name') {
      const name = (ctx.message as any).text.trim();
      const phone = state.data.renamePhone;
      try { await ctx.deleteMessage(); } catch (e) {}
      
      const accIndex = db.accounts.findIndex((a: any) => a.phone === phone && a.userId === userId);
      if (accIndex !== -1) {
        db.accounts[accIndex].name = name;
        await saveDB();
        await ctx.reply(`✅ Account \`${phone}\` renamed to \`${name}\`.`);
      }
      
      delete userStates[userId];
      // Back to account list or the account itself
      await renderAccountList(ctx, userId, 0);

    } else if (state.step === 'editing_template_text') {
      const text = (ctx.message as any).text;
      try { await ctx.deleteMessage(); } catch (e) {}
      if (state.data?.lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, state.data.lastMsgId); } catch (e) {}
      }

      const { templateId, newName, oldText } = state.data;
      const finalName = newName;
      const finalText = text.toLowerCase() === 'skip' ? oldText : text;

      const index = db.templates.findIndex((t: any) => t.id === templateId && t.userId === userId);
      if (index !== -1) {
        db.templates[index].name = finalName;
        db.templates[index].text = finalText;
        await saveDB();
        await ctx.reply('✅ *Template Updated Successfully!*', Markup.inlineKeyboard([
          [Markup.button.callback('📋 View Templates', 'ad_templates')]
        ]));
      } else {
        await ctx.reply('❌ Template not found!');
      }
      delete userStates[userId];

    } else if (state.step === 'awaiting_ad_text') {
      const adText = (ctx.message as any).text;
      if (!adText) return ctx.reply('❌ Please send a text message for the ad.');
      
      state.data.adText = adText;
      state.step = 'selecting_interval';

      try { await ctx.deleteMessage(); } catch (e) {}
      if (state.data?.lastMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, state.data.lastMsgId); } catch (e) {}
      }

      const intervalButtons = [
        [Markup.button.callback('🚫 No Interval (Once)', 'set_interval_0')],
        [Markup.button.callback('⏱ 5 Minutes', 'set_interval_5'), Markup.button.callback('⏱ 10 Minutes', 'set_interval_10')],
        [Markup.button.callback('⏱ 30 Minutes', 'set_interval_30'), Markup.button.callback('⏱ 1 Hour', 'set_interval_60')],
        [Markup.button.callback('⏱ 2 Hours', 'set_interval_120'), Markup.button.callback('⏱ 6 Hours', 'set_interval_360')],
        [Markup.button.callback('🔙 Cancel', 'post_ad')]
      ];

      const sentMsg = await ctx.reply('🕒 *Step 3: Select Time Interval*\n\nHow often should this ad be posted? Choose "No Interval" to post only once.', Markup.inlineKeyboard(intervalButtons));
      state.data.lastMsgId = sentMsg.message_id;
    }
  });

  botInstance.on('text', async (ctx) => {
    // Only respond to text in private chats
    if (ctx.chat?.type !== 'private') return;

    const userId = ctx.from.id;
    await ctx.reply('🤖 *Main Menu*\n\nUse the buttons below to navigate:', getMainMenu(userId));
  });

  botInstance.action('auto_reply', async (ctx) => {
    const userId = ctx.from.id;
    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId);
    
    if (userAccounts.length === 0) {
      try { await ctx.deleteMessage(); } catch (e) {}
      return ctx.reply('⚠️ *No Accounts Found*\n\nPlease add at least one account to use Auto Reply.', Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Account', 'add_account')],
        [Markup.button.callback('🔙 Back', 'back_to_main')]
      ]));
    }

    const user = db.users[userId] || {};
    const currentMsg = user.autoReplyMessage || "Hello! I am currently away. This is an automated response from TeleMarketerPro Bot. 🚀";

    const allEnabled = userAccounts.every((acc: any) => acc.autoReply);
    
    const msg = `🤖 *Auto Reply Settings*\n\nEnable or disable automatic responses for all your connected accounts.\n\n*Current Message:*\n\`\`\`\n${currentMsg}\n\`\`\`\n\n_Status: ${allEnabled ? '✅ Enabled' : '❌ Disabled'}_`;
    
    const buttons = [
      [Markup.button.callback(allEnabled ? '❌ Disable All' : '✅ Enable All', 'toggle_auto_all')],
      [Markup.button.callback('📝 Edit Auto-Reply Message', 'edit_auto_reply_msg')],
      [Markup.button.callback('🔙 Back', 'back_to_main')]
    ];

    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  });

  botInstance.action('edit_auto_reply_msg', async (ctx) => {
    const userId = ctx.from.id;
    userStates[userId] = { step: 'awaiting_auto_reply_msg', data: {} };
    
    try { await ctx.deleteMessage(); } catch (e) {}
    const sentMsg = await ctx.reply('📝 *Edit Auto-Reply Message*\n\nPlease enter the new message you want to send automatically to new chats:', Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Cancel', 'auto_reply')]
    ]));
    
    userStates[userId].data.lastMsgId = sentMsg.message_id;
  });

  botInstance.action('toggle_auto_all', async (ctx) => {
    const userId = ctx.from.id;
    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId);
    
    const allEnabled = userAccounts.every((acc: any) => acc.autoReply);
    const newState = !allEnabled;
    
    db.accounts = db.accounts.map((acc: any) => {
      if (acc.userId === userId) {
        return { ...acc, autoReply: newState };
      }
      return acc;
    });
    
    await saveDB();
    
    // Actually start/stop the clients
    for (const acc of userAccounts) {
      if (newState) {
        startAutoReply({ ...acc, autoReply: newState }).catch(e => console.error(`Error starting auto-reply for ${acc.phone}:`, e));
      } else {
        stopAutoReply(acc.phone).catch(e => console.error(`Error stopping auto-reply for ${acc.phone}:`, e));
      }
    }

    await ctx.answerCbQuery(`Auto Reply ${newState ? 'Enabled' : 'Disabled'} for all accounts!`);
    
    // Refresh menu
    const user = db.users[userId] || {};
    const currentMsg = user.autoReplyMessage || "Hello! I am currently away. This is an automated response from TeleMarketerPro Bot. 🚀";
    const allEnabledNow = db.accounts.filter((acc: any) => acc.userId === userId).every((acc: any) => acc.autoReply);
    
    try { 
      await ctx.editMessageText(`🤖 *Auto Reply Settings*\n\nEnable or disable automatic responses for all your connected accounts.\n\n*Current Message:*\n\`\`\`\n${currentMsg}\n\`\`\`\n\n_Status: ${allEnabledNow ? '✅ Enabled' : '❌ Disabled'}_`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(allEnabledNow ? '❌ Disable All' : '✅ Enable All', 'toggle_auto_all')],
          [Markup.button.callback('📝 Edit Auto-Reply Message', 'edit_auto_reply_msg')],
          [Markup.button.callback('🔙 Back', 'back_to_main')]
        ])
      }); 
    } catch (e) {}
  });

  botInstance.command('id', checkBan, (ctx) => {
    ctx.reply(`🆔 *Your Telegram ID:* \`${ctx.from.id}\`\n\n_Copy this ID and set it as ADMIN_ID in your environment variables to receive logs._`, { parse_mode: 'Markdown' });
  });

  botInstance.command('add', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Only the Master Admin can add other admins.');
    const args = ctx.message.text.split(' ');
    
    const targetId = await resolveUserId(ctx, args[1]);
    if (!targetId) {
      return ctx.reply('❌ *Could not resolve User ID.*\n\n*Try one of these:*\n1. Reply to the user\'s message with `/add`\n2. Provide their numeric User ID: `/add 12345678`\n3. Provide their public username: `/add @username` (Note: Bot must have "seen" the user before or the username must be very active).', { parse_mode: 'Markdown' });
    }
    
    if (!db.admins) db.admins = [];
    if (!db.admins.includes(targetId)) {
      db.admins.push(targetId);
      await saveDB();
      ctx.reply(`✅ User \`${targetId}\` is now an Admin.`, { parse_mode: 'Markdown' });
      logToAdmin(`👑 *New Admin Added:* \`${targetId}\` by Master Admin.`);
    } else {
      ctx.reply('User is already an Admin.');
    }
  });

  botInstance.command('remove', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Only the Master Admin can remove other admins.');
    const args = ctx.message.text.split(' ');
    
    const targetId = await resolveUserId(ctx, args[1]);
    if (!targetId) return ctx.reply('❌ Could not resolve User ID. Use numeric ID or reply to a message.');
    
    if (!db.admins) db.admins = [];
    const index = db.admins.indexOf(targetId);
    if (index !== -1) {
      db.admins.splice(index, 1);
      await saveDB();
      ctx.reply(`✅ User \`${targetId}\` is no longer an Admin.`, { parse_mode: 'Markdown' });
      logToAdmin(`👑 *Admin Removed:* \`${targetId}\` by Master Admin.`);
    } else {
      ctx.reply('User is not an Admin.');
    }
  });

  botInstance.command('unbrand', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return;
    
    const text = ctx.message.text.split(' ');
    if (text.length < 2) return ctx.reply('❌ Usage: `/unbrand <userId>`', { parse_mode: 'Markdown' });
    
    const targetId = parseInt(text[1]);
    if (isNaN(targetId)) return ctx.reply('❌ Invalid User ID.');
    
    if (!db.brandingExempt) db.brandingExempt = [];
    if (!db.brandingExempt.includes(targetId)) {
      db.brandingExempt.push(targetId);
      await saveDB();
      ctx.reply(`✅ *User \`${targetId}\` is now exempt from branding enforcement.*`, { parse_mode: 'Markdown' });
    } else {
      ctx.reply(`ℹ️ *User \`${targetId}\` is already exempt.*`, { parse_mode: 'Markdown' });
    }
  });

  botInstance.command('ban', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.split(' ');
    
    const targetId = await resolveUserId(ctx, args[1]);
    if (!targetId) return ctx.reply('❌ Could not resolve User ID. Try replying to their message with `/ban`.');
    
    if (isAdmin(targetId)) return ctx.reply('❌ Cannot ban an Admin.');
    
    if (!db.bannedUsers) db.bannedUsers = [];
    if (!db.bannedUsers.includes(targetId)) {
      db.bannedUsers.push(targetId);
      await saveDB();
      ctx.reply(`✅ User \`${targetId}\` has been banned.`, { parse_mode: 'Markdown' });
      logToAdmin(`🚫 *User Banned:* \`${targetId}\` by Admin ${ctx.from.id}.`);
    } else {
      ctx.reply('User is already banned.');
    }
  });

  botInstance.command('unban', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.split(' ');
    
    const targetId = await resolveUserId(ctx, args[1]);
    if (!targetId) return ctx.reply('❌ Could not resolve User ID. Use numeric ID or reply to a message.');
    
    if (!db.bannedUsers) db.bannedUsers = [];
    const index = db.bannedUsers.indexOf(targetId);
    if (index !== -1) {
      db.bannedUsers.splice(index, 1);
      await saveDB();
      ctx.reply(`✅ User \`${targetId}\` has been unbanned.`, { parse_mode: 'Markdown' });
      logToAdmin(`🔓 *User Unbanned:* \`${targetId}\` by Admin ${ctx.from.id}.`);
    } else {
      ctx.reply('User is not banned.');
    }
  });

  botInstance.action('post_ad', async (ctx) => {
    const userId = ctx.from.id;
    
    if (activeBroadcasts[userId]) {
      try { await ctx.deleteMessage(); } catch (e) {}
      return ctx.reply('⚠️ *Broadcast in Progress*\n\nYou already have an active broadcast running. Please stop it or wait for it to finish.', Markup.inlineKeyboard([
        [Markup.button.callback('🛑 Stop Current Broadcast', `stop_broadcast_${userId}`)],
        [Markup.button.callback('🔙 Back', 'back_to_main')]
      ]));
    }

    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply('📢 *Post Ad Menu*\n\nSelect how you want to post your ad:', Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Start Broadcast', 'create_ad')],
      [Markup.button.callback('📋 My Ad Templates', 'ad_templates')],
      [Markup.button.callback('🔙 Back', 'back_to_main')]
    ]));
  });

  botInstance.action('settings', async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply('⚙️ *Bot Settings*\n\nConfigure your bot preferences:', Markup.inlineKeyboard([
      [Markup.button.callback('🌐 Proxy Settings', 'proxy_settings')],
      [Markup.button.callback('🔔 Notifications', 'toggle_notify')],
      [Markup.button.callback('🔙 Back', 'back_to_main')]
    ]));
  });

  botInstance.action('back_to_main', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];
    if (state?.client) {
      try { await state.client.disconnect(); } catch (e) {}
    }
    delete userStates[userId];
    
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply('🚀 *TeleMarketerPro Bot Main Menu*', getMainMenu(userId));
  });

  botInstance.action('about', async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply('ℹ️ *About TeleMarketerPro*\n\nThis bot is designed for professional marketers who want to scale their reach on Telegram without any limits or lag.\n\n*Developer:* @smartkeysdailyofficial', Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back', 'back_to_main')]
    ]));
  });

  botInstance.action('my_accounts', async (ctx) => {
    const userId = ctx.from.id;
    await renderAccountList(ctx, userId, 0);
  });

  botInstance.action(/my_accounts_page_(\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const page = parseInt(ctx.match[1]);
    await renderAccountList(ctx, userId, page);
  });

  botInstance.action('search_accounts', async (ctx) => {
    const userId = ctx.from.id;
    userStates[userId] = { ...userStates[userId], step: 'awaiting_search_query' };
    await smartReply(ctx, '🔍 *Search Accounts*\n\nPlease enter a phone number or name to filter your accounts:', Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to List', 'my_accounts')]
    ]));
  });

  botInstance.action('clear_search', async (ctx) => {
    const userId = ctx.from.id;
    if (userStates[userId]) delete userStates[userId].accountSearchQuery;
    await renderAccountList(ctx, userId, 0);
  });

  botInstance.action('user_dashboard', async (ctx) => {
    const userId = ctx.from.id;
    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId);
    const userStats = db.users[userId]?.stats || { messagesSent: 0, groupsMessaged: 0 };
    
    const msg = `📈 *Your Personal Dashboard*\n\n` +
                `📱 *Accounts Connected:* \`${userAccounts.length}\`\n` +
                `✨ *Total Messages Sent:* \`${userStats.messagesSent}\`\n` +
                `👥 *Total Groups Reached:* \`${userStats.groupsMessaged}\`\n\n` +
                `_Keep broadcasting to grow your reach!_`;
                
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'back_to_main')]]) });
  });

  botInstance.action('admin_dashboard', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return ctx.answerCbQuery('❌ Unauthorized');
    
    const totalUsers = Object.keys(db.users).length;
    const totalAccounts = db.accounts.length;
    const globalStats = db.globalStats || { totalMessagesSent: 0, totalGroupsMessaged: 0 };
    const bannedCount = db.bannedUsers?.length || 0;
    
    const msg = `👑 *Admin Control Panel*\n\n` +
                `👥 *Total Users:* \`${totalUsers}\`\n` +
                `📱 *Total Phone Numbers:* \`${totalAccounts}\`\n` +
                `✨ *Global Messages Sent:* \`${globalStats.totalMessagesSent}\`\n` +
                `🏢 *Global Groups Reached:* \`${globalStats.totalGroupsMessaged}\`\n` +
                `🚫 *Banned Users:* \`${bannedCount}\`\n\n` +
                `_System is running smoothly._`;
                
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('🚫 Manage Bans', 'manage_bans_list'), Markup.button.callback('➕ Add Admin', 'add_admin_prompt')],
      [Markup.button.callback('🔙 Back', 'back_to_main')]
    ]) });
  });

  botInstance.action('add_admin_prompt', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return;
    
    userStates[userId] = { step: 'awaiting_admin_id' };
    await ctx.reply('🆔 *Please enter the Telegram User ID to promote to Admin:*', { parse_mode: 'Markdown', ...Markup.button.callback('❌ Cancel', 'admin_dashboard') });
  });

  botInstance.action('manage_bans_list', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return;
    
    const banned = db.bannedUsers || [];
    
    let msg = `🚫 *Banned Users List (${banned.length})*\n\n`;
    if (banned.length === 0) msg += '_No users are currently banned._';
    else msg += banned.map((id: number) => `• \`${id}\``).join('\n');
    
    msg += `\n\n_Use /ban <id> or /unban <id> to manage._`;
    
    try { await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Admin', 'admin_dashboard')]]) }); } catch (e) {}
  });

const renderAccountManage = async (ctx: any, phone: string, userId: number) => {
  const acc = db.accounts.find((a: any) => a.phone === phone && a.userId === userId);
  if (!acc) return ctx.answerCbQuery('Account not found!');
  
  const accStats = acc.stats || { messagesSent: 0, groupsMessaged: 0 };
  const isOnline = activeClients[phone]?.connected;
  
  let statusText = isOnline ? '🟢 Connected' : (acc.status === 'expired' ? '🔴 Session Expired' : '⚪️ Idle (Ready)');

  const msg = `📱 *Account Details*\n\n` +
              `*Phone:* \`${phone}\`\n` +
              `*Name:* \`${acc.name || 'Not Set'}\`\n` +
              `*Status:* ${statusText}\n` +
              `*Added:* ${new Date(acc.addedAt).toLocaleDateString()}\n` +
              `*Auto Reply:* ${acc.autoReply ? '✅ Enabled' : '❌ Disabled'}\n\n` +
              `📊 *Account Stats:*\n` +
              `✨ Messages Sent: \`${accStats.messagesSent}\`\n` +
              `👥 Groups Reached: \`${accStats.groupsMessaged}\``;
  
  const buttons = [
    [Markup.button.callback(acc.autoReply ? '❌ Disable Auto Reply' : '✅ Enable Auto Reply', `toggle_acc_auto_${phone}`)],
    [Markup.button.callback('🔍 Check Status', `check_status_${phone}`), Markup.button.callback('✏️ Rename', `rename_acc_${phone}`)],
    [Markup.button.callback('🗑 Delete Account', `delete_acc_${phone}`)],
    [Markup.button.callback('🔙 Back to List', 'my_accounts')]
  ];

  try {
    await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    await smartReply(ctx, msg, Markup.inlineKeyboard(buttons));
  }
};

  botInstance.action(/manage_acc_(.+)/, async (ctx) => {
    const phone = ctx.match[1].trim();
    const userId = ctx.from.id;
    await renderAccountManage(ctx, phone, userId);
  });

  botInstance.action(/check_status_(.+)/, async (ctx) => {
    const phone = ctx.match[1].trim();
    const userId = ctx.from.id;
    const acc = db.accounts.find((a: any) => a.phone === phone && a.userId === userId);
    if (!acc) return ctx.answerCbQuery('Account not found!');

    await ctx.answerCbQuery('⏳ Checking status...');
    
    try {
      const client = new TelegramClient(new StringSession(acc.session), API_ID, API_HASH, {
        connectionRetries: 0,
        requestRetries: 0,
        timeout: 10000,
        useWSS: true,
      });
      await client.connect();
      const me = await client.getMe();
      await client.disconnect();
      
      if (me) {
        acc.status = 'active';
        await ctx.answerCbQuery('✅ Account is ACTIVE!', { show_alert: true });
      } else {
        throw new Error('Revoked');
      }
    } catch (e) {
      acc.status = 'expired';
      await ctx.answerCbQuery('❌ Session EXPIRED or REVOKED.', { show_alert: true });
    }
    
    await saveDB();
    await renderAccountManage(ctx, phone, userId);
  });

  botInstance.action(/rename_acc_(.+)/, async (ctx) => {
    const phone = ctx.match[1].trim();
    const userId = ctx.from.id;
    userStates[userId] = { ...userStates[userId], step: 'awaiting_account_name', data: { renamePhone: phone } };
    
    await smartReply(ctx, `✏️ *Rename Account: ${phone}*\n\nPlease enter a friendly name for this account:`, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Cancel', `manage_acc_${phone}`)]
    ]));
  });

  botInstance.action(/toggle_acc_auto_(.+)/, async (ctx) => {
    const phone = ctx.match[1];
    const userId = ctx.from.id;
    const accIndex = db.accounts.findIndex((a: any) => a.phone === phone && a.userId === userId);
    
    if (accIndex === -1) return ctx.answerCbQuery('Account not found!');
    
    const newState = !db.accounts[accIndex].autoReply;
    db.accounts[accIndex].autoReply = newState;
    await saveDB();
    
    if (newState) {
      await startAutoReply(db.accounts[accIndex]);
    } else {
      await stopAutoReply(phone);
    }
    
    await ctx.answerCbQuery(`Auto Reply ${newState ? 'Enabled' : 'Disabled'}!`);
    
    // Refresh management menu
    const acc = db.accounts[accIndex];
    const msg = `📱 *Account:* \`${phone}\`\n📅 *Added:* ${new Date(acc.addedAt).toLocaleDateString()}\n🤖 *Auto Reply:* ${acc.autoReply ? '✅ Enabled' : '❌ Disabled'}`;
    try { await ctx.editMessageText(msg, Markup.inlineKeyboard([
      [Markup.button.callback(acc.autoReply ? '❌ Disable Auto Reply' : '✅ Enable Auto Reply', `toggle_acc_auto_${phone}`)],
      [Markup.button.callback('🗑 Delete Account', `delete_acc_${phone}`)],
      [Markup.button.callback('🔙 Back to List', 'my_accounts')]
    ])); } catch (e) {}
  });

  botInstance.action(/delete_acc_(.+)/, async (ctx) => {
    const phone = ctx.match[1];
    const userId = ctx.from.id;
    
    const accountIndex = db.accounts.findIndex((acc: any) => acc.phone === phone && acc.userId === userId);
    if (accountIndex !== -1) {
      await stopAutoReply(phone);
      db.accounts.splice(accountIndex, 1);
      await saveDB();
      await ctx.answerCbQuery('✅ Account deleted successfully!');
    } else {
      await ctx.answerCbQuery('❌ Account not found!', { show_alert: true });
    }
    
    // Refresh accounts list
    return ctx.editMessageText('📊 *Your Accounts*\n\nAccount deleted.', Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to Accounts', 'my_accounts')]
    ]));
  });

  botInstance.action('ad_templates', async (ctx) => {
    const userId = ctx.from.id;
    const userTemplates = db.templates.filter((t: any) => t.userId === userId);
    
    let msg = '📋 *My Ad Templates*\n\nManage your saved ad templates for quick broadcasting:';
    if (userTemplates.length === 0) {
      msg += '\n\n_No templates saved yet._';
    }
    
    const buttons = [];
    for (const t of userTemplates) {
      buttons.push([Markup.button.callback(`📝 ${t.name}`, `view_template_${t.id}`)]);
    }
    
    buttons.push([Markup.button.callback('➕ Create New Template', 'add_template')]);
    buttons.push([Markup.button.callback('🔙 Back', 'post_ad')]);
    
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  });

  botInstance.action('add_template', async (ctx) => {
    const userId = ctx.from.id;
    userStates[userId] = { step: 'awaiting_template_name', data: {} };
    
    try { await ctx.deleteMessage(); } catch (e) {}
    const sentMsg = await ctx.reply('📝 *Create Template: Step 1*\n\nPlease enter a *Name* for your new template (e.g., "Promo 1"):', Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Cancel', 'ad_templates')]
    ]));
    
    userStates[userId].data.lastMsgId = sentMsg.message_id;
  });

  botInstance.action(/^view_template_(.+)$/, async (ctx) => {
    const templateId = ctx.match[1];
    const userId = ctx.from.id;
    const template = db.templates.find((t: any) => t.id === templateId && t.userId === userId);
    
    if (!template) return ctx.answerCbQuery('❌ Template not found!');
    
    const msg = `📋 *Template:* ${template.name}\n\n*Content:*\n\`\`\`\n${template.text}\n\`\`\``;
    
    const buttons = [
      [Markup.button.callback('📝 Edit Template', `edit_template_${templateId}`)],
      [Markup.button.callback('🗑️ Delete Template', `delete_template_${templateId}`)],
      [Markup.button.callback('🔙 Back to Templates', 'ad_templates')]
    ];
    
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  });

  botInstance.action(/^edit_template_(.+)$/, async (ctx) => {
    const templateId = ctx.match[1];
    const userId = ctx.from.id;
    const template = db.templates.find((t: any) => t.id === templateId && t.userId === userId);
    
    if (!template) return ctx.answerCbQuery('❌ Template not found!');
    
    userStates[userId] = { step: 'editing_template_name', data: { templateId, oldName: template.name, oldText: template.text } };
    
    try { await ctx.deleteMessage(); } catch (e) {}
    const sentMsg = await ctx.reply(`📝 *Edit Template: ${template.name}*\n\nDo you want to change the *Name*? If yes, enter new name. If no, send "skip":`, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Cancel', 'ad_templates')]
    ]));
    
    userStates[userId].data.lastMsgId = sentMsg.message_id;
  });

  botInstance.action(/^delete_template_(.+)$/, async (ctx) => {
    const templateId = ctx.match[1];
    const userId = ctx.from.id;
    
    const index = db.templates.findIndex((t: any) => t.id === templateId && t.userId === userId);
    if (index !== -1) {
      db.templates.splice(index, 1);
      await saveDB();
      await ctx.answerCbQuery('✅ Template deleted!');
    } else {
      await ctx.answerCbQuery('❌ Template not found!');
    }
    
    // Refresh templates list
    const userTemplates = db.templates.filter((t: any) => t.userId === userId);
    let msg = '📋 *My Ad Templates*\n\nManage your saved ad templates for quick broadcasting:';
    if (userTemplates.length === 0) msg += '\n\n_No templates saved yet._';
    
    const buttons = [];
    for (const t of userTemplates) {
      buttons.push([Markup.button.callback(`📝 ${t.name}`, `view_template_${t.id}`)]);
    }
    buttons.push([Markup.button.callback('➕ Create New Template', 'add_template')]);
    buttons.push([Markup.button.callback('🔙 Back', 'post_ad')]);
    
    try { await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); } catch (e) {}
  });

  botInstance.action('select_template_for_broadcast', async (ctx) => {
    const userId = ctx.from.id;
    const userTemplates = db.templates.filter((t: any) => t.userId === userId);
    
    if (userTemplates.length === 0) {
      return ctx.answerCbQuery('⚠️ No templates found. Please create one first.', { show_alert: true });
    }
    
    const buttons = [];
    for (const t of userTemplates) {
      buttons.push([Markup.button.callback(`📝 ${t.name}`, `use_template_${t.id}`)]);
    }
    buttons.push([Markup.button.callback('🔙 Back', 'confirm_broadcast_selection')]);
    
    try { await ctx.editMessageText('📋 *Select a Template*\n\nChoose a template to use for this broadcast:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); } catch (e) {}
  });

  botInstance.action(/^use_template_(.+)$/, async (ctx) => {
    const templateId = ctx.match[1];
    const userId = ctx.from.id;
    const template = db.templates.find((t: any) => t.id === templateId && t.userId === userId);
    
    if (!template) return ctx.answerCbQuery('❌ Template not found!');
    
    const state = userStates[userId];
    if (!state) return ctx.answerCbQuery('Session expired.');
    
    state.data.adText = template.text;
    state.step = 'selecting_interval';

    const intervalButtons = [
      [Markup.button.callback('🚫 No Interval (Once)', 'set_interval_0')],
      [Markup.button.callback('⏱ 5 Minutes', 'set_interval_5'), Markup.button.callback('⏱ 10 Minutes', 'set_interval_10')],
      [Markup.button.callback('⏱ 30 Minutes', 'set_interval_30'), Markup.button.callback('⏱ 1 Hour', 'set_interval_60')],
      [Markup.button.callback('⏱ 2 Hours', 'set_interval_120'), Markup.button.callback('⏱ 6 Hours', 'set_interval_360')],
      [Markup.button.callback('🔙 Cancel', 'post_ad')]
    ];

    try { await ctx.deleteMessage(); } catch (e) {}
    const sentMsg = await ctx.reply('🕒 *Step 3: Select Time Interval*\n\nHow often should this ad be posted? Choose "No Interval" to post only once.', Markup.inlineKeyboard(intervalButtons));
    state.data.lastMsgId = sentMsg.message_id;
  });

  botInstance.action(/^set_interval_(\d+)$/, async (ctx) => {
    const interval = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    const state = userStates[userId];
    
    if (!state || state.step !== 'selecting_interval') return ctx.answerCbQuery('Session expired.');

    const adText = state.data.adText;
    const selectedPhones = state.data.selectedAccounts || [];

    // Final check for logger bot before starting broadcast
    if (!isLoggerStarted(userId)) {
      // Store pending broadcast data
      state.data.pendingBroadcast = { interval, adText, selectedPhones };
      
      if (!loggerBot) return ctx.reply('❌ Logger bot system is initializing...');
      const loggerBotInfo = await loggerBot.telegram.getMe();
      return ctx.reply(
        '❌ *Logger Bot Not Started!*\n\nYou must start our Logger Bot to receive broadcast logs.\n\n*1. Click the button below to start the Logger Bot.*\n*2. Come back here and click "Verify & Start".*',
        Markup.inlineKeyboard([
          [Markup.button.url('🚀 Start Logger Bot', `https://t.me/${loggerBotInfo.username}`)],
          [Markup.button.callback('✅ Verify & Start Broadcast', 'verify_logger_and_start')]
        ])
      );
    }
    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId && selectedPhones.includes(acc.phone));
    
    if (userAccounts.length === 0) {
      delete userStates[userId];
      return ctx.reply('❌ No selected accounts found to broadcast from.');
    }

    activeBroadcasts[userId] = true;
    logToAdmin(`🚀 *Broadcast Started:* User ${userId} is broadcasting from ${userAccounts.length} accounts. Interval: ${interval} mins.`);
    
    await ctx.answerCbQuery('🚀 Broadcast started successfully!', { show_alert: true });
    
    try { await ctx.deleteMessage(); } catch (e) {}
    
    startBroadcast(ctx, userId, userAccounts, adText, null, interval);
    
    await ctx.reply('🤖 *Main Menu*\n\nYour broadcast is now running in the background. You can track progress in the Logger Bot.', getMainMenu(userId));
  });

  botInstance.action('verify_logger_and_start', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];
    
    if (!isLoggerStarted(userId)) {
      return ctx.answerCbQuery('❌ You haven\'t started the Logger Bot yet!', { show_alert: true });
    }

    if (!state || !state.data?.pendingBroadcast) {
      return ctx.answerCbQuery('❌ Session expired or no pending broadcast found.', { show_alert: true });
    }

    const { interval, adText, selectedPhones } = state.data.pendingBroadcast;
    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId && selectedPhones.includes(acc.phone));
    
    if (userAccounts.length === 0) {
      delete userStates[userId];
      return ctx.reply('❌ No selected accounts found to broadcast from.');
    }

    activeBroadcasts[userId] = true;
    logToAdmin(`🚀 *Broadcast Started (After Verification):* User ${userId} is broadcasting from ${userAccounts.length} accounts. Interval: ${interval} mins.`);
    
    await ctx.answerCbQuery('🚀 Broadcast started successfully!', { show_alert: true });
    
    try { await ctx.deleteMessage(); } catch (e) {}
    
    startBroadcast(ctx, userId, userAccounts, adText, null, interval);
    
    await ctx.reply('🤖 *Main Menu*\n\nYour broadcast is now running in the background. You can track progress in the Logger Bot.', getMainMenu(userId));
  });

  botInstance.action('toggle_notify', async (ctx) => {
    await ctx.answerCbQuery('Notifications toggled!');
  });

  botInstance.action('create_ad', async (ctx) => {
    const userId = ctx.from.id;
    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId);
    
    if (userAccounts.length === 0) {
      try { await ctx.deleteMessage(); } catch (e) {}
      return ctx.reply('⚠️ *No Accounts Found*\n\nPlease add at least one account to post ads.', Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Account', 'add_account')],
        [Markup.button.callback('🔙 Back', 'post_ad')]
      ]));
    }

    // Initialize selection state
    userStates[userId] = { 
      step: 'selecting_accounts', 
      data: { 
        selectedAccounts: userAccounts.map((acc: any) => acc.phone) 
      } 
    };

    return renderAccountSelection(ctx, userAccounts, userStates[userId].data.selectedAccounts);
  });

  botInstance.action(/toggle_broadcast_acc_(.+)/, async (ctx) => {
    const phone = ctx.match[1];
    const userId = ctx.from.id;
    const state = userStates[userId];
    
    if (!state || state.step !== 'selecting_accounts') return ctx.answerCbQuery('Session expired.');

    const selected = state.data.selectedAccounts;
    const index = selected.indexOf(phone);
    
    if (index === -1) {
      selected.push(phone);
    } else {
      selected.splice(index, 1);
    }

    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId);
    return renderAccountSelection(ctx, userAccounts, selected);
  });

  botInstance.action('broadcast_select_all', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];
    if (!state || state.step !== 'selecting_accounts') return ctx.answerCbQuery('Session expired.');

    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId);
    state.data.selectedAccounts = userAccounts.map((acc: any) => acc.phone);
    
    return renderAccountSelection(ctx, userAccounts, state.data.selectedAccounts);
  });

  botInstance.action('broadcast_deselect_all', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];
    if (!state || state.step !== 'selecting_accounts') return ctx.answerCbQuery('Session expired.');

    state.data.selectedAccounts = [];
    const userAccounts = db.accounts.filter((acc: any) => acc.userId === userId);
    
    return renderAccountSelection(ctx, userAccounts, state.data.selectedAccounts);
  });

  botInstance.action('confirm_broadcast_selection', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];
    if (!state || state.step !== 'selecting_accounts') return ctx.answerCbQuery('Session expired.');

    if (state.data.selectedAccounts.length === 0) {
      return ctx.answerCbQuery('⚠️ Please select at least one account!', { show_alert: true });
    }

    state.step = 'awaiting_ad_text';
    
    try { await ctx.deleteMessage(); } catch (e) {}
    const sentMsg = await ctx.reply('📝 *Step 2: Enter Ad Text*\n\nPlease send the text you want to broadcast, or choose a saved template.\n\n_Note: This will be sent to all active chats of the selected accounts._', Markup.inlineKeyboard([
      [Markup.button.callback('📋 Use Saved Template', 'select_template_for_broadcast')],
      [Markup.button.callback('🔙 Back to Selection', 'create_ad')],
      [Markup.button.callback('🔙 Cancel', 'post_ad')]
    ]));

    state.data.lastMsgId = sentMsg.message_id;
  });
};

const setupLoggerHandlers = (loggerInstance: Telegraf) => {
  loggerInstance.start(async (ctx) => {
    const userId = ctx.from.id;
    if (!db.loggerUsers) db.loggerUsers = [];
    if (!db.loggerUsers.includes(userId)) {
      db.loggerUsers.push(userId);
      await saveDB();
    }
    await ctx.reply('🚀 *Logger Bot Started!*\n\nYou will now receive real-time logs of your broadcasts here.');
  });
};

// Track broadcast status and stats
const activeBroadcasts: Record<number, boolean> = {};
const broadcastStats: Record<number, {
  totalSent: number;
  successCount: number;
  failCount: number;
  cycleCount: number;
}> = {};

const startBroadcast = async (ctx: any, userId: number, userAccounts: any[], adText: string, statusMsg: any = null, intervalMinutes: number = 0) => {
  broadcastStats[userId] = {
    totalSent: 0,
    successCount: 0,
    failCount: 0,
    cycleCount: 0
  };

  const runCycle = async () => {
    if (!activeBroadcasts[userId]) return;
    broadcastStats[userId].cycleCount++;
    const stats = broadcastStats[userId];
    const startTotalSent = stats.totalSent;
    
    // Update status for new cycle
    if (intervalMinutes > 0 && stats.cycleCount > 1 && statusMsg) {
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `🚀 *Broadcast Cycle #${stats.cycleCount} Started...*\n\nSending your ad to all connected accounts.\n\n_Progress: Initializing..._`, Markup.inlineKeyboard([
          [Markup.button.callback('🛑 Stop Broadcast', `stop_broadcast_${userId}`)]
        ]));
      } catch (e) {}
    }

    broadcastLoop: for (const acc of userAccounts) {
      if (!activeBroadcasts[userId]) break;

      try {
        let client = activeClients[acc.phone];
        let localClient = false;
        
        if (!client) {
          client = new TelegramClient(new StringSession(acc.session), API_ID, API_HASH, {
            connectionRetries: 2,
            requestRetries: 2,
            timeout: 60000, // 60 seconds
          });
          
          console.log(`Connecting to account ${acc.phone}...`);
          await withRetry(() => client.connect(), `Broadcast Connect for ${acc.phone}`);
          localClient = true;
        }

        // Enforce branding before broadcasting
        await enforceProfile(client, userId, acc.phone);
        
        console.log(`Fetching dialogs for ${acc.phone}...`);
        const dialogs = await withRetry(() => client.getDialogs({ limit: 500 }), `GetDialogs for ${acc.phone}`);
        
        for (const dialog of dialogs) {
          if (!activeBroadcasts[userId]) break broadcastLoop;

          const isSuperGroup = dialog.isChannel && dialog.entity instanceof Api.Channel && !dialog.entity.broadcast;
          if (dialog.isGroup || isSuperGroup) {
            try {
              const targetPeer = dialog.id ? dialog.id.toString() : '';
              const sentMessage = await withRetry(() => client.sendMessage(targetPeer, { message: adText }), `Broadcast SendMessage to ${dialog.id}`) as any;
              
              // Construct message link
              let messageLink = '';
              const entity = dialog.entity as any;
              if (entity && entity.username && sentMessage.id) {
                messageLink = `https://t.me/${entity.username}/${sentMessage.id}`;
              } else if (dialog.id && sentMessage.id) {
                const peerId = dialog.id.toString().replace('-100', '');
                messageLink = `https://t.me/c/${peerId}/${sentMessage.id}`;
              }

              // Send log to user via logger bot
              if (isLoggerStarted(userId) && loggerBot) {
                try {
                  await loggerBot.telegram.sendMessage(userId, `✅ *Message Sent!*\n\n📱 *Account:* \`${acc.phone}\`\n👥 *Group:* \`${dialog.title}\`\n🔗 [View Message](${messageLink})`, { 
                    parse_mode: 'Markdown', 
                    link_preview_options: { is_disabled: true } 
                  });
                } catch (logErr) {
                  console.error(`Failed to send log to user ${userId}:`, logErr);
                }
              }

              stats.totalSent++;
              
              // Update Persistent Stats
              if (!db.globalStats) db.globalStats = { totalMessagesSent: 0, totalGroupsMessaged: 0 };
              db.globalStats.totalMessagesSent++;
              db.globalStats.totalGroupsMessaged++;

              if (!db.users[userId]) db.users[userId] = { violations: 0, stats: { messagesSent: 0, groupsMessaged: 0 } };
              if (!db.users[userId].stats) db.users[userId].stats = { messagesSent: 0, groupsMessaged: 0 };
              db.users[userId].stats.messagesSent++;
              db.users[userId].stats.groupsMessaged++;

              const accIdx = db.accounts.findIndex((a: any) => a.phone === acc.phone && a.userId === userId);
              if (accIdx !== -1) {
                if (!db.accounts[accIdx].stats) db.accounts[accIdx].stats = { messagesSent: 0, groupsMessaged: 0 };
                db.accounts[accIdx].stats.messagesSent++;
                db.accounts[accIdx].stats.groupsMessaged++;
              }
              
              // Save DB after each account is fully processed or every 10 messages
              if (stats.totalSent % 10 === 0) await saveDB();

              if (stats.totalSent % 5 === 0 && statusMsg) {
                try {
                  await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `🚀 *Broadcasting (Cycle #${stats.cycleCount})...*\n\n_Total Sent: ${stats.totalSent}_\n_Accounts Processed: ${stats.successCount}/${userAccounts.length}_\n\nSending your ad to all connected accounts.`, Markup.inlineKeyboard([
                    [Markup.button.callback('🛑 Stop Broadcast', `stop_broadcast_${userId}`)]
                  ]));
                } catch (e) {}
              }
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e: any) {
              const errName = e.errorMessage || e.message || '';
              if (errName.includes('CHAT_WRITE_FORBIDDEN') || errName.includes('CHAT_SEND_PLAIN_FORBIDDEN')) {
                console.log(`Skipping chat ${dialog.id} on ${acc.phone}: Permission denied (Muted/Forbidden)`);
                continue;
              } else if (errName.includes('SLOW_MODE_WAIT')) {
                const waitTime = parseInt(errName.match(/\d+/)?.[0] || '60');
                console.log(`Slow mode in chat ${dialog.id} on ${acc.phone}: Waiting ${waitTime}s...`);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
              } else {
                console.error(`Failed to send message to ${dialog.id} on ${acc.phone}:`, e);
              }
            }
          }
        }
        
        if (localClient) await client.disconnect();
        stats.successCount++;
        await saveDB(); // Save after each account finishes its groups
      } catch (e: any) {
        console.error(`Failed to broadcast from ${acc.phone}:`, e);
        let errorMsg = e.message;
        if (e.message === 'TIMEOUT') {
          errorMsg = 'Connection Timeout (Telegram server not responding)';
        }
        
        if (e.message.includes('AUTH_KEY_UNREGISTERED') || e.message.includes('SESSION_REVOKED')) {
          errorMsg = 'Session Expired / Invalid. Please refresh account session.';
          logToAdmin(`❌ *Session Expired:* Account \`${acc.phone}\` (User: ${userId}) needs re-authentication.`);
        }

        logToAdmin(`⚠️ *Broadcast Error:* Account \`${acc.phone}\` failed. Error: ${errorMsg}`);
        stats.failCount++;
      }
    }

    const cycleSent = stats.totalSent - startTotalSent;
    const phoneList = userAccounts.map(acc => `\`${acc.phone}\``).join(', ');

    if (isLoggerStarted(userId) && loggerBot) {
      try {
        await loggerBot.telegram.sendMessage(userId, `⏳ *Cycle #${stats.cycleCount} Complete!*\n\n📱 *Accounts:* ${phoneList}\n✨ *Messages Sent in this Cycle:* ${cycleSent}\n📊 *Total Messages Sent so far:* ${stats.totalSent}`, { parse_mode: 'Markdown' });
      } catch (logErr) {
        console.error(`Failed to send cycle log to user ${userId}:`, logErr);
      }
    }

    if (activeBroadcasts[userId] && intervalMinutes > 0) {
      const nextRun = new Date(Date.now() + intervalMinutes * 60000);
      const nextRunStr = nextRun.toLocaleTimeString();
      
      if (statusMsg) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `⏳ *Cycle #${stats.cycleCount} Complete!*\n\n*Results so far:*\n🟢 Success: ${stats.successCount} accounts\n🔴 Failed: ${stats.failCount} accounts\n✨ Total Messages Sent: ${stats.totalSent}\n\n🔄 *Next run scheduled for:* \`${nextRunStr}\` (every ${intervalMinutes} mins)`, Markup.inlineKeyboard([
            [Markup.button.callback('🛑 Stop Broadcast', `stop_broadcast_${userId}`)]
          ]));
        } catch (e) {}
      }

      // Schedule next run
      setTimeout(() => {
        if (activeBroadcasts[userId]) runCycle();
      }, intervalMinutes * 60000);
    } else if (activeBroadcasts[userId]) {
      // Final finish (only if not manually stopped)
      delete activeBroadcasts[userId];
      logToAdmin(`🏁 *Broadcast Finished:* User ${userId} (Status: Completed)`);
      delete userStates[userId];

      const finalMsg = `✅ *Broadcast Complete!*\n\n*Results:*\n🟢 Success: ${stats.successCount} accounts\n🔴 Failed: ${stats.failCount} accounts\n✨ Total Messages Sent: ${stats.totalSent}\n\nYour ad has been sent to all active chats.`;

      if (statusMsg) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, finalMsg, getMainMenu(userId));
        } catch (e) {
          await ctx.reply(finalMsg, getMainMenu(userId));
        }
      } else {
        await ctx.reply(finalMsg, getMainMenu(userId));
      }
      delete broadcastStats[userId];
    }
  };

  await runCycle();
};

// Helper to resolve user ID from ID, Username, or Reply
const resolveUserId = async (ctx: any, input?: string): Promise<number | null> => {
  // 1. Check if it's a reply to a message
  if (ctx.message?.reply_to_message?.from) {
    return ctx.message.reply_to_message.from.id;
  }

  if (!input) return null;
  
  // 2. If numeric ID
  const numericId = parseInt(input);
  if (!isNaN(numericId) && /^\d+$/.test(input)) return numericId;
  
  // 3. Check local database cache (Most reliable for usernames)
  if (db.users) {
    const cleanUsername = input.startsWith('@') ? input.slice(1).toLowerCase() : input.toLowerCase();
    for (const [id, data] of Object.entries(db.users)) {
      if ((data as any).username?.toLowerCase() === cleanUsername) {
        return parseInt(id);
      }
    }
  }
  
  // 4. If username (Fallback to Telegram API)
  const username = input.startsWith('@') ? input : `@${input}`;
  try {
    // Try to get chat info
    const chat = await ctx.telegram.getChat(username);
    return chat.id;
  } catch (e: any) {
    // Don't log error to console as it's expected for unknown users
    return null;
  }
};









const renderAccountSelection = async (ctx: any, accounts: any[], selected: string[]) => {
  let msg = '🎯 *Select Accounts for Broadcast*\n\nChoose which accounts you want to use for this ad campaign:';
  
  const buttons = [];
  
  // Select All / Deselect All row
  buttons.push([
    Markup.button.callback('✅ Select All', 'broadcast_select_all'),
    Markup.button.callback('❌ Deselect All', 'broadcast_deselect_all')
  ]);

  // Account buttons
  for (const acc of accounts) {
    const isSelected = selected.includes(acc.phone);
    buttons.push([
      Markup.button.callback(`${isSelected ? '✅' : '⬜️'} ${acc.phone}`, `toggle_broadcast_acc_${acc.phone}`)
    ]);
  }

  // Action buttons
  buttons.push([Markup.button.callback('🚀 Confirm & Proceed', 'confirm_broadcast_selection')]);
  buttons.push([Markup.button.callback('🔙 Cancel', 'post_ad')]);

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } else {
      await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
    }
  } catch (e) {}
};



// --- Logger Function ---
const logToAdmin = async (message: string) => {
  if (ADMIN_ID && loggerBot) {
    try {
      await loggerBot.telegram.sendMessage(ADMIN_ID, `📊 *LOG:* ${message}`, { parse_mode: 'Markdown' });
    } catch (e: any) {
      if (e.message?.includes('401')) {
        console.warn('[Logger] 401 Unauthorized. Logger Bot token is invalid.');
      } else if (e.message?.includes('chat not found')) {
        console.warn(`[Logger] Admin ${ADMIN_ID} hasn't started the Logger Bot yet.`);
      } else {
        console.error('Logger Error:', e);
      }
    }
  }
};

// Start the application
startApp();

// Force polling for better reliability in this environment
// Consolidated into startApp
