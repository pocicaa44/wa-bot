const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket || baileys;
const { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, DisconnectReason } = baileys;
const pino = require('pino');
const logger = pino({ level: 'silent' });

async function runTest() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome')
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect } = u;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed:', statusCode, lastDisconnect?.error);
      if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
        console.log('Restart required (515), reconnecting...');
        runTest();
        return;
      }
    } else if (connection === 'open') {
      console.log('myAppStateKeyId:', sock.authState?.creds?.myAppStateKeyId ? 'ADA' : 'KOSONG');
      try {
        const testJid = process.env.TEST_JID || '6281234567890@s.whatsapp.net';
        console.log(`Menguji chatModify archive untuk: ${testJid}`);
        await sock.chatModify({ archive: true, lastMessages: [] }, testJid);
        console.log('chatModify OK');
      } catch (e) {
        console.log('chatModify GAGAL:', e.message, e.stack);
      }
      process.exit(0);
    }
  });
}

runTest();

