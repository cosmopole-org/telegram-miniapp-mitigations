'use strict';

const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const DB_SSL = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';
const BOT_COMMAND_PREFIX = process.env.BOT_COMMAND_PREFIX || '/';

if (!BOT_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN environment variable');
}

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL environment variable');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DB_SSL ? { rejectUnauthorized: false } : false
});

function sanitizeTextParam(value, { maxLen = 64, allowSpaces = true } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('Empty parameter');
  }

  const normalized = raw.normalize('NFKC');
  const pattern = allowSpaces ? /^[a-zA-Z0-9_\- .:@]+$/ : /^[a-zA-Z0-9_\-.:@]+$/;
  if (!pattern.test(normalized)) {
    throw new Error('Parameter contains unsupported characters');
  }

  if (normalized.length > maxLen) {
    throw new Error(`Parameter too long (max ${maxLen})`);
  }

  return normalized;
}

function parseCommandArgs(text) {
  const body = String(text || '').trim();
  const [first, ...rest] = body.split(/\s+/);
  return {
    command: first || '',
    args: rest
  };
}

async function fetchUsersByRole(role) {
  const sql = `
    SELECT id, username, role
    FROM users
    WHERE role = $1
    ORDER BY id DESC
    LIMIT 10
  `;
  const result = await pool.query(sql, [role]);
  return result.rows;
}

async function fetchOrdersByStatus(status, limit) {
  const sql = `
    SELECT id, user_id, status, total_amount
    FROM orders
    WHERE status = $1
    ORDER BY id DESC
    LIMIT $2
  `;
  const result = await pool.query(sql, [status, limit]);
  return result.rows;
}

async function fetchProductBySku(sku) {
  const sql = `
    SELECT id, sku, name, price
    FROM products
    WHERE sku = $1
    LIMIT 1
  `;
  const result = await pool.query(sql, [sku]);
  return result.rows[0] || null;
}

function formatRows(rows) {
  if (!rows || rows.length === 0) {
    return 'No records found.';
  }

  return rows.map((row) => JSON.stringify(row)).join('\n');
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    [
      'Welcome. Available commands:',
      `${BOT_COMMAND_PREFIX}user_by_role <role>`,
      `${BOT_COMMAND_PREFIX}orders_by_status <status> <limit>`,
      `${BOT_COMMAND_PREFIX}product_by_sku <sku>`
    ].join('\n')
  );
});

bot.help((ctx) => {
  ctx.reply(
    [
      'Commands:',
      `${BOT_COMMAND_PREFIX}user_by_role admin`,
      `${BOT_COMMAND_PREFIX}orders_by_status paid 5`,
      `${BOT_COMMAND_PREFIX}product_by_sku ABC-123`
    ].join('\n')
  );
});

bot.on('text', async (ctx) => {
  try {
    const { command, args } = parseCommandArgs(ctx.message.text);

    if (command === `${BOT_COMMAND_PREFIX}user_by_role`) {
      const role = sanitizeTextParam(args[0], { maxLen: 32, allowSpaces: false });
      const rows = await fetchUsersByRole(role);
      await ctx.reply(formatRows(rows));
      return;
    }

    if (command === `${BOT_COMMAND_PREFIX}orders_by_status`) {
      const status = sanitizeTextParam(args[0], { maxLen: 32, allowSpaces: false });
      const limitRaw = sanitizeTextParam(args[1], { maxLen: 3, allowSpaces: false });
      const limit = Number(limitRaw);

      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('Limit must be an integer between 1 and 50');
      }

      const rows = await fetchOrdersByStatus(status, limit);
      await ctx.reply(formatRows(rows));
      return;
    }

    if (command === `${BOT_COMMAND_PREFIX}product_by_sku`) {
      const sku = sanitizeTextParam(args[0], { maxLen: 40, allowSpaces: false });
      const product = await fetchProductBySku(sku);
      await ctx.reply(product ? JSON.stringify(product) : 'No records found.');
      return;
    }

    await ctx.reply('Unknown command. Use /help.');
  } catch (error) {
    await ctx.reply(`Error: ${error.message}`);
  }
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  bot.stop(signal);
  await pool.end();
  process.exit(0);
}

process.once('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    console.error('Shutdown failed', err);
    process.exit(1);
  });
});

process.once('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    console.error('Shutdown failed', err);
    process.exit(1);
  });
});

bot.launch().then(() => {
  console.log('Telegram bot started.');
});
