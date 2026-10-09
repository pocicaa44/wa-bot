const readline = require('readline');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const sharp = require('sharp');
const WebP = require('node-webpmux');
const qrcode = require('qrcode-terminal');
const {
  parseVStickerCommand,
  handleVSticker,
  handleStaticStickerFromVideo
} = require('./lib/videoSticker');
const {
  initSeenJids,
  isFirstTimeFromJid,
  archiveChat,
  deleteMediaBatch,
  resetAppStateWarning
} = require('./lib/chatHygiene');

if (!fs.existsSync('./tmp')) {
  fs.mkdirSync('./tmp', { recursive: true });
}

const config = {
  authMethod: process.env.AUTH_METHOD || '',
  phoneNumber: process.env.PHONE_NUMBER || '',
  sessionDir: './auth_info',
  stickerQuality: 80,
  stickerSize: 512,
  packName: process.env.PACK_NAME || 'smone',
  packPublisher: process.env.PACK_PUBLISHER || '@imagoodppl',
  maxChatsPerMinute: Number(process.env.MAX_CHATS_PER_MINUTE) || 20
};

const helpMessage = `*dwnBOT*
- *.sticker* : kirim gambar/video atau balas media dengan *.sticker* untuk stiker statis
- *.vsticker* : balas video dengan *.vsticker* [detik] untuk stiker video
- *.help* : tampilkan menu bantuan
- *.status* : tampilkan status bot`;

const fallbackMessage = 'Maaf saya tidak mengerti, gunakan .help untuk melihat bantuan.';

const logger = pino({ level: 'silent' });
let chosenAuthMethod = config.authMethod;
let chosenPhoneNumber = '';
let pairingRequested = false;

const messageQueue = [];
let isProcessingQueue = false;
const processedTimestamps = [];

function checkRateLimit() {
  const now = Date.now();
  const windowStart = now - 60000;
  while (processedTimestamps.length > 0 && processedTimestamps[0] <= windowStart) {
    processedTimestamps.shift();
  }
  if (processedTimestamps.length >= config.maxChatsPerMinute) {
    return false;
  }
  processedTimestamps.push(now);
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function simulateTyping(sock, jid, minMs = 1000, maxMs = 2500) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(getRandomDelay(minMs, maxMs));
    await sock.sendPresenceUpdate('paused', jid);
  } catch {
    // non-fatal
  }
}

async function markAsRead(sock, keys) {
  try {
    await sock.readMessages(keys);
  } catch {
    // non-fatal
  }
}

async function processQueue(sock) {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    try {
      await handleMessage(sock, msg);
    } catch (err) {
      console.error('Error handling message:', err.message);
    }
  }

  isProcessingQueue = false;
}

