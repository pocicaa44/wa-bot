const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pino = require('pino');
const WebP = require('node-webpmux');
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

const PACK_NAME = process.env.PACK_NAME || 'sm1';
const PACK_PUBLISHER = process.env.PACK_PUBLISHER || '@imagoodppl';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Ekstraksi objek videoMessage dari struktur pesan WhatsApp atau quotedMessage.
 *
 * @param {Object} msg - Objek pesan yang dibalas (quoted) atau pesan itu sendiri.
 * @returns {Object|null} Objek videoMessage atau null jika bukan video.
 */
function extractVideoMessage(msg) {
  if (!msg) return null;

  let unwrapped = msg;
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
 * Ekstraksi objek imageMessage dari struktur pesan WhatsApp atau quotedMessage.
 *
 * @param {Object} msg - Objek pesan yang dibalas (quoted) atau pesan itu sendiri.
 * @returns {Object|null} Objek imageMessage atau null jika bukan gambar.
 */
function extractImageMessage(msg) {
  if (!msg) return null;

  let unwrapped = msg;
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

  if (unwrapped?.imageMessage) return unwrapped.imageMessage;
  if (unwrapped?.url && unwrapped.mimetype?.startsWith('image/')) {
    return unwrapped;
  }

  return null;
}

/**
 * Menambahkan metadata EXIF ke buffer WebP (pack name & author).
 *
 * @param {Buffer} webpBuffer - Buffer WebP sumber.
 * @param {string} [packName=PACK_NAME] - Nama sticker pack.
 * @param {string} [packPublisher=PACK_PUBLISHER] - Nama pembuat sticker.
 * @returns {Promise<Buffer>} Buffer WebP dengan metadata atau buffer asli jika gagal.
 */
async function addStickerMetadata(webpBuffer, packName = PACK_NAME, packPublisher = PACK_PUBLISHER) {
  try {
    const metadata = {
      'sticker-pack-name': packName,
      'sticker-pack-publisher': packPublisher
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
    return await img.save(null);
  } catch {
    return webpBuffer;
  }
}

/**
 * Menjalankan child_process.execFile dengan timeout dan penanganan timeout kustom.
 *
 * @param {string} command - Path executable.
 * @param {string[]} args - Argumen perintah.
 * @param {number} timeoutMs - Batas waktu eksekusi dalam milidetik.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runExecFile(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal === 'SIGTERM') {
            const timeoutErr = new Error('❌ Konversi timeout. Coba video yang lebih pendek.');
            timeoutErr.isUserError = true;
            return reject(timeoutErr);
          }
          error.stderr = stderr;
          return reject(error);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/**
 * Mengunduh media video dari WhatsApp dan menyimpannya ke file sementara.
 * Batas maksimal ukuran video adalah 16 MB.
 *
 * @param {Object} sock - Instance Baileys WhatsApp socket.
 * @param {Object} msg - Pesan pemicu.
 * @param {string} jid - Remote JID pengirim/obrolan.
 * @param {Object} videoMsg - Objek videoMessage.
 * @param {string} targetPath - Path penyimpanan file sementara.
 * @returns {Promise<void>}
 */
async function downloadVideoToFile(sock, msg, jid, videoMsg, targetPath) {
  const maxBytes = 16 * 1024 * 1024;
  const fileLength = Number(videoMsg.fileLength || 0);

  if (fileLength > maxBytes) {
    const sizeErr = new Error('❌ Video terlalu besar (maks 16MB).');
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
  try {
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
  } catch (dlInitErr) {
    console.error('[vsticker] Gagal inisialisasi download:', dlInitErr.message);
    const dlErr = new Error('❌ Gagal mengunduh media. Coba kirim ulang.');
    dlErr.isUserError = true;
    throw dlErr;
  }

  if (Buffer.isBuffer(mediaSource)) {
    if (mediaSource.length > maxBytes) {
      const sizeErr = new Error('❌ Video terlalu besar (maks 16MB).');
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
        const sizeErr = new Error('❌ Video terlalu besar (maks 16MB).');
        sizeErr.isUserError = true;
        reject(sizeErr);
      }
    });

    mediaSource.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', (err) => {
      console.error('[vsticker] Stream download error:', err.message);
      const dlErr = new Error('❌ Gagal mengunduh media. Coba kirim ulang.');
      dlErr.isUserError = true;
      reject(dlErr);
    });
    mediaSource.on('error', (err) => {
      console.error('[vsticker] Media stream error:', err.message);
      const dlErr = new Error('❌ Gagal mengunduh media. Coba kirim ulang.');
      dlErr.isUserError = true;
      reject(dlErr);
    });
  });
}

