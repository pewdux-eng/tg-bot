const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const execAsync = promisify(exec);

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN not set!'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
const TEMP_DIR = path.join(os.tmpdir(), 'tg-bot');
const MAX_SIZE_MB = 14.5;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Store conversation state per user: { url, startSec }
const userState = {};

console.log('🤖 Telegram bot started!');

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTime(s) {
    if (!s) return null;
    s = s.trim().replace(/\./g, ':');
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN) || parts.length < 2) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1];
}

function secondsToDisplay(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
}

function extractYouTubeUrl(text) {
    // Handles: youtu.be, youtube.com/watch, youtube.com/live, youtube.com/shorts
    const match = text.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|live\/|shorts\/)|youtu\.be\/)([\w-]+)(?:[^\s]*)?/);
    return match ? match[0] : null;
}

function extractTime(text) {
    // Extract first time pattern from a line: dots or colons
    const match = text.match(/\d{1,2}[.:]\d{2}(?:[.:]\d{2})?/);
    return match ? match[0] : null;
}

function isTimeOnly(text) {
    // True if the message is just a timestamp (possibly with "To" prefix)
    const cleaned = text.trim().replace(/^to\s*/i, '');
    return /^\d{1,2}[.:]\d{2}(?:[.:]\d{2})?$/.test(cleaned);
}

// ── Compression ───────────────────────────────────────────────────────────────

async function compressAudio(inputPath, startSec, duration, outputPath) {
    const bitrates = [128, 96, 80, 64, 48, 40, 32, 24];
    const estimatedBitrate = Math.floor((MAX_SIZE_MB * 8 * 1024) / duration);
    const startBitrate = bitrates.find(b => b <= estimatedBitrate) || 24;
    const toTry = bitrates.slice(bitrates.indexOf(startBitrate));

    for (const bitrate of toTry) {
        await execAsync(`ffmpeg -y -i "${inputPath}" -ss ${startSec} -t ${duration} -ar 22050 -ac 1 -b:a ${bitrate}k "${outputPath}"`);
        const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
        if (sizeMB <= MAX_SIZE_MB) return sizeMB;
    }

    await execAsync(`ffmpeg -y -i "${inputPath}" -ss ${startSec} -t ${duration} -ar 16000 -ac 1 -b:a 24k "${outputPath}"`);
    const finalSize = fs.statSync(outputPath).size / (1024 * 1024);
    if (finalSize > MAX_SIZE_MB) throw new Error('Clip too long — try a shorter range.');
    return finalSize;
}

// ── Process and send clip ─────────────────────────────────────────────────────

async function processAndSend(chatId, url, startSec, endSec) {
    const duration = endSec - startSec;
    const id = Date.now();
    const rawPath = path.join(TEMP_DIR, `raw_${id}.mp3`);
    const outPath = path.join(TEMP_DIR, `clip_${id}.mp3`);

    const statusMsg = await bot.sendMessage(chatId, '⏳ Downloading audio...');

    try {
        await execAsync(`yt-dlp -x --audio-format mp3 -f bestaudio --audio-quality 0 -o "${rawPath}" "${url}"`, { timeout: 300000 });
        if (!fs.existsSync(rawPath)) throw new Error('Download failed.');

        await bot.editMessageText('✂️ Trimming and compressing...', { chat_id: chatId, message_id: statusMsg.message_id });

        const sizeMB = await compressAudio(rawPath, startSec, duration, outPath);
        try { fs.unlinkSync(rawPath); } catch (_) {}

        await bot.editMessageText(`📤 Sending clip (${sizeMB.toFixed(1)} MB)...`, { chat_id: chatId, message_id: statusMsg.message_id });

        await bot.sendAudio(chatId, outPath, {
            caption: `🎵 ${secondsToDisplay(startSec)} → ${secondsToDisplay(endSec)}`,
            title: 'Audio Clip',
            performer: 'YT Audio Cutter'
        });

        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        try { fs.unlinkSync(outPath); } catch (_) {}

    } catch (err) {
        try { fs.unlinkSync(rawPath); } catch (_) {}
        try { fs.unlinkSync(outPath); } catch (_) {}

        let userMsg = '❌ Something went wrong. Please try again.';
        if (err.message.includes('Sign in to confirm')) userMsg = '❌ YouTube blocked the download. Try again in a few minutes.';
        else if (err.message.includes('Video unavailable')) userMsg = '❌ This video is unavailable or private.';
        else if (err.message.includes('too long')) userMsg = '❌ Clip too long to compress under 15MB. Try a shorter range.';

        await bot.editMessageText(userMsg, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() =>
            bot.sendMessage(chatId, userMsg)
        );
    }
}

