const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const readline = require("readline");
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { Sticker } = require('wa-sticker-formatter');

// ============ CONFIGURACIÓN ============
const BOT_CONFIG = {
    prefix: "!",
    botName: "Ize-Bot",
    ownerNumber: "5491171124966",   // NÚMERO DEL DUEÑO (sin +)
    maxWarnings: 3,
    antiSpamCooldown: 10000,        // 10 segundos para considerar spam
    maxMessagesInWindow: 5,
    persistenceFile: "./bot_data.json"
};

// ============ DATOS PERSISTENTES ============
let botData = {
    warnings: {},        // "groupId|userId" -> number
    mutedUsers: {},      // "groupId|userId" -> timestamp expiración
    groupSettings: {}    // groupId -> { antiLink, antiSpam, welcomeEnabled, goodbyeEnabled }
};

function loadData() {
    if (fs.existsSync(BOT_CONFIG.persistenceFile)) {
        try {
            const raw = fs.readFileSync(BOT_CONFIG.persistenceFile);
            botData = JSON.parse(raw);
        } catch(e) { console.error("Error cargando datos:", e); }
    }
}

function saveData() {
    fs.writeFileSync(BOT_CONFIG.persistenceFile, JSON.stringify(botData, null, 2));
}

// ============ SISTEMA DE LOGS ============
const LOG_LEVELS = {
    INFO: '📘',
    SUCCESS: '✅',
    ERROR: '❌',
    WARNING: '⚠️',
    BOT: '🤖',
    ADMIN: '👑'
};

function log(level, message) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`${level} [${timestamp}] ${message}`);
}

// ============ FUNCIÓN PARA PREGUNTAR ============
const question = (text) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(text, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
};

// ============ FUNCIONES PARA MENSAJES ============
function getMessageText(msg) {
    if (msg.message?.conversation) return msg.message.conversation;
    if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
    if (msg.message?.imageMessage?.caption) return msg.message.imageMessage.caption;
    if (msg.message?.videoMessage?.caption) return msg.message.videoMessage.caption;
    if (msg.message?.buttonsResponseMessage?.selectedButtonId) return msg.message.buttonsResponseMessage.selectedButtonId;
    if (msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId) return msg.message.listResponseMessage.singleSelectReply.selectedRowId;
    return null;
}

function getQuotedMessageSender(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.participant ||
           msg.message?.imageMessage?.contextInfo?.participant ||
           msg.message?.videoMessage?.contextInfo?.participant ||
           null;
}

function getQuotedMessageId(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.stanzaId ||
           msg.message?.imageMessage?.contextInfo?.stanzaId ||
           msg.message?.videoMessage?.contextInfo?.stanzaId ||
           null;
}

// ============ CACHÉ DE METADATOS DE GRUPO ============
const groupMetadataCache = new Map();

async function getGroupMetadataCached(sock, groupId) {
    if (groupMetadataCache.has(groupId)) {
        return groupMetadataCache.get(groupId);
    }
    const metadata = await sock.groupMetadata(groupId);
    groupMetadataCache.set(groupId, metadata);
    return metadata;
}

function invalidateGroupCache(groupId) {
    groupMetadataCache.delete(groupId);
}

// ============ OBTENER NOMBRE MOSTRADO ============
async function getDisplayName(sock, jid) {
    try {
        const cleanJid = jid.split('@')[0] + '@s.whatsapp.net';
        if (sock.store?.contacts) {
            for (const contact of Object.values(sock.store.contacts)) {
                if (contact.id === cleanJid) {
                    return contact.name || contact.notify || contact.verifiedName || "Usuario";
                }
            }
        }
        const number = cleanJid.split('@')[0];
        if (number.length >= 8) return number.slice(-8);
        return "Usuario";
    } catch {
        return "Usuario";
    }
}

// ============ VERIFICAR ADMINISTRADOR ============
async function isUserAdmin(sock, groupId, userId) {
    try {
        const metadata = await getGroupMetadataCached(sock, groupId);
        const participant = metadata.participants.find(p => p.id === userId);
        return participant && (participant.admin === "admin" || participant.admin === "superadmin");
    } catch {
        return false;
    }
}

// ============ ANTI-SPAM CON VENTANA DESLIZANTE ============
const spamTracker = new Map(); // userId -> array de timestamps

function isSpam(userId) {
    const now = Date.now();
    let timestamps = spamTracker.get(userId) || [];
    // Conservar solo mensajes dentro de la ventana de tiempo
    timestamps = timestamps.filter(ts => now - ts < BOT_CONFIG.antiSpamCooldown);
    timestamps.push(now);
    spamTracker.set(userId, timestamps);
    // Limpiar usuarios inactivos cada minuto
    if (Math.random() < 0.01) {
        for (let [uid, tsArray] of spamTracker.entries()) {
            if (tsArray.length === 0 || now - tsArray[tsArray.length-1] > 60000) {
                spamTracker.delete(uid);
            }
        }
    }
    return timestamps.length > BOT_CONFIG.maxMessagesInWindow;
}