/**
 * Mem-parse perintah .vsticker dari body pesan WhatsApp.
 * Format yang didukung:
 * - .vsticker -> durasi default 10 detik
 * - .vsticker {detik} -> durasi sesuai argumen (1 <= detik <= 10)
 * - .vsticker > 10 -> dibatasi ke 10 detik disertai warning
 *
 * @param {string} body - Teks perintah.
 * @returns {{ valid: boolean, duration?: number, error?: string, warning?: string }}
 */
function parseVStickerCommand(body) {
  if (typeof body !== 'string') {
    return { valid: false, error: '⚠️ Format salah. Gunakan: .vsticker atau .vsticker {detik}' };
  }

  const trimmed = body.trim().toLowerCase();
  const parts = trimmed.split(/\s+/);

  if (parts[0] !== '.vsticker') {
    return { valid: false, error: '⚠️ Format salah. Gunakan: .vsticker atau .vsticker {detik}' };
  }

  if (parts.length === 1) {
    return { valid: true, duration: 10 };
  }

  if (parts.length > 2) {
    return { valid: false, error: '⚠️ Format salah. Gunakan: .vsticker atau .vsticker {detik}' };
  }

  const regex = /^\.vsticker(?:\s+(\d+(?:\.\d+)?))?$/;
  if (!regex.test(trimmed)) {
    return { valid: false, error: '⚠️ Format salah. Gunakan: .vsticker atau .vsticker {detik}' };
  }

  const duration = parseFloat(parts[1]);
  if (isNaN(duration)) {
    return { valid: false, error: '⚠️ Format salah. Gunakan: .vsticker atau .vsticker {detik}' };
  }

  if (duration < 1) {
    return { valid: false, error: '⚠️ Durasi minimal 1 detik.' };
  }

  if (duration > 10) {
    return {
      valid: true,
      duration: 10,
      warning: '⚠️ Durasi maksimal 10 detik. Menggunakan 10 detik pertama.'
    };
  }

  return { valid: true, duration };
}

/**
 * Mengonversi video ke stiker WebP animasi menggunakan FFmpeg.
 * Menjaga aspect ratio asli (skala lebar maksimal 512, tinggi proporsional, tanpa crop).
 * Melakukan kompresi ulang otomatis jika ukuran file hasil melebihi 1 MB.
 *
 * @param {string} inputPath - Path file input video.
 * @param {string} outputPath - Path file output WebP animasi.
 * @param {number} duration - Durasi pemotongan video dalam detik (-t).
 * @returns {Promise<void>}
 */
async function convertToVideoSticker(inputPath, outputPath, duration) {
  async function runAttempt(fps, qv) {
    const primaryArgs = [
      '-y',
      '-i',
      inputPath,
      '-t',
      String(duration),
      '-vf',
      `scale=512:512:force_original_aspect_ratio=increase,crop=512:512,fps=${fps}`,
      '-c:v',
      'libwebp',
      '-lossless',
      '0',
      '-q:v',
      String(qv),
      '-loop',
      '0',
      '-an',
      '-vsync',
      '0',
      outputPath
    ];

    try {
      await runExecFile(FFMPEG_PATH, primaryArgs, 90000);
    } catch (err) {
      if (err.isUserError) throw err;
      const stderr = err.stderr || err.message || '';
      if (stderr.includes('Unknown encoder') || stderr.includes('Encoder not found') || stderr.includes('libwebp')) {
        const fallbackArgs = [
          '-y',
          '-i',
          inputPath,
          '-t',
          String(duration),
          '-vf',
          `scale=512:512:force_original_aspect_ratio=increase,crop=512:512,fps=${fps}`,
          '-loop',
          '0',
          '-an',
          outputPath
        ];
        await runExecFile(FFMPEG_PATH, fallbackArgs, 90000);
      } else {
        throw err;
      }
    }
  }

  // Percobaan 1: fps=15, q:v=60
  await runAttempt(15, 60);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    const invalidErr = new Error('❌ Gagal membuat stiker video. Coba video lain.');
    invalidErr.isUserError = true;
    throw invalidErr;
  }

  const stat = fs.statSync(outputPath);
  if (stat.size > 1024 * 1024) {
    // Percobaan 2: turunkan fps ke 10 dan q:v ke 45
    await runAttempt(10, 45);

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      const invalidErr = new Error('❌ Gagal membuat stiker video. Coba video lain.');
      invalidErr.isUserError = true;
      throw invalidErr;
    }

    const stat2 = fs.statSync(outputPath);
    if (stat2.size > 1024 * 1024) {
      const tooLargeErr = new Error('❌ Video terlalu besar untuk dijadikan stiker. Coba video yang lebih pendek.');
      tooLargeErr.isUserError = true;
      throw tooLargeErr;
    }
  }
}