// ── Message handler ───────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || msg.caption || '').trim();

    if (!text) return;

    // Help
    if (text === '/start' || text === '/help') {
        userState[chatId] = null;
        return bot.sendMessage(chatId,
            '🎵 *YT Audio Cutter*\n\n' +
            'Send me messages one by one:\n\n' +
            '*1.* YouTube link\n' +
            '*2.* Start time (e.g. `29.25`)\n' +
            '*3.* End time (e.g. `1.12.03`)\n\n' +
            'Or send them all in one message:\n' +
            '`https://youtu.be/xxxx\n29.25\nTo\n1.12.03`\n\n' +
            'Type /cancel to start over.',
            { parse_mode: 'Markdown' }
        );
    }

    if (text === '/cancel') {
        userState[chatId] = null;
        return bot.sendMessage(chatId, '🔄 Cancelled. Send a YouTube link to start again.');
    }

    const state = userState[chatId] || {};

    // ── Step 1: Check if this message contains a full request ─────────────────
    const url = extractYouTubeUrl(text);
    const timePattern = /\d{1,2}[.:]\d{2}(?:[.:]\d{2})?/g;
    const allTimes = [...text.matchAll(timePattern)];

    if (url && allTimes.length >= 2) {
        // Full message with URL + 2 times — process immediately
        const startSec = parseTime(allTimes[0][0]);
        const endSec = parseTime(allTimes[allTimes.length - 1][0]);
        if (startSec !== null && endSec !== null && endSec > startSec) {
            userState[chatId] = null;
            return processAndSend(chatId, url, startSec, endSec);
        }
    }

    // ── Step 2: Stateful flow — collect URL, start, end separately ────────────

    // If message has a YouTube URL → save it, ask for start time
    if (url) {
        userState[chatId] = { url };
        return bot.sendMessage(chatId, '✅ Got the link! Now send the *start time*:', { parse_mode: 'Markdown' });
    }

    // If we have a URL saved and this looks like a time
    if (state.url) {
        const timeStr = extractTime(text.replace(/^to\s*/i, ''));
        const timeSec = parseTime(timeStr);

        if (timeSec === null) {
            return bot.sendMessage(chatId, '⚠️ That doesn\'t look like a time. Send something like `29.25` or `1.12.03`', { parse_mode: 'Markdown' });
        }

        if (!state.startSec && state.startSec !== 0) {
            // Save start time, ask for end
            userState[chatId] = { url: state.url, startSec: timeSec };
            return bot.sendMessage(chatId, `✅ Start: *${secondsToDisplay(timeSec)}* — now send the *end time*:`, { parse_mode: 'Markdown' });
        } else {
            // Have start — this is the end time
            const endSec = timeSec;
            if (endSec <= state.startSec) {
                return bot.sendMessage(chatId, '⚠️ End time must be after start time. Send the end time again:');
            }
            userState[chatId] = null;
            return processAndSend(chatId, state.url, state.startSec, endSec);
        }
    }

    // No context — prompt them
    bot.sendMessage(chatId, 'Send me a YouTube link to get started. Type /help for instructions.');
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// Keep-alive for Render
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('OK')).listen(PORT, () => {
    console.log(`✅ Bot running, keep-alive on port ${PORT}`);
});