// ============ VERIFICAR ENLACES ============
function isLink(text) {
    const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.(com|mx|org|net|edu|gov|io|app|xyz|club|live|online))/i;
    return linkRegex.test(text);
}

// ============ CONFIGURACIÓN POR GRUPO ============
function getGroupSetting(groupId, setting) {
    if (!botData.groupSettings[groupId]) {
        botData.groupSettings[groupId] = {
            antiLink: false,
            antiSpam: true,
            welcomeEnabled: true,
            goodbyeEnabled: true
        };
    }
    return botData.groupSettings[groupId][setting];
}

function setGroupSetting(groupId, setting, value) {
    if (!botData.groupSettings[groupId]) {
        botData.groupSettings[groupId] = {
            antiLink: false,
            antiSpam: true,
            welcomeEnabled: true,
            goodbyeEnabled: true
        };
    }
    botData.groupSettings[groupId][setting] = value;
    saveData();
}

// ============ FUNCIONES PARA GIFS Y STICKERS ============
async function ensureGifsFolder() {
    const gifsDir = path.join(__dirname, 'gifs');
    if (!fs.existsSync(gifsDir)) {
        fs.mkdirSync(gifsDir);
        log(LOG_LEVELS.WARNING, 'Carpeta "gifs" creada. Agrega GIFs de besos allí.');
        fs.writeFileSync(path.join(gifsDir, 'README.txt'), 'Agrega aquí tus GIFs de besos anime.\nFormatos soportados: .gif, .mp4, .webp');
    }
}

async function getRandomKissGif() {
    const gifsDir = path.join(__dirname, 'gifs');
    if (!fs.existsSync(gifsDir)) return null;
    const files = fs.readdirSync(gifsDir);
    const gifFiles = files.filter(f => f.endsWith('.gif') || f.endsWith('.mp4') || f.endsWith('.webp'));
    if (gifFiles.length === 0) return null;
    const randomGif = gifFiles[Math.floor(Math.random() * gifFiles.length)];
    return fs.readFileSync(path.join(gifsDir, randomGif));
}

async function getRandomExplosionSticker() {
    const explosionsDir = path.join(__dirname, 'explosions');
    if (!fs.existsSync(explosionsDir)) {
        fs.mkdirSync(explosionsDir);
        fs.writeFileSync(path.join(explosionsDir, 'README.txt'), 'Agrega aquí stickers/GIFs de explosiones.');
        return null;
    }
    const files = fs.readdirSync(explosionsDir);
    const mediaFiles = files.filter(f => f.endsWith('.gif') || f.endsWith('.mp4') || f.endsWith('.webp'));
    if (mediaFiles.length === 0) return null;
    const randomFile = mediaFiles[Math.floor(Math.random() * mediaFiles.length)];
    const fileBuffer = fs.readFileSync(path.join(explosionsDir, randomFile));
    const sticker = new Sticker(fileBuffer, {
        pack: BOT_CONFIG.botName,
        author: '💥',
        type: 'full',
        quality: 80
    });
    return await sticker.toBuffer();
}

async function createStickerFromMedia(buffer, mimeType) {
    try {
        const sticker = new Sticker(buffer, {
            pack: BOT_CONFIG.botName,
            author: 'Sticker Bot',
            type: (mimeType === 'video/mp4' || mimeType === 'image/gif') ? 'full' : 'full',
            quality: 80
        });
        return await sticker.toBuffer();
    } catch (error) {
        log(LOG_LEVELS.ERROR, `Error en createStickerFromMedia: ${error}`);
        return null;
    }
}

