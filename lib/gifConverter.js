const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pino = require('pino');
const {
  downloadMediaMessage,
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');

const TMP_DIR = path.resolve(__dirname, '../tmp');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const FFMPEG_PATH = process.env.FFMPEG_PATH || (
  fs.existsSync('/data/data/com.termux/files/usr/bin/ffmpeg')
    ? '/data/data/com.termux/files/usr/bin/ffmpeg'
    : 'ffmpeg'
);

const logger = pino({ level: 'silent' });
const activeJidLocks = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Ekstraksi objek videoMessage dari struktur pesan WhatsApp atau quotedMessage.
 *
 * @param {Object} quotedMsg - Objek pesan yang dibalas (quoted).
 * @returns {Object|null} Objek videoMessage atau null jika bukan video.
 */
function extractVideoMessage(quotedMsg) {
  if (!quotedMsg) return null;

  let unwrapped = quotedMsg;
  while (
    unwrapped?.ephemeralMessage?.message ||
    unwrapped?.viewOnceMessage?.message ||
    unwrapped?.viewOnceMessageV2?.message ||
    unwrapped?.documentWithCaptionMessage?.message
  ) {
    unwrapped =
      unwrapped.ephemeralMessage?.message ||
      unwrapped.viewOnceMessage?.message ||
      unwrapped.viewOnceMessageV2?.message ||
      unwrapped.documentWithCaptionMessage?.message;
  }

  if (unwrapped?.videoMessage) return unwrapped.videoMessage;
  if (unwrapped?.url && (unwrapped.mimetype?.startsWith('video/') || unwrapped.seconds !== undefined)) {
    return unwrapped;
  }

  return null;
}

/**
 * Mengunduh media video dari WhatsApp dan menyimpannya ke file sementara.
 *
 * @param {Object} sock - Instance Baileys WhatsApp socket.
 * @param {Object} msg - Pesan pemicu.
 * @param {string} jid - Remote JID obrolan.
 * @param {Object} videoMsg - Objek videoMessage.
 * @param {string} targetPath - Path penyimpanan file sementara.
 * @returns {Promise<void>}
 */
async function downloadVideoToFile(sock, msg, jid, videoMsg, targetPath) {
  const maxBytes = 16 * 1024 * 1024;
  const fileLength = Number(videoMsg.fileLength || 0);

  if (fileLength > maxBytes) {
    const sizeErr = new Error('Video terlalu besar (maks 16MB).');
    sizeErr.isUserError = true;
    throw sizeErr;
  }

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const downloadTarget = {
    key: {
      remoteJid: jid,
      id: contextInfo?.stanzaId || msg.key?.id,
      participant: contextInfo?.participant
    },
    message: {
      videoMessage: videoMsg
    }
  };

  let mediaSource;
  if (typeof sock.downloadMediaMessage === 'function') {
    mediaSource = await sock.downloadMediaMessage(downloadTarget, 'stream');
  } else {
    try {
      mediaSource = await downloadMediaMessage(
        downloadTarget,
        'stream',
        {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      );
    } catch {
      mediaSource = await downloadContentFromMessage(videoMsg, 'video');
    }
  }

  if (Buffer.isBuffer(mediaSource)) {
    if (mediaSource.length > maxBytes) {
      const sizeErr = new Error('Video terlalu besar (maks 16MB).');
      sizeErr.isUserError = true;
      throw sizeErr;
    }
    fs.writeFileSync(targetPath, mediaSource);
    return;
  }

  const writeStream = fs.createWriteStream(targetPath);
  let downloadedBytes = 0;

  await new Promise((resolve, reject) => {
    mediaSource.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (downloadedBytes > maxBytes) {
        mediaSource.destroy();
        writeStream.destroy();
        const sizeErr = new Error('Video terlalu besar (maks 16MB).');
        sizeErr.isUserError = true;
        reject(sizeErr);
      }
    });

    mediaSource.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    mediaSource.on('error', reject);
  });
}

/**
 * Mengonversi file video menjadi file GIF menggunakan FFmpeg dua-pass palettegen/paletteuse.
 *
 * @param {string} inputPath - Path absolut atau relatif ke file video sumber.
 * @param {string} outputPath - Path tujuan file output GIF.
 * @param {Object} [options={}] - Opsi penyesuaian konversi.
 * @param {number} [options.duration=6] - Durasi maksimal pemotongan video dalam detik (-t).
 * @param {number} [options.fps=12] - Frame rate output GIF.
 * @param {number} [options.scale=320] - Lebar resolusi target GIF (tinggi diatur proporsional -1).
 * @param {number} [options.maxColors=128] - Jumlah palet warna maksimal (palettegen).
 * @param {boolean} [options.isRetry=false] - Indikator pemanggilan ulang jika ukuran > 5MB.
 * @returns {Promise<void>}
 */
