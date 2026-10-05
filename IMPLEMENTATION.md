# Implementation Details

## Specifications

1. **Aspect Ratio 1:1 (Stretch)**
   - Engine: `sharp`
   - Setting: `resize(512, 512, { fit: 'fill' })`
   - Behavior: Disregards source aspect ratio and stretches non-square images to 1:1 (512x512).

2. **Direct Delivery (Non-Reply)**
   - Socket call: `sock.sendMessage(jid, { sticker })`
   - Behavior: Delivers sticker directly to the chat without message quotation.

3. **Sticker Metadata (Pack Name & Publisher)**
   - Engine: `node-webpmux`
   - Pack Name: `dwnBOT` (configurable via `process.env.PACK_NAME`)
   - Publisher: `@imagoodppl` (configurable via `process.env.PACK_PUBLISHER`)
   - Format: Embedded EXIF chunk with TIFF header and JSON metadata.

4. **Commands & Menu (.help)**
   - Trigger: `.help`
   - Response:
     ```
     dwnBOT
     .sticker : kirim gambar dengan caption .sticker untuk membuat stiker
     .help : tampilkan menu bantuan
     .status : tampilkan status bot
     ```
   - Other commands: `.status` (replies `ready`), `.sticker` / `.stiker` (support direct image caption or quoting an existing image).

5. **Fallback Handling**
   - Trigger: Any incoming text message or uncaptioned image that does not match recognized commands (excluding broadcasts and reactions).
   - Response: `"Maaf saya tidak mengerti, gunakan .help untuk melihat bantuan."`

6. **Privacy Features**
   - **Auto Archive**: Invokes `sock.chatModify({ archive: true, lastMessages: [...] }, jid)` immediately after sending sticker.
   - **Auto Delete for Me**: Invokes `sock.chatModify({ deleteForMe: { key, timestamp, deleteMedia: true } }, jid)` on incoming media/messages and the outgoing generated sticker right after processing.
   - **Non-blocking Fault Tolerance**: Both operations run inside dedicated `try...catch` blocks to ensure failures never terminate or disrupt the bot process.
   - **App State Key Requirement**: `sock.chatModify` uses Syncd mutations which require `myAppStateKeyId` provided by WhatsApp's primary phone during companion desktop synchronization (`makeCacheableSignalKeyStore` + Desktop browser configuration).

7. **Anti-Ban & Rate Limiting**
   - **Rate Limit Window**: Maximum 20 chats processed per minute (`maxChatsPerMinute: 20`) via 60-second rolling sliding window. Excess incoming requests are discarded with terminal warning.
   - **Sequential Queue**: Incoming events are pushed to a FIFO queue (`messageQueue`) and executed sequentially to eliminate concurrent socket bursts and race conditions.
   - **Realistic Human Delays & Presence**:
     - Marks incoming message as read (`readMessages`).
     - Simulates typing presence (`sendPresenceUpdate('composing')`) with randomized jitter (1000ms–2500ms) before outgoing responses.
     - Inserts pauses (400ms–1000ms) between outgoing message dispatch, archive mutations, and delete-for-me actions to prevent server IQ collision.

8. **Execution**
   - Command: `npm start`
   - Entry: `node index.js`
