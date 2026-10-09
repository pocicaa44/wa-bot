/**
 * Modul kebersihan chat: auto-archive first contact, auto-delete media.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const SEEN_JIDS_FILE = path.join(DATA_DIR, 'seen_jids.json');

let seenJids = new Map();
let warnedAboutAppState = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function isExcludedJid(jid) {
  if (!jid || typeof jid !== 'string') return true;
  return jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@broadcast');
}

/**
 * Memuat data seen_jids.json ke dalam memory Map.
 *
 * @returns {Promise<void>}
 */
async function initSeenJids() {
  try {
    if (!fsSync.existsSync(DATA_DIR)) {
      await fs.mkdir(DATA_DIR, { recursive: true });
    }

    if (fsSync.existsSync(SEEN_JIDS_FILE)) {
      const raw = await fs.readFile(SEEN_JIDS_FILE, 'utf8');
      const data = JSON.parse(raw);
      seenJids = new Map(Object.entries(data));
    } else {
      seenJids = new Map();
    }
  } catch (err) {
    console.error('[Privacy] Gagal memuat seen_jids.json:', err.message);
    seenJids = new Map();
  }
}

/**
 * Menyimpan data memory Map ke file seen_jids.json.
 *
 * @returns {Promise<void>}
 */
async function saveSeenJids() {
  try {
    if (!fsSync.existsSync(DATA_DIR)) {
      await fs.mkdir(DATA_DIR, { recursive: true });
    }
    const obj = Object.fromEntries(seenJids);
    await fs.writeFile(SEEN_JIDS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[Privacy] Gagal menyimpan seen_jids.json:', err.message);
  }
}

/**
 * Menandai JID sebagai sudah pernah dilihat.
 *
 * @param {string} jid - Remote JID kontak WhatsApp.
 * @returns {Promise<void>}
 */
async function markJidAsSeen(jid) {
  if (isExcludedJid(jid)) return;
  seenJids.set(jid, Date.now());
  await saveSeenJids();
}

/**
 * Mengecek apakah pesan ini merupakan kontak pertama dari JID.
 *
 * @param {string} jid - Remote JID kontak WhatsApp.
 * @returns {Promise<boolean>}
 */
async function isFirstTimeFromJid(jid) {
  if (isExcludedJid(jid)) return false;

  if (!seenJids.has(jid)) {
    seenJids.set(jid, Date.now());
    await saveSeenJids();
    return true;
  }

  return false;
}

/**
 * Mengarsipkan obrolan untuk JID tertentu (hanya jika app state sync tersedia).
 *
 * @param {Object} sock - Instance Baileys WhatsApp socket.
 * @param {string} jid - Remote JID kontak.
 * @param {Object|boolean} [lastMsgOrSilent=null] - Objek pesan terakhir atau boolean silent.
 * @param {boolean} [silent=false] - Apakah log berhasil disenyapkan.
 * @returns {Promise<void>}
 */
async function archiveChat(sock, jid, lastMsgOrSilent = null, silent = false) {
  if (isExcludedJid(jid)) return;

  let lastMsg = null;
  let isSilent = silent;
  if (typeof lastMsgOrSilent === 'boolean') {
    isSilent = lastMsgOrSilent;
  } else if (lastMsgOrSilent && typeof lastMsgOrSilent === 'object') {
    lastMsg = lastMsgOrSilent;
  }

  try {
    if (!sock.authState?.creds?.myAppStateKeyId) {
      if (!warnedAboutAppState) {
        console.log('[Privacy] Fitur auto-archive & delete-for-me dinonaktifkan: myAppStateKeyId tidak disediakan WhatsApp untuk sesi ini.');
        warnedAboutAppState = true;
      }
      return;
    }

    await sleep(getRandomDelay(500, 1500));

    const timestamp = lastMsg?.messageTimestamp
      ? Number(lastMsg.messageTimestamp)
      : Math.floor(Date.now() / 1000);

    const lastMessages = lastMsg?.key
      ? [
          {
            key: lastMsg.key,
            messageTimestamp: timestamp
          }
        ]
      : [];

    await sock.chatModify(
      {
        archive: true,
        ...(lastMessages.length > 0 ? { lastMessages } : {})
      },
      jid
    );

    if (!isSilent) {
      console.log(`[Privacy] Berhasil mengarsipkan chat ${jid}`);
    }
  } catch (err) {
    if (!isSilent) {
      console.error('Failed to auto-archive chat:', err.message);
    }
  }
}

/**
 * Menghapus pesan tertentu untuk diri sendiri (delete for me).
 *
 * @param {Object} sock - Instance Baileys WhatsApp socket.
 * @param {string} jid - Remote JID obrolan.
 * @param {Object} messageKey - Objek pesan atau key pesan WhatsApp.
 * @returns {Promise<void>}
 */
async function deleteMessageForMe(sock, jid, messageKey) {
  if (isExcludedJid(jid)) return;

  try {
    if (!sock.authState?.creds?.myAppStateKeyId) {
      if (!warnedAboutAppState) {
        console.log('[Privacy] Fitur auto-archive & delete-for-me dinonaktifkan: myAppStateKeyId tidak disediakan WhatsApp untuk sesi ini.');
        warnedAboutAppState = true;
      }
      return;
    }

    const key = messageKey?.key || messageKey;
    if (!key || !key.id) return;

    const timestamp = messageKey?.messageTimestamp
      ? Number(messageKey.messageTimestamp)
      : Math.floor(Date.now() / 1000);

    await sock.chatModify(
      {
        deleteForMe: {
          key: {
            remoteJid: jid,
            id: key.id,
            fromMe: Boolean(key.fromMe),
            participant: key.participant
          },
          timestamp,
          deleteMedia: true
        }
      },
      jid
    );

    console.log(`[Privacy] Berhasil menghapus pesan ${key.id} (fromMe: ${Boolean(key.fromMe)}) untuk bot`);
  } catch (err) {
    console.error('Failed to auto-delete message for me:', err.message);
  }
}

/**
 * Menghapus sekumpulan pesan media dari chat secara berurutan dengan jeda waktu.
 *
 * @param {Object} sock - Instance Baileys WhatsApp socket.
 * @param {string} jid - Remote JID obrolan.
 * @param {Array<Object>} keys - Kumpulan key pesan yang akan dihapus.
 * @returns {Promise<void>}
 */
async function deleteMediaBatch(sock, jid, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return;

  const seenIds = new Set();
  const uniqueKeys = [];
  for (const item of keys) {
    const key = item?.key || item;
    if (key && key.id && !seenIds.has(key.id)) {
      seenIds.add(key.id);
      uniqueKeys.push(key);
    }
  }

  for (const key of uniqueKeys) {
    await deleteMessageForMe(sock, jid, key);
    await sleep(getRandomDelay(300, 1000));
  }
}

/**
 * Mereset indikator peringatan app state jika key berhasil disinkronkan.
 */
function resetAppStateWarning() {
  warnedAboutAppState = false;
}

module.exports = {
  initSeenJids,
  isFirstTimeFromJid,
  markJidAsSeen,
  archiveChat,
  deleteMessageForMe,
  deleteMediaBatch,
  resetAppStateWarning
};