/**
 * Mengonversi frame pertama video menjadi stiker statis WebP menggunakan FFmpeg.
 *
 * @param {string} inputPath - Path file input video.
 * @param {string} outputPath - Path file output WebP statis.
 * @returns {Promise<void>}
 */
async function convertToStaticSticker(inputPath, outputPath) {
  const args = [
    '-y',
    '-i',
    inputPath,
    '-vframes',
    '1',
    '-vf',
    'scale=512:512:force_original_aspect_ratio=increase,crop=512:512',
    outputPath
  ];

  await runExecFile(FFMPEG_PATH, args, 30000);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    const invalidErr = new Error('❌ Gagal membuat stiker. Coba video lain.');
    invalidErr.isUserError = true;
    throw invalidErr;
  }
}

/**
 * Menangani perintah .vsticker dari pesan WhatsApp: validasi, reaksi, unduh, konversi, kirim, dan pembersihan file sementara.
 *
 * @param {Object} sock - Instance Baileys WhatsApp socket.
 * @param {Object} msg - Objek pesan pemicu.
 * @param {string} jid - Remote JID pengirim.
 * @param {Object} quotedMsg - Objek pesan yang dibalas (quoted message) atau pesan media itu sendiri.
 * @param {number} [duration=10] - Durasi stiker dalam detik.
 * @param {string} [warning] - Pesan peringatan opsional jika durasi dibatasi.
 * @returns {Promise<void>}
 */
async function handleVSticker(sock, msg, jid, quotedMsg, duration = 10, warning = '') {
  if (!quotedMsg) {
    await sock.sendMessage(jid, { text: '❌ Balas sebuah video dengan .vsticker' }, { quoted: msg });
    return;
  }

  const videoMsg = extractVideoMessage(quotedMsg);
  const imageMsg = extractImageMessage(quotedMsg);

  if (!videoMsg) {
    if (imageMsg) {
      await sock.sendMessage(
        jid,
        { text: '❌ .vsticker hanya untuk video. Untuk gambar, gunakan .sticker.' },
        { quoted: msg }
      );
      return;
    }

    if (quotedMsg.conversation || quotedMsg.extendedTextMessage) {
      await sock.sendMessage(
        jid,
        { text: '❌ Balas sebuah video atau gambar dengan perintah ini.' },
        { quoted: msg }
      );
      return;
    }

    await sock.sendMessage(
      jid,
      { text: '❌ Media tidak didukung. Kirim video.' },
      { quoted: msg }
    );
    return;
  }

  if (activeJidLocks.has(jid)) {
    await sock.sendMessage(
      jid,
      { text: '⏳ Tunggu, stiker sebelumnya sedang diproses.' },
      { quoted: msg }
    );
    return;
  }

  activeJidLocks.add(jid);

  const timestamp = Date.now();
  const inputPath = path.resolve(TMP_DIR, `vsticker_input_${timestamp}.mp4`);
  const outputPath = path.resolve(TMP_DIR, `vsticker_output_${timestamp}.webp`);

  try {
    try {
      await sock.sendMessage(jid, {
        react: {
          text: '⏳',
          key: msg.key
        }
      });
    } catch {
      // non-fatal
    }

    if (warning) {
      try {
        await sock.sendMessage(jid, { text: warning }, { quoted: msg });
      } catch {
        // non-fatal
      }
    }

    await downloadVideoToFile(sock, msg, jid, videoMsg, inputPath);

    await convertToVideoSticker(inputPath, outputPath, duration);

    await sleep(getRandomDelay(500, 1500));

    let stickerBuffer = fs.readFileSync(outputPath);
    try {
      stickerBuffer = await addStickerMetadata(stickerBuffer);
    } catch {
      // fallback ke buffer mentah
    }

    const sentMsg = await sock.sendMessage(
      jid,
      { sticker: stickerBuffer },
      { quoted: msg }
    );
    return sentMsg;
  } catch (err) {
    console.error('[vsticker] Terjadi kesalahan saat memproses stiker video:', err.message);
    const replyText = err.isUserError
      ? err.message
      : '❌ Gagal membuat stiker video. Coba video lain.';

    try {
      await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
    } catch (sendErr) {
      console.error('[vsticker] Gagal mengirim pesan error:', sendErr.message);
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
      // non-fatal
    }

    if (fs.existsSync(inputPath)) {
      try {
        fs.unlinkSync(inputPath);
      } catch (unlinkErr) {
        console.error('[vsticker] Gagal menghapus file input sementara:', unlinkErr.message);
      }
    }

    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch (unlinkErr) {
        console.error('[vsticker] Gagal menghapus file output sementara:', unlinkErr.message);
      }
    }
  }
}