async function convertVideoToGif(inputPath, outputPath, options = {}) {
  const duration = options.duration ?? 6;
  const fps = options.fps ?? 12;
  const scale = options.scale ?? 320;
  const maxColors = options.maxColors ?? 128;

  const vf = `fps=${fps},scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${maxColors}[p];[s1][p]paletteuse=dither=bayer`;

  const args = [
    '-y',
    '-i',
    inputPath,
    '-t',
    String(duration),
    '-vf',
    vf,
    '-loop',
    '0',
    outputPath
  ];

  await new Promise((resolve, reject) => {
    execFile(
      FFMPEG_PATH,
      args,
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal === 'SIGTERM') {
            const timeoutErr = new Error('Konversi video ke GIF melebihi batas waktu 60 detik.');
            timeoutErr.isUserError = true;
            return reject(timeoutErr);
          }
          return reject(new Error(`FFmpeg error: ${error.message}`));
        }
        resolve();
      }
    );
  });

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    const invalidErr = new Error('Gagal membuat GIF. Coba video lain.');
    invalidErr.isUserError = true;
    throw invalidErr;
  }

  const stat = fs.statSync(outputPath);
  if (stat.size > 5 * 1024 * 1024 && !options.isRetry) {
    console.log(`[gif] Ukuran file (${(stat.size / (1024 * 1024)).toFixed(2)} MB) melebihi 5 MB. Kompres ulang dengan scale=240, fps=10...`);
    return convertVideoToGif(inputPath, outputPath, {
      ...options,
      scale: 240,
      fps: 10,
      isRetry: true
    });
  }
}

/**
 * Menangani perintah .gif dari WhatsApp: validasi, reaksi, unduh, konversi, kirim, dan pembersihan file sementara.
 *
 * @param {Object} sock - Instance Baileys WhatsApp socket.
 * @param {Object} msg - Objek pesan pemicu.
 * @param {string} jid - Remote JID pengirim.
 * @param {Object} quotedMsg - Objek pesan yang dibalas (quoted message).
 * @returns {Promise<void>}
 */
async function handleGifCommand(sock, msg, jid, quotedMsg) {
  const videoMsg = extractVideoMessage(quotedMsg);
  if (!videoMsg) {
    await sock.sendMessage(
      jid,
      { text: 'Balas video dengan .gif untuk membuat GIF.' },
      { quoted: msg }
    );
    return;
  }

  if (activeJidLocks.has(jid)) {
    console.log(`[gif] Mengabaikan request ganda dari ${jid}`);
    await sock.sendMessage(
      jid,
      { text: 'Proses konversi GIF Anda sebelumnya masih berjalan.' },
      { quoted: msg }
    );
    return;
  }

  activeJidLocks.add(jid);

  const timestamp = Date.now();
  const inputPath = path.resolve(TMP_DIR, `input_${timestamp}.mp4`);
  const outputPath = path.resolve(TMP_DIR, `output_${timestamp}.gif`);

  try {
    try {
      await sock.sendMessage(jid, {
        react: {
          text: '⏳',
          key: msg.key
        }
      });
    } catch (reactErr) {
      console.error('[gif] Gagal mengirim reaksi:', reactErr.message);
    }

    await downloadVideoToFile(sock, msg, jid, videoMsg, inputPath);

    await convertVideoToGif(inputPath, outputPath);

    await sleep(getRandomDelay(500, 1500));

    await sock.sendMessage(
      jid,
      {
        video: fs.readFileSync(outputPath),
        gifPlayback: true,
        caption: '✅ GIF siap',
        mimetype: 'video/mp4'
      },
      { quoted: msg }
    );
  } catch (err) {
    console.error('[gif] Terjadi kesalahan saat memproses GIF:', err.message);
    const replyText = err.isUserError
      ? err.message
      : 'Gagal membuat GIF. Coba video lain.';

    try {
      await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
    } catch (sendErr) {
      console.error('[gif] Gagal mengirim pesan error:', sendErr.message);
    }
  } finally {
    activeJidLocks.delete(jid);

    try {
      await sock.sendMessage(jid, {
        react: {
          text: '',
          key: msg.key
        }
      });
    } catch {
      // Non-fatal
    }

    if (fs.existsSync(inputPath)) {
      try {
        fs.unlinkSync(inputPath);
      } catch (unlinkErr) {
        console.error('[gif] Gagal menghapus file input sementara:', unlinkErr.message);
      }
    }

    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch (unlinkErr) {
        console.error('[gif] Gagal menghapus file output sementara:', unlinkErr.message);
      }
    }
  }
}

module.exports = {
  convertVideoToGif,
  handleGifCommand
};