// ============ DESCARGA DE APKS (APKPURE) ============
async function searchApkPure(appName) {
    try {
        const searchUrl = `https://apkpure.net/search?q=${encodeURIComponent(appName)}`;
        const { data } = await axios.get(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(data);
        const firstLink = $('.search-results .first a').attr('href') || $('.search-results li:first-child a').attr('href');
        if (!firstLink) return null;
        const detailUrl = firstLink.startsWith('http') ? firstLink : `https://apkpure.net${firstLink}`;
        const { data: detailData } = await axios.get(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $$ = cheerio.load(detailData);
        let downloadLink = $$('.download-btn').attr('href') || $$('.da-download').attr('href');
        if (!downloadLink) return null;
        if (!downloadLink.startsWith('http')) downloadLink = `https://apkpure.net${downloadLink}`;
        const apkName = $$('h1.title').text().trim() || appName;
        return { downloadUrl: downloadLink, name: apkName };
    } catch (error) {
        console.error('Error en searchApkPure:', error.message);
        return null;
    }
}

async function downloadApk(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
        return Buffer.from(response.data);
    } catch (error) {
        console.error('Error al descargar APK:', error.message);
        return null;
    }
}

// ============ FUNCIÓN PRINCIPAL ============
async function startBot() {
    loadData();
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const { state, saveCreds } = await useMultiFileAuthState("./session");

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: "silent" }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    sock.ev.on("creds.update", saveCreds);

    // Emparejamiento automático si no hay credenciales
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (!state.creds.registered) {
        const phoneNumber = BOT_CONFIG.ownerNumber;
        if (!phoneNumber) {
            log(LOG_LEVELS.ERROR, "❌ Define BOT_CONFIG.ownerNumber con tu número");
            process.exit(1);
        }
        log(LOG_LEVELS.INFO, `📱 Solicitando código para ${phoneNumber}...`);
        let code = null;
        let attempts = 0;
        while (attempts < 3 && !code) {
            attempts++;
            try {
                code = await sock.requestPairingCode(phoneNumber);
                log(LOG_LEVELS.SUCCESS, `✨ CÓDIGO: ${code}\n`);
                log(LOG_LEVELS.INFO, "Ingresa este código en WhatsApp > Dispositivos vinculados");
            } catch (err) {
                log(LOG_LEVELS.ERROR, `Intento ${attempts} falló: ${err.message}`);
                if (attempts === 3) process.exit(1);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    // Evento de conexión
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
            reconnectAttempts = 0;
            log(LOG_LEVELS.SUCCESS, `${BOT_CONFIG.botName} conectado exitosamente 😺`);
        }
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                const waitTime = 5000 * reconnectAttempts;
                log(LOG_LEVELS.WARNING, `Reconectando en ${waitTime/1000}s (Intento ${reconnectAttempts})`);
                setTimeout(() => startBot(), waitTime);
            } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                log(LOG_LEVELS.ERROR, "Máximos reintentos alcanzados");
                process.exit(1);
            }
        }
    });

    await ensureGifsFolder();

    // Bienvenidas / despedidas con caché
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action } = update;
        invalidateGroupCache(id);
        const welcomeEnabled = getGroupSetting(id, "welcomeEnabled");
        const goodbyeEnabled = getGroupSetting(id, "goodbyeEnabled");
        if (!welcomeEnabled && !goodbyeEnabled) return;
        let message = "";
        if (action === "add" && welcomeEnabled) {
            const nombre = await getDisplayName(sock, participants[0]);
            message = `🐱 ¡Bienvenido al grupo ${nombre}!\n📌 Lee las reglas y disfruta. Usa ${BOT_CONFIG.prefix}menu para ver los comandos.`;
        } else if (action === "remove" && goodbyeEnabled) {
            const nombre = await getDisplayName(sock, participants[0]);
            message = `👋 ${nombre} ha salido del grupo.\n¡Esperamos verte de vuelta pronto!`;
        }
        if (message) await sock.sendMessage(id, { text: message });
    });

    // Manejo de mensajes
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const sender = msg.key.participant || msg.key.remoteJid;
        let text = getMessageText(msg);
        if (!text && !msg.message.imageMessage && !msg.message.videoMessage) return;

        // Anti-spam (solo grupos)
        if (isGroup && getGroupSetting(from, "antiSpam")) {
            const isAdmin = await isUserAdmin(sock, from, sender);
            if (!isAdmin && isSpam(sender)) {
                const warnKey = `${from}|${sender}`;
                botData.warnings[warnKey] = (botData.warnings[warnKey] || 0) + 1;
                saveData();
                const currentWarns = botData.warnings[warnKey];
                const phone = sender.split('@')[0];
                await sock.sendMessage(from, {
                    text: `⚠️ @${phone} spam detectado. Advertencia ${currentWarns}/${BOT_CONFIG.maxWarnings}`,
                    mentions: [sender]
                });
                if (currentWarns >= BOT_CONFIG.maxWarnings) {
                    await sock.groupParticipantsUpdate(from, [sender], "remove");
                    await sock.sendMessage(from, { text: `🚫 @${phone} expulsado por spam excesivo.`, mentions: [sender] });
                    delete botData.warnings[warnKey];
                    saveData();
                }
                return;
            }
        }

        // Anti-enlaces
        if (isGroup && getGroupSetting(from, "antiLink") && text && isLink(text)) {
            const isAdmin = await isUserAdmin(sock, from, sender);
            if (!isAdmin) {
                const phone = sender.split('@')[0];
                await sock.sendMessage(from, { text: `🔗 @${phone} los enlaces no están permitidos.`, mentions: [sender] });
                await sock.groupParticipantsUpdate(from, [sender], "remove");
                return;
            }
        }

        // Verificar silencios
        const muteKey = `${from}|${sender}`;
        if (botData.mutedUsers[muteKey] && Date.now() < botData.mutedUsers[muteKey]) {
            const phone = sender.split('@')[0];
            await sock.sendMessage(from, { text: `🔇 @${phone} estás silenciado.`, mentions: [sender] });
            return;
        } else if (botData.mutedUsers[muteKey] && Date.now() >= botData.mutedUsers[muteKey]) {
            delete botData.mutedUsers[muteKey];
            saveData();
        }

        const isCommand = text && text.startsWith(BOT_CONFIG.prefix);
        if (!isCommand && !msg.message.imageMessage) return;
        const args = isCommand ? text.slice(BOT_CONFIG.prefix.length).trim().split(/\s+/) : [];
        const command = isCommand ? args.shift().toLowerCase() : null;

        // Verificar admin de grupo
        let isAdmin = false;
        if (isGroup && command) {
            isAdmin = await isUserAdmin(sock, from, sender);
            // Solo admins pueden usar comandos de administración
            const adminCommands = ["ban","kick","mute","unmute","promote","demote","warn","warns","delwarn","resetwarns","delete","del","clear","lock","unlock","antilink","antispam","welcome","goodbye","setname","setdesc","setpp"];
            if (adminCommands.includes(command) && !isAdmin) {
                await sock.sendMessage(from, { text: "❌ Solo administradores del grupo pueden usar este comando." });
                return;
            }
        }

        // ==================== COMANDOS ====================

        if (command === "hola") {
            const senderName = await getDisplayName(sock, sender);
            await sock.sendMessage(from, { text: `¡Hola ${senderName}! 😺 Usa ${BOT_CONFIG.prefix}menu para ver mis comandos.` });
        }

        if (command === "ping") {
            const start = Date.now();
            await sock.sendMessage(from, { text: "🏓 Calculando ping..." });
            const end = Date.now();
            await sock.sendMessage(from, { text: `🏓 Pong! Latencia: ${end - start}ms\n⏱️ ${new Date().toLocaleTimeString()}` });
        }

        if (command === "sticker" || command === "s") {
            try {
                let mediaBuffer, mimeType;
                const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quotedMsg) {
                    if (quotedMsg.imageMessage) {
                        mediaBuffer = await sock.downloadMediaMessage({ message: quotedMsg });
                        mimeType = quotedMsg.imageMessage.mimetype;
                    } else if (quotedMsg.videoMessage) {
                        mediaBuffer = await sock.downloadMediaMessage({ message: quotedMsg });
                        mimeType = quotedMsg.videoMessage.mimetype;
                    } else {
                        await sock.sendMessage(from, { text: "❌ Responde a una imagen, GIF o video." });
                        return;
                    }
                } else if (msg.message.imageMessage || msg.message.videoMessage) {
                    mediaBuffer = await sock.downloadMediaMessage(msg);
                    mimeType = msg.message.imageMessage?.mimetype || msg.message.videoMessage?.mimetype;
                } else {
                    await sock.sendMessage(from, { text: `❌ Uso: responde a una imagen/GIF/video con ${BOT_CONFIG.prefix}sticker` });
                    return;
                }
                if (!mediaBuffer) throw new Error("No se pudo descargar");
                const stickerBuffer = await createStickerFromMedia(mediaBuffer, mimeType);
                if (stickerBuffer) await sock.sendMessage(from, { sticker: stickerBuffer });
                else await sock.sendMessage(from, { text: "❌ Error al crear sticker." });
            } catch (error) {
                log(LOG_LEVELS.ERROR, `Error en sticker: ${error}`);
                await sock.sendMessage(from, { text: "❌ Error al procesar el sticker." });
            }
            return;
        }

        if (command === "kiss") {
            try {
                let target = null;
                const senderName = await getDisplayName(sock, sender);
                // Obtener mencionados o respuesta
                const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
                if (mentioned && mentioned.length > 0) target = mentioned[0];
                else if (getQuotedMessageSender(msg)) target = getQuotedMessageSender(msg);
                else if (isGroup) {
                    const metadata = await getGroupMetadataCached(sock, from);
                    const others = metadata.participants.filter(p => p.id !== sender);
                    if (others.length) target = others[Math.floor(Math.random() * others.length)].id;
                }
                const phrases = ["💕 le dio un beso a", "😘 besó apasionadamente a", "🌸 le regaló un beso a", "✨ sorprendió con un beso a"];
                const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
                let message = "", mentions = [];
                const senderPhone = sender.split('@')[0];
                if (target && target !== sender) {
                    const targetPhone = target.split('@')[0];
                    message = `@${senderPhone} ${randomPhrase} @${targetPhone} 💕`;
                    mentions = [sender, target];
                } else {
                    message = `@${senderPhone} se dio un beso a sí mismo 💕`;
                    mentions = [sender];
                }
                const gifBuffer = await getRandomKissGif();
                if (gifBuffer) {
                    await sock.sendMessage(from, { video: gifBuffer, gifPlayback: true, caption: message, mentions });
                } else {
                    await sock.sendMessage(from, { text: message, mentions });
                }
            } catch (error) {
                log(LOG_LEVELS.ERROR, `Error en kiss: ${error}`);
                await sock.sendMessage(from, { text: "❌ Error en !kiss" });
            }
            return;
        }

        if (command === "detonar" || command === "fruti") {
            try {
                let target = null;
                const senderName = await getDisplayName(sock, sender);
                const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
                if (mentioned && mentioned.length > 0) target = mentioned[0];
                else if (getQuotedMessageSender(msg)) target = getQuotedMessageSender(msg);
                else if (isGroup) {
                    const metadata = await getGroupMetadataCached(sock, from);
                    const others = metadata.participants.filter(p => p.id !== sender);
                    if (others.length) target = others[Math.floor(Math.random() * others.length)].id;
                }
                const phrases = [" explotó con ", " hizo detonar a ", " mandó a volar a ", " friendzoneó a "];
                const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
                let message = "", mentions = [];
                const senderPhone = sender.split('@')[0];
                if (target && target !== sender) {
                    const targetPhone = target.split('@')[0];
                    message = `@${senderPhone} ${randomPhrase} @${targetPhone} 💥`;
                    mentions = [sender, target];
                } else {
                    message = `@${senderPhone} se autodetonó 💥`;
                    mentions = [sender];
                }
                await sock.sendMessage(from, { text: message, mentions });
                const stickerBuffer = await getRandomExplosionSticker();
                if (stickerBuffer) await sock.sendMessage(from, { sticker: stickerBuffer });
            } catch (error) {
                log(LOG_LEVELS.ERROR, `Error en detonar: ${error}`);
                await sock.sendMessage(from, { text: "❌ Error en !detonar" });
            }
            return;
        }

        if (command === "menu") {
            let menuText = `╔══════════════════════════════╗\n`;
            menuText += `║     ✨ ${BOT_CONFIG.botName} ✨      ║\n`;
            menuText += `╠══════════════════════════════╣\n`;
            menuText += `║ 🤖 BÁSICOS                   ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}hola  - Saludo       ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}ping  - Latencia     ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}menu  - Este menú    ║\n`;
            menuText += `║──────────────────────────────║\n`;
            menuText += `║ 🎨 STICKER                   ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}sticker - Convierte    ║\n`;
            menuText += `║──────────────────────────────║\n`;
            menuText += `║ 💕 DIVERSIÓN                 ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}kiss @user     ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}detonar @user  ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}fruti @user    ║\n`;
            if (isGroup) {
                menuText += `║──────────────────────────────║\n`;
                menuText += `║ 📚 GRUPO                     ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}grupoinfo      ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}miembros       ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}admin          ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}link           ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}pp             ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}apk <app>      ║\n`;
                menuText += `║──────────────────────────────║\n`;
                menuText += `║ 👑 ADMINISTRACIÓN            ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}ban @user     ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}mute @user    ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}unmute @user  ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}promote @user ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}demote @user  ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}warn @user    ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}warns @user   ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}delwarn @user ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}delete (resp) ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}lock/unlock   ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}antilink on/off║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}antispam on/off║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}welcome on/off ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}goodbye on/off ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}setname texto  ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}setdesc texto  ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}setpp (imagen) ║\n`;
            }
            menuText += `╚══════════════════════════════╝`;
            await sock.sendMessage(from, { text: menuText });
        }

        // Comandos de grupo (solo si es grupo)
        if (isGroup) {
            if (command === "grupoinfo") {
                try {
                    const metadata = await getGroupMetadataCached(sock, from);
                    const admins = metadata.participants.filter(p => p.admin === "admin" || p.admin === "superadmin");
                    let adminText = "", mentions = [];
                    for (let i = 0; i < Math.min(admins.length, 5); i++) {
                        const a = admins[i];
                        const name = await getDisplayName(sock, a.id);
                        adminText += `• @${a.id.split('@')[0]} (${name})\n`;
                        mentions.push(a.id);
                    }
                    const info = `📊 INFO DEL GRUPO\n━━━━━━━━━━━━━━━━\n📛 Nombre: ${metadata.subject}\n👥 Miembros: ${metadata.participants.length}\n👑 Admins: ${admins.length}\n🔒 Restringido: ${metadata.restrict ? "Sí" : "No"}\n📢 Anuncios: ${metadata.announce ? "Solo admins" : "Todos"}\n━━━━━━━━━━━━━━━━\n👑 ADMINISTRADORES:\n${adminText}`;
                    await sock.sendMessage(from, { text: info, mentions });
                } catch { await sock.sendMessage(from, { text: "❌ Error obteniendo info" }); }
            }

            if (command === "apk") {
                const searchTerm = args.join(" ").trim();
                if (!searchTerm) return await sock.sendMessage(from, { text: `❌ Uso: ${BOT_CONFIG.prefix}apk <nombre>` });
                await sock.sendMessage(from, { text: `🔍 Buscando "${searchTerm}"...` });
                const apkInfo = await searchApkPure(searchTerm);
                if (!apkInfo) return await sock.sendMessage(from, { text: "❌ No se encontró APK." });
                await sock.sendMessage(from, { text: `📥 Descargando ${apkInfo.name}...` });
                const apkBuffer = await downloadApk(apkInfo.downloadUrl);
                if (!apkBuffer || apkBuffer.length < 1000) return await sock.sendMessage(from, { text: "❌ Error en descarga." });
                const sizeMB = (apkBuffer.length / (1024*1024)).toFixed(2);
                await sock.sendMessage(from, {
                    document: apkBuffer,
                    mimetype: 'application/vnd.android.package-archive',
                    fileName: `${apkInfo.name.replace(/[^a-z0-9]/gi, '_')}.apk`,
                    caption: `📱 ${apkInfo.name}\n📦 ${sizeMB} MB`
                });
                return;
            }

            if (command === "admin" || command === "admins") {
                const metadata = await getGroupMetadataCached(sock, from);
                const admins = metadata.participants.filter(p => p.admin === "admin" || p.admin === "superadmin");
                let list = "👑 ADMINISTRADORES:\n", mentions = [];
                for (let i=0; i<admins.length; i++) {
                    const a = admins[i];
                    const name = await getDisplayName(sock, a.id);
                    list += `${a.admin === "superadmin" ? "🌟" : "👑"} ${i+1}. @${a.id.split('@')[0]} (${name})\n`;
                    mentions.push(a.id);
                }
                await sock.sendMessage(from, { text: list, mentions });
            }

            if (command === "miembros") {
                const metadata = await getGroupMetadataCached(sock, from);
                let list = "👥 MIEMBROS:\n", mentions = [];
                const participants = metadata.participants.slice(0, 20);
                for (let i=0; i<participants.length; i++) {
                    const p = participants[i];
                    const name = await getDisplayName(sock, p.id);
                    list += `${p.admin ? "👑" : "  "} ${i+1}. @${p.id.split('@')[0]} (${name})\n`;
                    mentions.push(p.id);
                }
                if (metadata.participants.length > 20) list += `\n... y ${metadata.participants.length-20} más`;
                await sock.sendMessage(from, { text: list, mentions });
            }

            if (command === "link") {
                try {
                    const code = await sock.groupInviteCode(from);
                    await sock.sendMessage(from, { text: `🔗 https://chat.whatsapp.com/${code}` });
                } catch { await sock.sendMessage(from, { text: "❌ No se pudo obtener el link (¿soy admin?)" }); }
            }

            if (command === "pp") {
                try {
                    const url = await sock.profilePictureUrl(from, "image");
                    await sock.sendMessage(from, { text: `🖼️ Foto: ${url}` });
                } catch { await sock.sendMessage(from, { text: "❌ Grupo sin foto de perfil." }); }
            }

            // Comandos de administración (solo admins)
            if (command === "ban" || command === "kick") {
                const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                let target = mentioned[0] || getQuotedMessageSender(msg);
                if (!target) return await sock.sendMessage(from, { text: "❌ Menciona o responde al usuario." });
                await sock.groupParticipantsUpdate(from, [target], "remove");
                const name = await getDisplayName(sock, target);
                await sock.sendMessage(from, { text: `🚫 ${name} expulsado.`, mentions: [target] });
            }

            if (command === "mute") {
                let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedMessageSender(msg);
                if (!target) return await sock.sendMessage(from, { text: "❌ Menciona al usuario." });
                let duration = 3600000; // 1 hora por defecto
                if (args[0] && !isNaN(args[0])) duration = parseInt(args[0]) * 60000;
                botData.mutedUsers[`${from}|${target}`] = Date.now() + duration;
                saveData();
                const name = await getDisplayName(sock, target);
                await sock.sendMessage(from, { text: `🔇 ${name} silenciado por ${duration/60000} minutos.`, mentions: [target] });
            }

            if (command === "unmute") {
                let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedMessageSender(msg);
                if (!target) return await sock.sendMessage(from, { text: "❌ Menciona al usuario." });
                delete botData.mutedUsers[`${from}|${target}`];
                saveData();
                const name = await getDisplayName(sock, target);
                await sock.sendMessage(from, { text: `🔊 ${name} desilenciado.`, mentions: [target] });
            }

            if (command === "promote") {
                let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedMessageSender(msg);
                if (!target) return await sock.sendMessage(from, { text: "❌ Menciona al usuario." });
                await sock.groupParticipantsUpdate(from, [target], "promote");
                invalidateGroupCache(from);
                await sock.sendMessage(from, { text: `👑 Promovido a admin.`, mentions: [target] });
            }

            if (command === "demote") {
                let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedMessageSender(msg);
                if (!target) return await sock.sendMessage(from, { text: "❌ Menciona al usuario." });
                await sock.groupParticipantsUpdate(from, [target], "demote");
                invalidateGroupCache(from);
                await sock.sendMessage(from, { text: `📛 Admin revocado.`, mentions: [target] });
            }

            if (command === "warn") {
                let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedMessageSender(msg);
                if (!target) return await sock.sendMessage(from, { text: "❌ Menciona al usuario." });
                const key = `${from}|${target}`;
                botData.warnings[key] = (botData.warnings[key] || 0) + 1;
                saveData();
                const current = botData.warnings[key];
                await sock.sendMessage(from, { text: `⚠️ Advertencia ${current}/${BOT_CONFIG.maxWarnings}`, mentions: [target] });
                if (current >= BOT_CONFIG.maxWarnings) {
                    await sock.groupParticipantsUpdate(from, [target], "remove");
                    delete botData.warnings[key];
                    saveData();
                    await sock.sendMessage(from, { text: `🚫 Usuario expulsado por exceso de advertencias.`, mentions: [target] });
                }
            }

            if (command === "warns") {
                let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedMessageSender(msg);
                if (!target) return await sock.sendMessage(from, { text: "❌ Menciona al usuario." });
                const key = `${from}|${target}`;
                const warns = botData.warnings[key] || 0;
                await sock.sendMessage(from, { text: `📋 Advertencias: ${warns}/${BOT_CONFIG.maxWarnings}`, mentions: [target] });
            }

            if (command === "delwarn" || command === "resetwarns") {
                let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedMessageSender(msg);
                if (!target) return await sock.sendMessage(from, { text: "❌ Menciona al usuario." });
                delete botData.warnings[`${from}|${target}`];
                saveData();
                await sock.sendMessage(from, { text: `✅ Advertencias borradas.`, mentions: [target] });
            }

            if (command === "delete" || command === "del") {
                const quotedId = getQuotedMessageId(msg);
                const quotedParticipant = getQuotedMessageSender(msg);
                if (!quotedId) return await sock.sendMessage(from, { text: "❌ Responde al mensaje a eliminar." });
                const key = { remoteJid: from, fromMe: false, id: quotedId, participant: quotedParticipant || from };
                await sock.sendMessage(from, { delete: key });
                await sock.sendMessage(from, { text: "✅ Mensaje eliminado." });
            }

            if (command === "lock") {
                await sock.groupSettingUpdate(from, "announcement");
                await sock.sendMessage(from, { text: "🔒 Grupo cerrado (solo admins)." });
            }
            if (command === "unlock") {
                await sock.groupSettingUpdate(from, "not_announcement");
                await sock.sendMessage(from, { text: "🔓 Grupo abierto (todos pueden enviar)." });
            }

            if (command === "antilink") {
                const newVal = args[0] === "on";
                if (args[0] && (args[0]==="on"||args[0]==="off")) {
                    setGroupSetting(from, "antiLink", newVal);
                    await sock.sendMessage(from, { text: `✅ Anti-enlaces ${newVal ? "activado" : "desactivado"}.` });
                } else {
                    const current = getGroupSetting(from, "antiLink");
                    await sock.sendMessage(from, { text: `📋 Anti-enlaces: ${current ? "activado" : "desactivado"}\nUsa ${BOT_CONFIG.prefix}antilink on/off` });
                }
            }
            if (command === "antispam") {
                const newVal = args[0] === "on";
                if (args[0] && (args[0]==="on"||args[0]==="off")) {
                    setGroupSetting(from, "antiSpam", newVal);
                    await sock.sendMessage(from, { text: `✅ Anti-spam ${newVal ? "activado" : "desactivado"}.` });
                } else {
                    const current = getGroupSetting(from, "antiSpam");
                    await sock.sendMessage(from, { text: `📋 Anti-spam: ${current ? "activado" : "desactivado"}` });
                }
            }
            if (command === "welcome") {
                const newVal = args[0] === "on";
                if (args[0] && (args[0]==="on"||args[0]==="off")) {
                    setGroupSetting(from, "welcomeEnabled", newVal);
                    await sock.sendMessage(from, { text: `✅ Bienvenidas ${newVal ? "activadas" : "desactivadas"}.` });
                } else {
                    const current = getGroupSetting(from, "welcomeEnabled");
                    await sock.sendMessage(from, { text: `📋 Bienvenidas: ${current ? "activadas" : "desactivadas"}` });
                }
            }
            if (command === "goodbye") {
                const newVal = args[0] === "on";
                if (args[0] && (args[0]==="on"||args[0]==="off")) {
                    setGroupSetting(from, "goodbyeEnabled", newVal);
                    await sock.sendMessage(from, { text: `✅ Despedidas ${newVal ? "activadas" : "desactivadas"}.` });
                } else {
                    const current = getGroupSetting(from, "goodbyeEnabled");
                    await sock.sendMessage(from, { text: `📋 Despedidas: ${current ? "activadas" : "desactivadas"}` });
                }
            }
            if (command === "setname") {
                const newName = args.join(" ");
                if (!newName) return await sock.sendMessage(from, { text: "❌ Escribe el nuevo nombre." });
                await sock.groupUpdateSubject(from, newName);
                invalidateGroupCache(from);
                await sock.sendMessage(from, { text: `✅ Nombre actualizado a: ${newName}` });
            }
            if (command === "setdesc") {
                const newDesc = args.join(" ");
                if (!newDesc) return await sock.sendMessage(from, { text: "❌ Escribe la nueva descripción." });
                await sock.groupUpdateDescription(from, newDesc);
                await sock.sendMessage(from, { text: `✅ Descripción actualizada.` });
            }
            if (command === "setpp" && (msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage)) {
                try {
                    let mediaMsg = msg.message;
                    if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                        mediaMsg = { message: msg.message.extendedTextMessage.contextInfo.quotedMessage };
                    }
                    const buffer = await sock.downloadMediaMessage(mediaMsg);
                    await sock.updateProfilePicture(from, buffer);
                    invalidateGroupCache(from);
                    await sock.sendMessage(from, { text: "✅ Foto de grupo actualizada." });
                } catch (e) {
                    await sock.sendMessage(from, { text: "❌ Error al actualizar foto. Envía una imagen con el comando o responde a una." });
                }
            }
        }

        // Comandos para el dueño del bot (broadcast, stats)
        const senderNumber = sender.split('@')[0];
        const isOwner = (senderNumber === BOT_CONFIG.ownerNumber);
        if (isOwner && command === "broadcast") {
            const broadcastMsg = args.join(" ");
            if (!broadcastMsg) return await sock.sendMessage(from, { text: "❌ Escribe un mensaje para difundir." });
            await sock.sendMessage(from, { text: "📢 Iniciando difusión..." });
            const groups = await sock.groupFetchAllParticipating();
            let sent = 0, failed = 0;
            for (const groupId in groups) {
                try {
                    await sock.sendMessage(groupId, { text: `📢 ANUNCIO:\n\n${broadcastMsg}` });
                    sent++;
                    await new Promise(r => setTimeout(r, 1500));
                } catch { failed++; }
            }
            await sock.sendMessage(from, { text: `✅ Difusión completada\n📨 Enviados: ${sent}\n❌ Fallidos: ${failed}` });
        }
        if (isOwner && command === "stats") {
            const uptime = process.uptime();
            const hours = Math.floor(uptime/3600), mins = Math.floor((uptime%3600)/60), secs = Math.floor(uptime%60);
            const gifsCount = fs.existsSync("./gifs") ? fs.readdirSync("./gifs").filter(f=>f.endsWith('.gif')).length : 0;
            const stats = `📊 ESTADÍSTICAS\n━━━━━━━━━━━━━\n⏱️ Uptime: ${hours}h ${mins}m ${secs}s\n🤖 ${BOT_CONFIG.botName}\n📋 Prefijo: ${BOT_CONFIG.prefix}\n💋 GIFs beso: ${gifsCount}\n🛡️ Anti-spam global: activado\n🔗 Anti-link por grupo: configurable`;
            await sock.sendMessage(from, { text: stats });
        }
    });
}

process.on("uncaughtException", (err) => log(LOG_LEVELS.ERROR, `Error no capturado: ${err.message}`));
process.on("unhandledRejection", (reason) => log(LOG_LEVELS.ERROR, `Promesa rechazada: ${reason}`));

log(LOG_LEVELS.BOT, `Iniciando ${BOT_CONFIG.botName}...`);
startBot().catch(err => { log(LOG_LEVELS.ERROR, `Error fatal: ${err.message}`); process.exit(1); });