/**
 * Menangani pembuatan stiker statis dari frame pertama video saat dipicu perintah .sticker.
 *
 * @param {Object} sock - Instance Baileys WhatsApp socket.
 * @param {Object} msg - Objek pesan pemicu.
 * @param {string} jid - Remote JID pengirim.
 * @param {Object} quotedMsg - Objek pesan yang dibalas (quoted message) atau pesan media itu sendiri.
 * @returns {Promise<void>}
 */
async function handleStaticStickerFromVideo(sock, msg, jid, quotedMsg) {
  const videoMsg = extractVideoMessage(quotedMsg);
  if (!videoMsg) {
    await sock.sendMessage(
      jid,
      { text: '❌ Balas sebuah video atau gambar dengan perintah ini.' },
      { quoted: msg }
    );
    return;
  }

  if (activeJidLocks.has(jid)) {
    await sock.sendMessage(
      jid,
      { text: '⏳ Tunggu, stiker sebelumnya sedang diproses.' },
      { quoted: msg }
    );
    return;
  }

  activeJidLocks.add(jid);

  const timestamp = Date.now();
  const inputPath = path.resolve(TMP_DIR, `vsticker_static_input_${timestamp}.mp4`);
  const outputPath = path.resolve(TMP_DIR, `vsticker_static_output_${timestamp}.webp`);

  try {
    try {
      await sock.sendMessage(jid, {
        react: {
          text: '⏳',
          key: msg.key
        }
      });
    } catch {
      // non-fatal
    }

    await downloadVideoToFile(sock, msg, jid, videoMsg, inputPath);

    await convertToStaticSticker(inputPath, outputPath);

    await sleep(getRandomDelay(500, 1500));

    let stickerBuffer = fs.readFileSync(outputPath);
    try {
      stickerBuffer = await addStickerMetadata(stickerBuffer);
    } catch {
      // fallback ke buffer mentah
    }

    const sentMsg = await sock.sendMessage(
      jid,
      { sticker: stickerBuffer },
      { quoted: msg }
    );

    await sock.sendMessage(
      jid,
      { text: 'ℹ️ Stiker statis dibuat dari frame pertama video. Gunakan .vsticker untuk stiker bergerak.' },
      { quoted: msg }
    );
    return sentMsg;
  } catch (err) {
    console.error('[vsticker] Terjadi kesalahan saat memproses stiker statis video:', err.message);
    const replyText = err.isUserError
      ? err.message
      : '❌ Gagal membuat stiker. Coba video lain.';

    try {
      await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
    } catch (sendErr) {
      console.error('[vsticker] Gagal mengirim pesan error:', sendErr.message);
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
      // non-fatal
    }

    if (fs.existsSync(inputPath)) {
      try {
        fs.unlinkSync(inputPath);
      } catch (unlinkErr) {
        console.error('[vsticker] Gagal menghapus file input sementara:', unlinkErr.message);
      }
    }

    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch (unlinkErr) {
        console.error('[vsticker] Gagal menghapus file output sementara:', unlinkErr.message);
      }
    }
  }
}

module.exports = {
  parseVStickerCommand,
  convertToVideoSticker,
  convertToStaticSticker,
  handleVSticker,
  handleStaticStickerFromVideo
};