function unwrapMessage(msg) {
  if (!msg) return null;
  if (msg.ephemeralMessage) return unwrapMessage(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage) return unwrapMessage(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2) return unwrapMessage(msg.viewOnceMessageV2.message);
  if (msg.documentWithCaptionMessage) return unwrapMessage(msg.documentWithCaptionMessage.message);
  return msg;
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const content = unwrapMessage(msg.message);
  if (!content) return;

  const jid = msg.key.remoteJid;
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;

  if (!checkRateLimit()) {
    console.log(`[RateLimit] Batas ${config.maxChatsPerMinute} chat/menit tercapai. Pesan ${msg.key.id} diabaikan.`);
    return;
  }

  await markAsRead(sock, [msg.key]);

  if (!msg.key.fromMe && jid.endsWith('@s.whatsapp.net')) {
    const isFirst = await isFirstTimeFromJid(jid);
    if (isFirst) {
      await archiveChat(sock, jid, msg);
    }
  }

  const rawText = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '';
  const text = rawText.trim().toLowerCase();
  const isStickerCommand = text === '.sticker' || text === '.stiker';
  const isVStickerCommand = text.startsWith('.vsticker');

  const quotedContent = unwrapMessage(content.extendedTextMessage?.contextInfo?.quotedMessage);
  const targetVideoMsg = quotedContent?.videoMessage || content.videoMessage;
  const targetImageMsg = content.imageMessage || quotedContent?.imageMessage;

  if (isVStickerCommand) {
    const parsed = parseVStickerCommand(rawText);
    if (!parsed.valid) {
      await sock.sendMessage(jid, { text: parsed.error }, { quoted: msg });
      return;
    }

    const quotedMedia = quotedContent || (content.videoMessage || content.imageMessage ? content : null);
    if (!quotedMedia) {
      await sock.sendMessage(jid, { text: '❌ Balas sebuah video dengan .vsticker' }, { quoted: msg });
      return;
    }

    try {
      const sentMedia = await handleVSticker(sock, msg, jid, quotedMedia, parsed.duration, parsed.warning);
      if (sentMedia) {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedMediaKey = contextInfo?.stanzaId ? {
          remoteJid: jid,
          fromMe: contextInfo.participant === sock.user?.id,
          id: contextInfo.stanzaId,
          participant: contextInfo.participant
        } : null;
        const keysToDelete = [msg.key, quotedMediaKey, sentMedia?.key].filter(Boolean);
        await deleteMediaBatch(sock, jid, keysToDelete);
      }
    } catch (err) {
      console.error('[vsticker] Error tidak terduga pada handleVSticker:', err.message);
    }
    return;
  }

  if (isStickerCommand) {
    if (targetVideoMsg) {
      try {
        const sentMedia = await handleStaticStickerFromVideo(sock, msg, jid, quotedContent || (content.videoMessage ? content : null));
        if (sentMedia) {
          const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
          const quotedMediaKey = contextInfo?.stanzaId ? {
            remoteJid: jid,
            fromMe: contextInfo.participant === sock.user?.id,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant
          } : null;
          const keysToDelete = [msg.key, quotedMediaKey, sentMedia?.key].filter(Boolean);
          await deleteMediaBatch(sock, jid, keysToDelete);
        }
      } catch (err) {
        console.error('[vsticker] Error tidak terduga pada handleStaticStickerFromVideo:', err.message);
      }
      return;
    }

    if (targetImageMsg) {
      try {
        const downloadTarget = content.imageMessage
          ? { key: msg.key, message: { imageMessage: content.imageMessage } }
          : {
              key: {
                remoteJid: jid,
                id: content.extendedTextMessage?.contextInfo?.stanzaId,
                participant: content.extendedTextMessage?.contextInfo?.participant
              },
              message: { imageMessage: quotedContent.imageMessage }
            };

        const buffer = await downloadMediaMessage(
          downloadTarget,
          'buffer',
          {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );
        const sticker = await convertToSticker(buffer);

        await simulateTyping(sock, jid, 1500, 2500);
        const sentMsg = await sock.sendMessage(jid, { sticker });

        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedMediaKey = contextInfo?.stanzaId ? {
          remoteJid: jid,
          fromMe: contextInfo.participant === sock.user?.id,
          id: contextInfo.stanzaId,
          participant: contextInfo.participant
        } : (downloadTarget.key && downloadTarget.key.id !== msg.key?.id ? downloadTarget.key : null);

        const keysToDelete = [msg.key, quotedMediaKey, sentMsg?.key].filter(Boolean);
        await deleteMediaBatch(sock, jid, keysToDelete);
      } catch (err) {
        console.error('Failed to create sticker:', err.message);
        try {
          await simulateTyping(sock, jid, 500, 1000);
          await sock.sendMessage(jid, { text: 'failed' }, { quoted: msg });
        } catch (sendErr) {
          console.error('Failed to send error notification:', sendErr.message);
        }
      }
      return;
    }

    await sock.sendMessage(
      jid,
      { text: '❌ Balas sebuah video atau gambar dengan perintah ini.' },
      { quoted: msg }
    );
    return;
  }

  if (content.imageMessage) {
    try {
      await simulateTyping(sock, jid, 800, 1500);
      await sock.sendMessage(jid, { text: 'Kirim gambar dengan caption .sticker untuk membuat stiker, atau gunakan .help untuk melihat bantuan.' }, { quoted: msg });
    } catch (err) {
      console.error('Failed to send image fallback reply:', err.message);
    }
    return;
  }

  if (text === '.help') {
    try {
      await simulateTyping(sock, jid, 800, 1500);
      await sock.sendMessage(jid, { text: helpMessage }, { quoted: msg });
    } catch (err) {
      console.error('Failed to send help reply:', err.message);
    }
    return;
  }

  if (text === '.status') {
    try {
      await simulateTyping(sock, jid, 500, 1000);
      await sock.sendMessage(jid, { text: 'ready' }, { quoted: msg });
    } catch (err) {
      console.error('Failed to send status reply:', err.message);
    }
    return;
  }

  if (rawText) {
    try {
      await simulateTyping(sock, jid, 800, 1500);
      await sock.sendMessage(jid, { text: fallbackMessage }, { quoted: msg });
    } catch (err) {
      console.error('Failed to send fallback reply:', err.message);
    }
  }
}

async function addStickerMetadata(webpBuffer) {
  const metadata = {
    'sticker-pack-name': config.packName,
    'sticker-pack-publisher': config.packPublisher
  };
  const data = JSON.stringify(metadata);
  const exif = Buffer.concat([
    Buffer.from([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x16, 0x00, 0x00, 0x00
    ]),
    Buffer.from(data, 'utf-8')
  ]);
  exif.writeUIntLE(Buffer.byteLength(data, 'utf-8'), 14, 4);

  const img = new WebP.Image();
  await img.load(webpBuffer);
  img.exif = exif;
  return img.save(null);
}

async function convertToSticker(buffer) {
  const webpBuffer = await sharp(buffer)
    .rotate()
    .resize(config.stickerSize, config.stickerSize, {
      fit: 'fill'
    })
    .webp({ quality: config.stickerQuality })
    .toBuffer();

  return addStickerMetadata(webpBuffer);
}

async function prompt(questionText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(questionText, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function selectAuthMethod() {
  if (chosenAuthMethod) return chosenAuthMethod;
  const choice = await prompt('Link device via [1] QR Code (default) or [2] Pairing Code: ');
  chosenAuthMethod = choice === '2' ? 'pairing' : 'qr';
  return chosenAuthMethod;
}

async function getPhoneNumber() {
  if (chosenPhoneNumber) return chosenPhoneNumber;
  if (config.phoneNumber) {
    chosenPhoneNumber = config.phoneNumber;
    return chosenPhoneNumber;
  }

  const raw = await prompt('Enter WhatsApp phone number with country code (e.g. 628123456789): ');
  let clean = raw.replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) {
    clean = '62' + clean.slice(1);
  }
  chosenPhoneNumber = clean;
  return chosenPhoneNumber;
}

let isCleaned = false;

async function startBot() {
  if (!isCleaned && (process.argv.includes('--clean') || process.argv.includes('--reset'))) {
    isCleaned = true;
    if (fs.existsSync(config.sessionDir)) {
      fs.rmSync(config.sessionDir, { recursive: true, force: true });
      console.log(`[Auth] Direktori sesi ${config.sessionDir} berhasil dibersihkan.`);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);

  if (!state.creds.me?.id && state.creds.signalIdentities?.[0]?.identifier?.name) {
    state.creds.me = { id: state.creds.signalIdentities[0].identifier.name };
    await saveCreds();
  }

  const isLinked = Boolean(state.creds.registered || state.creds.account);

  if (!isLinked) {
    if (state.creds.me && !state.creds.account && !state.creds.registered) {
      delete state.creds.me;
      delete state.creds.pairingCode;
      await saveCreds();
    }
    if (!chosenAuthMethod) {
      await selectAuthMethod();
    }
    if (chosenAuthMethod === 'pairing' && !chosenPhoneNumber) {
      await getPhoneNumber();
    }
  }

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    shouldSyncHistoryMessage: () => true
  });

  let appStateResyncTimeout = null;
  let appStateRetryInterval = null;
  let appStateDiagnosticTimeout = null;

  sock.ev.on('creds.update', (update) => {
    Object.assign(state.creds, update);
    saveCreds();
    if (update.myAppStateKeyId) {
      resetAppStateWarning();
      if (appStateRetryInterval) {
        clearInterval(appStateRetryInterval);
        appStateRetryInterval = null;
      }
      console.log(`[Privacy] Sukses! myAppStateKeyId berhasil disinkronkan dari WhatsApp.`);
    }
  });

  if (!isLinked && chosenAuthMethod === 'pairing' && chosenPhoneNumber && !pairingRequested) {
    pairingRequested = true;
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(chosenPhoneNumber);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log(`Pairing code: ${formatted}`);
      } catch (err) {
        console.error('Failed to request pairing code:', err.message);
        pairingRequested = false;
      }
    }, 3000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !isLinked && chosenAuthMethod === 'qr') {
      console.log('Scan the QR code below:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      pairingRequested = false;
      if (appStateResyncTimeout) clearTimeout(appStateResyncTimeout);
      if (appStateRetryInterval) clearInterval(appStateRetryInterval);
      if (appStateDiagnosticTimeout) clearTimeout(appStateDiagnosticTimeout);

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed (status: ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        if (isRestartRequired) {
          startBot();
        } else {
          setTimeout(startBot, 3000);
        }
      }
    } else if (connection === 'open') {
      pairingRequested = false;
      console.log('Bot connected successfully.');
      if (typeof sock.cleanDirtyBits === 'function') {
        sock.cleanDirtyBits('account_sync').catch(() => {});
      }

      await initSeenJids();

      appStateResyncTimeout = setTimeout(async () => {
        try {
          console.log('[Privacy] Memicu resync app state...');
          await sock.resyncAppState(['regular', 'critical_block', 'critical_unblock_low'], true);
          console.log('[Privacy] Resync selesai. myAppStateKeyId:', sock.authState?.creds?.myAppStateKeyId ? 'ADA' : 'BELUM ADA');
        } catch (err) {
          console.warn('[Privacy] Resync gagal:', err.message);
        }
      }, 10000);

      setTimeout(() => {
        if (!sock.authState?.creds?.myAppStateKeyId) {
          let retryCount = 0;
          appStateRetryInterval = setInterval(async () => {
            if (sock.authState?.creds?.myAppStateKeyId || retryCount >= 5) {
              clearInterval(appStateRetryInterval);
              appStateRetryInterval = null;
              return;
            }
            retryCount++;
            try {
              console.log(`[Privacy] Retry resync app state #${retryCount}...`);
              await sock.resyncAppState(['regular', 'critical_block', 'critical_unblock_low'], true);
              if (sock.authState?.creds?.myAppStateKeyId) {
                console.log('[Privacy] Resync berhasil setelah retry. myAppStateKeyId: ADA');
                clearInterval(appStateRetryInterval);
                appStateRetryInterval = null;
              }
            } catch (err) {
              console.warn(`[Privacy] Retry resync #${retryCount} gagal:`, err.message);
            }
          }, 60000);
        }
      }, 30000);

      appStateDiagnosticTimeout = setTimeout(() => {
        if (!sock.authState?.creds?.myAppStateKeyId) {
          console.warn('[Privacy] myAppStateKeyId masih kosong setelah 60 detik.');
          console.warn('[Privacy] Saran: buka WhatsApp di HP utama, kirim pesan ke diri sendiri, lalu tunggu 1-2 menit.');
        }
      }, 60000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      messageQueue.push(msg);
    }
    processQueue(sock);
  });
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message || err);
});

startBot().catch((err) => {
  console.error('Fatal initialization error:', err.message);
});
