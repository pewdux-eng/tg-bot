const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const execAsync = promisify(exec);

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set!');
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const TEMP_DIR = path.join(os.tmpdir(), 'tg-bot');
const MAX_SIZE_MB = 14.5;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

console.log('🤖 Telegram bot started!');

// ── Time parsing ──────────────────────────────────────────────────────────────
// Handles: 29.25 / 1.12.03 / 29:25 / 1:12:03

function parseTime(s) {
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

// ── Extract YouTube URL ───────────────────────────────────────────────────────

function extractYouTubeUrl(text) {
    const match = text.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?[^\s]*v=|youtu\.be\/)([\w-]+)(?:[^\s]*)?/);
    return match ? match[0] : null;
}

// ── Parse message for start/end time ─────────────────────────────────────────
// Expects format:
//   https://youtu.be/xxxx
//   29.25
//   To
//   1.12.03

function parseMessage(text) {
    const url = extractYouTubeUrl(text);
    if (!url) return null;

    // Find all time-like patterns (dots or colons)
    const timePattern = /(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?/g;
    const matches = [...text.matchAll(timePattern)];
    if (matches.length < 2) return null;

    const startSec = parseTime(matches[0][0]);
    const endSec = parseTime(matches[matches.length - 1][0]);

    if (startSec === null || endSec === null || endSec <= startSec) return null;

    return { url, startSec, endSec };
}

// ── Compress audio ────────────────────────────────────────────────────────────

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

    // Last resort
    await execAsync(`ffmpeg -y -i "${inputPath}" -ss ${startSec} -t ${duration} -ar 16000 -ac 1 -b:a 24k "${outputPath}"`);
    const finalSize = fs.statSync(outputPath).size / (1024 * 1024);
    if (finalSize > MAX_SIZE_MB) throw new Error('Clip too long — try a shorter range.');
    return finalSize;
}

// ── Handle messages ───────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Help message
    if (text === '/start' || text === '/help') {
        return bot.sendMessage(chatId,
            '🎵 *YT Audio Cutter*\n\n' +
            'Send me a YouTube link with start and end times:\n\n' +
            '`https://youtu.be/xxxx\n29.25\nTo\n1.12.03`\n\n' +
            'Dots or colons both work:\n' +
            '`29.25` or `29:25`\n' +
            '`1.12.03` or `1:12:03`\n\n' +
            "I'll send back a compressed MP3 under 15MB ✅",
            { parse_mode: 'Markdown' }
        );
    }

    const parsed = parseMessage(text);
    if (!parsed) {
        // Only reply if message looks like an attempt
        const hasYT = /youtube\.com|youtu\.be/.test(text);
        const hasTime = /\d{1,2}[.:]\d{2}/.test(text);
        if (!hasYT && !hasTime) return; // Ignore unrelated messages

        return bot.sendMessage(chatId,
            '❌ Could not parse your message.\n\n' +
            'Send it like this:\n\n' +
            '`https://youtu.be/xxxx\n29.25\nTo\n1.12.03`',
            { parse_mode: 'Markdown' }
        );
    }

    const { url, startSec, endSec } = parsed;
    const duration = endSec - startSec;
    const id = Date.now();
    const rawPath = path.join(TEMP_DIR, `raw_${id}.mp3`);
    const outPath = path.join(TEMP_DIR, `clip_${id}.mp3`);

    const statusMsg = await bot.sendMessage(chatId, '⏳ Downloading audio...');

    try {
        // Download
        await execAsync(`yt-dlp -x --audio-format mp3 -f bestaudio --audio-quality 0 -o "${rawPath}" "${url}"`, { timeout: 300000 });

        if (!fs.existsSync(rawPath)) throw new Error('Download failed.');

        await bot.editMessageText('✂️ Trimming and compressing...', { chat_id: chatId, message_id: statusMsg.message_id });

        // Trim + compress
        const sizeMB = await compressAudio(rawPath, startSec, duration, outPath);
        try { fs.unlinkSync(rawPath); } catch (_) {}

        await bot.editMessageText(`📤 Sending clip (${sizeMB.toFixed(1)} MB)...`, { chat_id: chatId, message_id: statusMsg.message_id });

        // Send audio
        await bot.sendAudio(chatId, outPath, {
            caption: `🎵 ${secondsToDisplay(startSec)} → ${secondsToDisplay(endSec)}`,
            title: 'Audio Clip',
            performer: 'YT Audio Cutter'
        });

        await bot.deleteMessage(chatId, statusMsg.message_id);
        try { fs.unlinkSync(outPath); } catch (_) {}

    } catch (err) {
        try { fs.unlinkSync(rawPath); } catch (_) {}
        try { fs.unlinkSync(outPath); } catch (_) {}

        let userMsg = '❌ Something went wrong.';
        if (err.message.includes('Sign in to confirm')) {
            userMsg = '❌ YouTube blocked the download. Please try again in a few minutes.';
        } else if (err.message.includes('Video unavailable')) {
            userMsg = '❌ This video is unavailable or private.';
        } else if (err.message.includes('too long')) {
            userMsg = '❌ Clip too long to compress under 15MB. Try a shorter range.';
        }

        await bot.editMessageText(userMsg, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() =>
            bot.sendMessage(chatId, userMsg)
        );
    }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// Keep-alive for Render (prevent sleep)
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('OK')).listen(PORT, () => {
    console.log(`✅ Keep-alive server on port ${PORT}`);
});
