const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys")

const P = require("pino")
const readline = require("readline")
const fs = require('fs')
const path = require('path')
const axios = require('axios');
const cheerio = require('cheerio');
const { Sticker } = require('wa-sticker-formatter')

// ============ CONFIGURACIÓN ============
const BOT_CONFIG = {
    prefix: "!",           
    botName: "Ize-Bot",
    admins: [],            // Números de admin del bot: ["521234567890"]
    onlyAdmins: false,     
    welcomeEnabled: true,  
    goodbyeEnabled: true,
    antiLink: false,       
    antiSpam: true,        
    maxWarnings: 3         
}

// ============ BASE DE DATOS EN MEMORIA ============
const warnings = new Map();
const mutedUsers = new Map();
const spamTracker = new Map();

// ============ SISTEMA DE LOGS ============
const LOG_LEVELS = {
    INFO: '📘',
    SUCCESS: '✅',
    ERROR: '❌',
    WARNING: '⚠️',
    BOT: '🤖',
    ADMIN: '👑'
}

function log(level, message) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`${level} [${timestamp}] ${message}`);
}

// ============ FUNCIÓN PARA PREGUNTAR ============
const question = (text) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    })
    return new Promise((resolve) => {
        rl.question(text, (answer) => {
            rl.close()
            resolve(answer)
        })
    })
}

// ============ FUNCIONES PARA MENSAJES ============
function getMessageText(msg) {
    if (msg.message?.conversation) {
        return msg.message.conversation;
    }
    if (msg.message?.extendedTextMessage?.text) {
        return msg.message.extendedTextMessage.text;
    }
    if (msg.message?.imageMessage?.caption) {
        return msg.message.imageMessage.caption;
    }
    if (msg.message?.videoMessage?.caption) {
        return msg.message.videoMessage.caption;
    }
    if (msg.message?.buttonsResponseMessage?.selectedButtonId) {
        return msg.message.buttonsResponseMessage.selectedButtonId;
    }
    if (msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId) {
        return msg.message.listResponseMessage.singleSelectReply.selectedRowId;
    }
    return null;
}

function getQuotedMessageSender(msg) {
    if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
        return msg.message.extendedTextMessage.contextInfo.participant;
    }
    if (msg.message?.imageMessage?.contextInfo?.participant) {
        return msg.message.imageMessage.contextInfo.participant;
    }
    if (msg.message?.videoMessage?.contextInfo?.participant) {
        return msg.message.videoMessage.contextInfo.participant;
    }
    return null;
}

function getQuotedMessageId(msg) {
    if (msg.message?.extendedTextMessage?.contextInfo?.stanzaId) {
        return msg.message.extendedTextMessage.contextInfo.stanzaId;
    }
    if (msg.message?.imageMessage?.contextInfo?.stanzaId) {
        return msg.message.imageMessage.contextInfo.stanzaId;
    }
    if (msg.message?.videoMessage?.contextInfo?.stanzaId) {
        return msg.message.videoMessage.contextInfo.stanzaId;
    }
    return null;
}

// ============ FUNCIÓN PARA OBTENER NOMBRE MOSTRADO ============
async function getDisplayName(sock, jid) {
    try {
        if (sock.store?.contacts) {
            for (const [contactId, contactData] of Object.entries(sock.store.contacts)) {
                if (contactId === jid || contactData.id === jid) {
                    const name = contactData.name || contactData.notify || contactData.verifiedName;
                    if (name && name !== jid) return name;
                }
            }
        }
        if (sock.contacts && sock.contacts[jid]) {
            const name = sock.contacts[jid].name || sock.contacts[jid].notify;
            if (name) return name;
        }
        const number = jid.split('@')[0];
        if (number && /^\d+$/.test(number) && number.length >= 8) {
            return number.slice(-8);
        }
        return "Usuario";
    } catch (err) {
        return "Usuario";
    }
}

// ============ BUSCAR USUARIO POR NOMBRE EN EL GRUPO ============
async function findUserByName(sock, groupId, searchName) {
    try {
        let cleanSearch = searchName.toLowerCase().trim();
        if (cleanSearch.startsWith('@')) cleanSearch = cleanSearch.substring(1);
        
        const groupMetadata = await sock.groupMetadata(groupId);
        const participants = groupMetadata.participants;
        console.log(`🔍 Buscando usuario: "${cleanSearch}"`);
        
        const userMap = [];
        for (const participant of participants) {
            const jid = participant.id;
            let userName = await getDisplayName(sock, jid);
            userMap.push({ jid, name: userName.toLowerCase(), originalName: userName });
        }
        
        for (const user of userMap) if (user.name === cleanSearch) return user.jid;
        for (const user of userMap) if (user.name.includes(cleanSearch)) return user.jid;
        
        const searchWords = cleanSearch.split(/\s+/);
        for (const user of userMap) {
            for (const word of searchWords) {
                if (word.length >= 2 && user.name.includes(word)) return user.jid;
            }
        }
        console.log(`❌ No encontrado: "${cleanSearch}"`);
        return null;
    } catch (error) {
        console.error('Error en findUserByName:', error);
        return null;
    }
}

// ============ OBTENER MENCIONES AVANZADAS ============
async function getMentionedUsersAdvanced(sock, msg, from, isGroup) {
    const mentionedJids = [];
    
    if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid) {
        const mentions = msg.message.extendedTextMessage.contextInfo.mentionedJid;
        if (Array.isArray(mentions) && mentions.length > 0) return mentions;
    }
    
    if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
        const participant = msg.message.extendedTextMessage.contextInfo.participant;
        if (participant) return [participant];
    }
    
    if (isGroup) {
        const text = getMessageText(msg);
        if (text) {
            const mentionRegex = /@([a-zA-ZáéíóúñÑüÁÉÍÓÚÜ0-9\s]+)/g;
            let match;
            while ((match = mentionRegex.exec(text)) !== null) {
                let searchName = match[1].trim().replace(/[^\w\sáéíóúüñ]/gi, '');
                if (searchName && searchName.length >= 2) {
                    const userJid = await findUserByName(sock, from, searchName);
                    if (userJid && !mentionedJids.includes(userJid)) mentionedJids.push(userJid);
                }
            }
        }
    }
    return mentionedJids;
}

// ============ FUNCIÓN PARA OBTENER NOMBRE (CON PUSHNAME) ============
async function getContactName(sock, jid, msg = null) {
    try {
        if (msg && msg.pushName) return msg.pushName;
        let cleanJid = jid.includes('@') ? jid : jid + '@s.whatsapp.net';
        if (sock.store?.contacts) {
            for (const [contactId, contactData] of Object.entries(sock.store.contacts)) {
                if (contactId === cleanJid || contactData.id === cleanJid) {
                    const name = contactData.name || contactData.notify || contactData.verifiedName;
                    if (name && name !== cleanJid) return name;
                }
            }
        }
        let phoneNumber = cleanJid.split('@')[0];
        if (/^\d{10,15}$/.test(phoneNumber)) {
            if (sock.getName) {
                const name = await sock.getName(cleanJid);
                if (name && name !== phoneNumber) return name;
            }
        }
        if (phoneNumber.length === 10) return `${phoneNumber.slice(0,3)}-${phoneNumber.slice(3,6)}-${phoneNumber.slice(6)}`;
        if (phoneNumber.length === 11) return `${phoneNumber.slice(0,2)}-${phoneNumber.slice(2,5)}-${phoneNumber.slice(5,8)}-${phoneNumber.slice(8)}`;
        if (phoneNumber.length >= 8) return phoneNumber.slice(-8);
        return "Usuario";
    } catch (err) {
        return "Usuario";
    }
}

// ============ VERIFICAR CARPETA DE GIFS ============
async function ensureGifsFolder() {
    const gifsDir = path.join(__dirname, 'gifs');
    if (!fs.existsSync(gifsDir)) {
        fs.mkdirSync(gifsDir);
        log(LOG_LEVELS.WARNING, 'Carpeta "gifs" creada. Agrega GIFs de besos allí.');
        fs.writeFileSync(path.join(gifsDir, 'README.txt'), 'Agrega aquí tus GIFs de besos anime.\nFormatos soportados: .gif, .mp4, .webp\nEl bot los usará automáticamente para el comando !kiss');
    }
}

async function getRandomKissSticker() {
    try {
        const gifsDir = path.join(__dirname, 'gifs');
        if (!fs.existsSync(gifsDir)) return null;
        const files = fs.readdirSync(gifsDir);
        const gifFiles = files.filter(f => f.endsWith('.gif') || f.endsWith('.mp4') || f.endsWith('.webp'));
        if (gifFiles.length === 0) return null;
        const randomGif = gifFiles[Math.floor(Math.random() * gifFiles.length)];
        const gifBuffer = fs.readFileSync(path.join(gifsDir, randomGif));
        const sticker = new Sticker(gifBuffer, { pack: BOT_CONFIG.botName, author: 'Kisses 💋', type: 'full', quality: 80 });
        return await sticker.toBuffer();
    } catch (error) {
        log(LOG_LEVELS.ERROR, `Error creando sticker: ${error}`);
        return null;
    }
}


// ============ OBTENER STICKER DE EXPLOSIÓN ============
async function getRandomExplosionSticker() {
    try {
        const explosionsDir = path.join(__dirname, 'explosions');
        
        // Crear carpeta si no existe (opcional, para que el usuario sepa dónde poner sus stickers)
        if (!fs.existsSync(explosionsDir)) {
            fs.mkdirSync(explosionsDir);
            log(LOG_LEVELS.WARNING, 'Carpeta "explosions" creada. Agrega ahí stickers/GIFs de explosiones.');
            // Crear README informativo
            fs.writeFileSync(path.join(explosionsDir, 'README.txt'), 
                'Agrega aquí tus stickers/GIFs de explosiones para el comando !detonar.\n' +
                'Formatos soportados: .gif, .mp4, .webp\n' +
                'Si la carpeta está vacía, se usará un sticker de respaldo (URL).'
            );
            return null;
        }
        
        const files = fs.readdirSync(explosionsDir);
        const mediaFiles = files.filter(f => f.endsWith('.gif') || f.endsWith('.mp4') || f.endsWith('.webp'));
        
        if (mediaFiles.length === 0) return null;
        
        const randomFile = mediaFiles[Math.floor(Math.random() * mediaFiles.length)];
        const fileBuffer = fs.readFileSync(path.join(explosionsDir, randomFile));
        
        const sticker = new Sticker(fileBuffer, {
            pack: BOT_CONFIG.botName,
            author: 'detonacion',
            type: 'full',
            quality: 80
        });
        
        return await sticker.toBuffer();
    } catch (error) {
        log(LOG_LEVELS.ERROR, `Error en getRandomExplosionSticker: ${error}`);
        return null;
    }
}

async function createStickerFromMedia(buffer, mimeType) {
    try {
        // Configuración básica del sticker
        const stickerConfig = {
            pack: BOT_CONFIG.botName,
            author: 'Sticker Bot',
            type: 'full',
            quality: 80
        };

        // Si es un video (mp4) o GIF, lo tratamos como sticker animado
        if (mimeType === 'video/mp4' || mimeType === 'image/gif') {
            stickerConfig.type = 'full'; // full permite stickers animados
        }

        const sticker = new Sticker(buffer, stickerConfig);
        return await sticker.toBuffer();
    } catch (error) {
        log(LOG_LEVELS.ERROR, `Error en createStickerFromMedia: ${error}`);
        return null;
    }
}


// ============ BUSCAR Y DESCARGAR APK DESDE APKPURE ============
async function searchApkPure(appName) {
    try {
        const searchUrl = `https://apkpure.net/search?q=${encodeURIComponent(appName)}`;
        const { data } = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(data);
        // Obtener primer enlace de resultado
        const firstLink = $('.search-results .first a').attr('href') || $('.search-results li:first-child a').attr('href');
        if (!firstLink) return null;
        const detailUrl = firstLink.startsWith('http') ? firstLink : `https://apkpure.net${firstLink}`;
        
        // Obtener enlace de descarga desde la página del APK
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


function isLink(text) {
    const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.(com|mx|org|net|edu|gov|io|app|xyz|club|live|online))/i;
    return linkRegex.test(text);
}

function isSpam(userId, message) {
    if (!BOT_CONFIG.antiSpam) return false;
    const now = Date.now();
    const userData = spamTracker.get(userId);
    if (!userData) {
        spamTracker.set(userId, { count: 1, lastMessage: now, lastContent: message });
        return false;
    }
    const timeDiff = now - userData.lastMessage;
    if (timeDiff < 3000) {
        userData.count++;
        spamTracker.set(userId, { ...userData, lastMessage: now });
        return userData.count >= 5;
    } else {
        spamTracker.set(userId, { count: 1, lastMessage: now, lastContent: message });
        return false;
    }
}

// ============ FUNCIÓN PRINCIPAL ============
async function startBot() {
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const sock = makeWASocket({ auth: state, logger: P({ level: "silent" }), printQRInTerminal: false });
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "connecting") {

            const creds = state.creds;

            if (!creds.registered) {

                log(LOG_LEVELS.INFO, "\n📱 MODO DE EMPAREJAMIENTO CON CÓDIGO");

                const phoneNumber = process.env.NUMERO;

                await new Promise(resolve => setTimeout(resolve, 15000));

                try {

                    const code = await sock.requestPairingCode(phoneNumber);

                    log(LOG_LEVELS.SUCCESS, `\n✨ CÓDIGO: ${code}\n`);

                } catch (err) {

                    log(LOG_LEVELS.ERROR, `Error generando código: ${err}`);

                }
            }
        }

        if (connection === "open") {
            reconnectAttempts = 0;
            log(LOG_LEVELS.SUCCESS, `${BOT_CONFIG.botName} conectado exitosamente 😺`);
        }

        if (connection === "close") {

            const creds = state.creds;

            if (!creds.registered) {
                log(LOG_LEVELS.WARNING, "Esperando generación de código...");
                return;
            }

            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {

                reconnectAttempts++;

                const waitTime = 5000 * reconnectAttempts;

                log(
                    LOG_LEVELS.WARNING,
                    `Reconectando en ${waitTime / 1000}s`
                );

                setTimeout(() => startBot(), waitTime);
            }
        }
    });

    await ensureGifsFolder();

   
    // Bienvenidas / despedidas
    sock.ev.on("group-participants.update", async (update) => {
        const { id, participants, action } = update;
        if (!BOT_CONFIG.welcomeEnabled && !BOT_CONFIG.goodbyeEnabled) return;
        let message = "";
        if (action === "add" && BOT_CONFIG.welcomeEnabled) {
            const nombre = await getDisplayName(sock, participants[0]);
            message = `🐱 ¡Bienvenido al grupo ${nombre}!\n\n📌 Lee las reglas y disfruta. ¡${BOT_CONFIG.botName} está aquí para ayudar!\n\n💡 Usa ${BOT_CONFIG.prefix}menu para ver los comandos.`;
        } else if (action === "remove" && BOT_CONFIG.goodbyeEnabled) {
            const nombre = await getDisplayName(sock, participants[0]);
            message = `👋 ${nombre} ha salido del grupo.\n\n¡Esperamos verte de vuelta pronto!`;
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

        // Anti-spam
        if (isGroup && BOT_CONFIG.antiSpam && text) {
            if (isSpam(sender, text)) {
                const warnKey = `${from}|${sender}`;
                const currentWarns = (warnings.get(warnKey) || 0) + 1;
                warnings.set(warnKey, currentWarns);
                const phone = sender.split('@')[0];
                await sock.sendMessage(from, { text: `⚠️ @${phone} has sido detectado haciendo spam.\nAdvertencia ${currentWarns}/${BOT_CONFIG.maxWarnings}`, mentions: [sender] });
                if (currentWarns >= BOT_CONFIG.maxWarnings) {
                    await sock.groupParticipantsUpdate(from, [sender], "remove");
                    await sock.sendMessage(from, { text: `🚫 @${phone} ha sido expulsado por spam excesivo.`, mentions: [sender] });
                    warnings.delete(warnKey);
                }
                return;
            }
        }

        // Anti-enlaces
        if (isGroup && BOT_CONFIG.antiLink && text && isLink(text)) {
            try {
                const groupMetadata = await sock.groupMetadata(from);
                const isAdminGroup = groupMetadata.participants.find(p => p.id === sender)?.admin === "admin" || groupMetadata.participants.find(p => p.id === sender)?.admin === "superadmin";
                if (!isAdminGroup) {
                    const phone = sender.split('@')[0];
                    await sock.sendMessage(from, { text: `🔗 @${phone} los enlaces no están permitidos en este grupo.`, mentions: [sender] });
                    await sock.groupParticipantsUpdate(from, [sender], "remove");
                    return;
                }
            } catch (err) {}
        }

        // Verificar mute
        const muteKey = `${from}|${sender}`;
        const muteData = mutedUsers.get(muteKey);
        if (muteData && Date.now() < muteData) {
            const phone = sender.split('@')[0];
            await sock.sendMessage(from, { text: `🔇 @${phone} estás silenciado. No puedes enviar mensajes.`, mentions: [sender] });
            return;
        } else if (muteData && Date.now() >= muteData) {
            mutedUsers.delete(muteKey);
        }

        const isCommand = text && text.startsWith(BOT_CONFIG.prefix);
        if (!isCommand && !msg.message.imageMessage) return;
        const args = isCommand ? text.slice(BOT_CONFIG.prefix.length).trim().split(/\s+/) : [];
        const command = isCommand ? args.shift().toLowerCase() : null;

        // Verificar admin de grupo
        let isAdmin = false, isSuperAdmin = false;
        if (isGroup) {
            try {
                const groupMetadata = await sock.groupMetadata(from);
                const participant = groupMetadata.participants.find(p => p.id === sender);
                if (participant) {
                    isAdmin = participant.admin === "admin" || participant.admin === "superadmin";
                    isSuperAdmin = participant.admin === "superadmin";
                }
            } catch (err) {}
        }

        if (isGroup && BOT_CONFIG.onlyAdmins && !isAdmin && isCommand) {
            await sock.sendMessage(from, { text: "❌ Solo administradores pueden usar comandos en este grupo." });
            return;
        }

        // Sticker desde imagen
// Sticker desde imagen, GIF o video (sin comando)
        if ((msg.message.imageMessage || msg.message.videoMessage) && !isCommand) {
            try {
                let mediaBuffer, mimeType;
                if (msg.message.imageMessage) {
                    mediaBuffer = await sock.downloadMediaMessage(msg);
                    mimeType = msg.message.imageMessage.mimetype;
                } else if (msg.message.videoMessage) {
                    mediaBuffer = await sock.downloadMediaMessage(msg);
                    mimeType = msg.message.videoMessage.mimetype;
                }
                
                if (!mediaBuffer) {
                    await sock.sendMessage(from, { text: "❌ No se pudo descargar el archivo." });
                    return;
                }

                // Verificar si es un formato soportado
                const supportedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4'];
                if (!supportedMimes.includes(mimeType)) {
                    await sock.sendMessage(from, { text: "❌ Formato no soportado. Usa JPG, PNG, GIF o MP4." });
                    return;
                }

                const stickerBuffer = await createStickerFromMedia(mediaBuffer, mimeType);
                if (stickerBuffer) {
                    await sock.sendMessage(from, { sticker: stickerBuffer });
                    log(LOG_LEVELS.SUCCESS, `Sticker creado desde ${mimeType}`);
                } else {
                    await sock.sendMessage(from, { text: "❌ Error al crear el sticker. Intenta con otro archivo." });
                }
            } catch (error) {
                log(LOG_LEVELS.ERROR, `Error en sticker automático: ${error}`);
                await sock.sendMessage(from, { text: "❌ Error al procesar el archivo." });
            }
            return;
        }
        if (!isCommand) return;

        // ==================== COMANDOS ====================

        if (command === "hola") {
            const senderName = await getContactName(sock, sender, msg);
            await sock.sendMessage(from, { text: `¡Hola ${senderName}! 😺 ¿Cómo estás?\n\nUsa ${BOT_CONFIG.prefix}menu para ver mis comandos.` });
        }



        // ========== COMANDO !STICKER (para convertir multimedia respondiendo) ==========
        if (command === "sticker" || command === "s") {
            try {
                // Verificar si se está respondiendo a un mensaje
                const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                let mediaBuffer, mimeType;

                if (quotedMsg) {
                    // Obtener el mensaje citado
                    if (quotedMsg.imageMessage) {
                        mediaBuffer = await sock.downloadMediaMessage({ message: quotedMsg });
                        mimeType = quotedMsg.imageMessage.mimetype;
                    } else if (quotedMsg.videoMessage) {
                        mediaBuffer = await sock.downloadMediaMessage({ message: quotedMsg });
                        mimeType = quotedMsg.videoMessage.mimetype;
                    } else {
                        await sock.sendMessage(from, { text: "❌ Responde a una imagen, GIF o video para convertirlo a sticker." });
                        return;
                    }
                } else if (msg.message.imageMessage || msg.message.videoMessage) {
                    // Si el comando se envía junto con el archivo (sin responder)
                    if (msg.message.imageMessage) {
                        mediaBuffer = await sock.downloadMediaMessage(msg);
                        mimeType = msg.message.imageMessage.mimetype;
                    } else if (msg.message.videoMessage) {
                        mediaBuffer = await sock.downloadMediaMessage(msg);
                        mimeType = msg.message.videoMessage.mimetype;
                    }
                } else {
                    await sock.sendMessage(from, { text: `❌ Uso: responde a una imagen/GIF/video con ${BOT_CONFIG.prefix}sticker` });
                    return;
                }

                if (!mediaBuffer) {
                    await sock.sendMessage(from, { text: "❌ No se pudo descargar el archivo." });
                    return;
                }

                const supportedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4'];
                if (!supportedMimes.includes(mimeType)) {
                    await sock.sendMessage(from, { text: "❌ Formato no soportado. Usa JPG, PNG, GIF o MP4." });
                    return;
                }

                const stickerBuffer = await createStickerFromMedia(mediaBuffer, mimeType);
                if (stickerBuffer) {
                    await sock.sendMessage(from, { sticker: stickerBuffer });
                    log(LOG_LEVELS.SUCCESS, `Sticker creado con !sticker desde ${mimeType}`);
                } else {
                    await sock.sendMessage(from, { text: "❌ Error al crear el sticker." });
                }
            } catch (error) {
                log(LOG_LEVELS.ERROR, `Error en !sticker: ${error}`);
                await sock.sendMessage(from, { text: "❌ Error al procesar el comando !sticker" });
            }
            return;
        }


        if (command === "ping") {
            const start = Date.now();
            await sock.sendMessage(from, { text: "🏓 Calculando ping..." });
            const end = Date.now();
            await sock.sendMessage(from, { text: `🏓 Pong!\nLatencia: ${end - start}ms\n⏱️ ${new Date().toLocaleTimeString()}` });
        }

        // ========== KISS (con menciones reales usando números) ==========
        if (command === "kiss") {
            try {
                let target = null, targetName = null;
                const senderName = msg.pushName || await getDisplayName(sock, sender);
                const mentionedUsers = await getMentionedUsersAdvanced(sock, msg, from, isGroup);
                if (mentionedUsers.length > 0) {
                    target = mentionedUsers[0];
                    targetName = await getDisplayName(sock, target);
                } else if (getQuotedMessageSender(msg)) {
                    target = getQuotedMessageSender(msg);
                    targetName = await getDisplayName(sock, target);
                } else if (isGroup) {
                    const metadata = await sock.groupMetadata(from);
                    const otherMembers = metadata.participants.filter(p => p.id !== sender);
                    if (otherMembers.length) {
                        const randomMember = otherMembers[Math.floor(Math.random() * otherMembers.length)];
                        target = randomMember.id;
                        targetName = await getDisplayName(sock, target);
                    }
                }
                const kissPhrases = [
                    "💕 le dio un beso a", "😘 besó apasionadamente a", "💋 plantó un beso a",
                    "🌸 le regaló un beso a", "✨ sorprendió con un beso a", "🥰 demostró su amor besando a",
                    "💖 le robó un beso a", "😳 se armó de valor y besó a", "💫 fundió en un beso a",
                    "🌹 le dio un beso romántico a", "💗 le dio un besito tierno a", "😍 le dio un beso emocionado a"
                ];
                const randomPhrase = kissPhrases[Math.floor(Math.random() * kissPhrases.length)];
                let kissMessage = "", mentions = [];
                const senderPhone = sender.split('@')[0];
                if (target === sender) {
                    kissMessage = `@${senderPhone} se quiere mucho a sí mismo/a y se da un beso 💕`;
                    mentions.push(sender);
                } else if (target && targetName) {
                    const targetPhone = target.split('@')[0];
                    kissMessage = `@${senderPhone} ${randomPhrase} @${targetPhone}  💕`;
                    mentions.push(sender, target);
                } else {
                    kissMessage = `@${senderPhone} ${randomPhrase} con mucho cariño 💕`;
                    mentions.push(sender);
                }
                await sock.sendMessage(from, { text: kissMessage, mentions });
                const stickerBuffer = await getRandomKissSticker();
                if (stickerBuffer) await sock.sendMessage(from, { sticker: stickerBuffer });
            } catch (error) {
                log(LOG_LEVELS.ERROR, `Error en kiss: ${error}`);
                await sock.sendMessage(from, { text: "❌ Error al procesar el comando !kiss" });
            }
            return;
        }

        // ========== MENÚ ==========
        // ========== MENÚ ==========
        if (command === "menu") {
            let menuText = `╔════════════════════════════════════╗\n`;
            menuText += `║           ✨ ${BOT_CONFIG.botName} ✨           ║\n`;
            menuText += `╠════════════════════════════════════╣\n`;
            menuText += `║  🤖 COMANDOS BÁSICOS               ║\n`;
            menuText += `║────────────────────────────────────║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}hola      - Saludo              ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}ping      - Latencia           ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}menu      - Este menú          ║\n`;
            menuText += `║────────────────────────────────────║\n`;
            menuText += `║  🎨 MULTIMEDIA                     ║\n`;
            menuText += `║────────────────────────────────────║\n`;
            menuText += `║ Envía imagen/GIF/video → sticker   ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}sticker   - Convierte multimedia  ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}s         - (alias)              ║\n`;
            menuText += `║────────────────────────────────────║\n`;
            menuText += `║  💕 COMANDOS DE DIVERCIÓN          ║\n`;
            menuText += `║────────────────────────────────────║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}kiss @user - Beso anime 💋      ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}detonar @user - Hacer la detonacion >:3 💥 ║\n`;
            menuText += `║ ${BOT_CONFIG.prefix}fruti @user - Frutifantástico 🍍  ║\n`;
            if (isGroup) {
                menuText += `║────────────────────────────────────║\n`;
                menuText += `║  📚 COMANDOS DE GRUPO              ║\n`;
                menuText += `║────────────────────────────────────║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}grupoinfo - Info del grupo      ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}miembros  - Lista de miembros   ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}reglas    - Ver/editar reglas   ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}admin     - Lista admins        ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}link      - Link del grupo      ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}pp        - Foto de perfil      ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}apk <app>   - Descarga APK de APKPure ║\n`;
                menuText += `║────────────────────────────────────║\n`;
                menuText += `║  👑 COMANDOS DE ADMIN              ║\n`;
                menuText += `║────────────────────────────────────║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}ban @user    - Expulsar           ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}kick @user   - Expulsar (alias)   ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}mute @user   - Silenciar (1h)     ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}unmute @user - Quitar silencio    ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}promote @user - Dar admin         ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}demote @user - Quitar admin       ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}warn @user   - Advertir           ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}warns @user  - Ver warns         ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}delwarn @user - Borrar warns      ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}resetwarns @user (alias)          ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}delete      - Borrar mensaje (resp)║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}del          - (alias)            ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}clear        - Borrar 100 msgs    ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}lock         - Cerrar grupo       ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}unlock       - Abrir grupo        ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}antilink on/off - Anti-enlaces    ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}antispam on/off - Anti-spam       ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}welcome on/off - Bienvenidas      ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}goodbye on/off - Despedidas       ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}setname texto - Cambiar nombre    ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}setdesc texto - Cambiar desc      ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}setpp        - Cambiar ícono      ║\n`;
                menuText += `║────────────────────────────────────║\n`;
                menuText += `║  ⭐ COMANDOS DE SUPER ADMIN        ║\n`;
                menuText += `║────────────────────────────────────║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}broadcast msg - Difundir           ║\n`;
                menuText += `║ ${BOT_CONFIG.prefix}stats        - Estadísticas       ║\n`;
            }
            menuText += `╚════════════════════════════════════╝`;
            await sock.sendMessage(from, { text: menuText });
        }


        // ========== COMANDOS DE GRUPO ==========
        if (isGroup) {
            if (command === "grupoinfo") {
                try {
                    const metadata = await sock.groupMetadata(from);
                    const participants = metadata.participants;
                    const admins = participants.filter(p => p.admin === "admin" || p.admin === "superadmin");
                    const superAdmins = participants.filter(p => p.admin === "superadmin");
                    let adminsText = "", adminMentions = [];
                    for (let i = 0; i < Math.min(admins.length, 5); i++) {
                        const admin = admins[i];
                        const adminName = await getDisplayName(sock, admin.id);
                        const phone = admin.id.split('@')[0];
                        adminsText += `• @${phone} (${adminName})\n`;
                        adminMentions.push(admin.id);
                    }
                    if (admins.length > 5) adminsText += `• +${admins.length - 5} más\n`;
                    let info = `📊 INFO DEL GRUPO\n━━━━━━━━━━━━━━━━━━━\n📛 Nombre: ${metadata.subject}\n🆔 ID: ${metadata.id}\n👥 Miembros: ${participants.length}\n👑 Admins: ${admins.length}\n⭐ Super Admins: ${superAdmins.length}\n📝 Tema: ${metadata.desc?.substring(0, 50) || "Sin descripción"}\n🔒 Restringido: ${metadata.restrict ? "Sí" : "No"}\n📢 Anuncios: ${metadata.announce ? "Solo admins" : "Todos pueden enviar"}\n🕒 Creado: ${new Date(metadata.creation * 1000).toLocaleDateString()}\n━━━━━━━━━━━━━━━━━━━\n👑 ADMINISTRADORES:\n${adminsText}`;
                    await sock.sendMessage(from, { text: info, mentions: adminMentions });
                } catch (err) { await sock.sendMessage(from, { text: "❌ Error obteniendo info del grupo" }); }
            }



            // ========== COMANDO !APK ==========
            if (command === "apk") {
                try {
                    const searchTerm = args.join(" ").trim();
                    if (!searchTerm) {
                        await sock.sendMessage(from, { text: `❌ Uso: ${BOT_CONFIG.prefix}apk <nombre> - Busca y descarga APK desde APKPure.\nEjemplo: ${BOT_CONFIG.prefix}apk facebook` });
                        return;
                    }

                    await sock.sendMessage(from, { text: `🔍 Buscando "${searchTerm}" en APKPure...` });

                    const apkInfo = await searchApkPure(searchTerm);
                    if (!apkInfo || !apkInfo.downloadUrl) {
                        await sock.sendMessage(from, { text: `❌ No se encontró ningún APK para "${searchTerm}". Intenta con otro nombre.` });
                        return;
                    }

                    await sock.sendMessage(from, { text: `📥 Descargando ${apkInfo.name}... (puede tomar unos segundos)` });

                    const apkBuffer = await downloadApk(apkInfo.downloadUrl);
                    if (!apkBuffer || apkBuffer.length < 1000) {
                        await sock.sendMessage(from, { text: `❌ Error al descargar el APK. El archivo puede no estar disponible.` });
                        return;
                    }

                    const sizeMB = (apkBuffer.length / (1024 * 1024)).toFixed(2);
                    if (apkBuffer.length > 100 * 1024 * 1024) {
                        await sock.sendMessage(from, { text: `⚠️ El archivo es muy grande (${sizeMB} MB). WhatsApp puede rechazar el envío.` });
                    }

                    await sock.sendMessage(from, {
                        document: apkBuffer,
                        mimetype: 'application/vnd.android.package-archive',
                        fileName: `${apkInfo.name.replace(/[^a-z0-9]/gi, '_')}.apk`,
                        caption: `📱 *${apkInfo.name}*\n📦 Tamaño: ${sizeMB} MB\n🔗 Descargado por ${BOT_CONFIG.botName}`
                    });
                    log(LOG_LEVELS.SUCCESS, `APK enviado: ${apkInfo.name} (${sizeMB} MB)`);
                } catch (error) {
                    log(LOG_LEVELS.ERROR, `Error en !apk: ${error}`);
                    await sock.sendMessage(from, { text: "❌ Error al procesar el comando !apk. Intenta más tarde." });
                }
                return;
            }

            // ========== COMANDO FRUTIFANTÁSTICO ==========
            if (command === "detonar" || command === "fruti") {
                try {
                    let target = null;
                    let targetName = null;
                    
                    const senderName = msg.pushName || await getDisplayName(sock, sender);
                    const mentionedUsers = await getMentionedUsersAdvanced(sock, msg, from, isGroup);
                    
                    if (mentionedUsers.length > 0) {
                        target = mentionedUsers[0];
                        targetName = await getDisplayName(sock, target);
                    } else if (getQuotedMessageSender(msg)) {
                        target = getQuotedMessageSender(msg);
                        targetName = await getDisplayName(sock, target);
                    } else if (isGroup) {
                        const metadata = await sock.groupMetadata(from);
                        const otherMembers = metadata.participants.filter(p => p.id !== sender);
                        if (otherMembers.length) {
                            const randomMember = otherMembers[Math.floor(Math.random() * otherMembers.length)];
                            target = randomMember.id;
                            targetName = await getDisplayName(sock, target);
                        }
                    }
                    
                    const frutiPhrases = [
                        " se violó a", " se detonó a", " se folló a", " le rompió el orto a",
                        " se cumeo a", " se la jaló en la cara de"
                    ];
                    
                    const randomPhrase = frutiPhrases[Math.floor(Math.random() * frutiPhrases.length)];
                    let frutiMessage = "", mentions = [];
                    const senderPhone = sender.split('@')[0];
                    
                    if (target === sender) {
                        frutiMessage = `@${senderPhone} se hizo violó a si mismo`;
                        mentions.push(sender);
                    } else if (target && targetName) {
                        const targetPhone = target.split('@')[0];
                        frutiMessage = `@${senderPhone} ${randomPhrase} @${targetPhone} (${targetName}) `;
                        mentions.push(sender, target);
                    } else {
                        frutiMessage = `@${senderPhone} ${randomPhrase} el vacío `;
                        mentions.push(sender);
                    }
                    
                    await sock.sendMessage(from, { text: frutiMessage, mentions });
                    
                    // Reutilizar el sticker de explosión (si existe)
                    const stickerBuffer = await getRandomExplosionSticker();
                    if (stickerBuffer) {
                        await sock.sendMessage(from, { sticker: stickerBuffer });
                    } else {
                        await sock.sendMessage(from, { text: "SEXOOOOOOOOOOOOOOOOOOOOOOOOOOOOO" });
                    }
                    
                    log(LOG_LEVELS.INFO, `!frutifantastico usado por ${senderName} → ${targetName || "nadie"}`);
                    
                } catch (error) {
                    log(LOG_LEVELS.ERROR, `Error en frutifantastico: ${error}`);
                    await sock.sendMessage(from, { text: "❌ Error al hacer el frutifantástico" });
                }
                return;
            }

            if (command === "admin" || command === "admins") {
                try {
                    const metadata = await sock.groupMetadata(from);
                    const admins = metadata.participants.filter(p => p.admin === "admin" || p.admin === "superadmin");
                    let adminList = "👑 LISTA DE ADMINISTRADORES:\n━━━━━━━━━━━━━━━━━\n";
                    const mentions = [];
                    for (let i = 0; i < admins.length; i++) {
                        const admin = admins[i];
                        const adminName = await getDisplayName(sock, admin.id);
                        const phoneNumber = admin.id.split('@')[0];
                        const adminTag = admin.admin === "superadmin" ? "🌟 " : "👑 ";
                        adminList += `${adminTag}${i+1}. @${phoneNumber}\n`;
                        mentions.push(admin.id);
                    }
                    await sock.sendMessage(from, { text: adminList, mentions });
                } catch (err) { await sock.sendMessage(from, { text: "❌ Error obteniendo admins" }); }
            }

            if (command === "miembros") {
                try {
                    const metadata = await sock.groupMetadata(from);
                    let miembrosList = "👥 LISTA DE MIEMBROS:\n━━━━━━━━━━━━━━━━━\n";
                    const participants = metadata.participants;
                    const mentions = [];
                    for (let i = 0; i < Math.min(participants.length, 20); i++) {
                        const p = participants[i];
                        const nombreReal = await getDisplayName(sock, p.id);
                        const phoneNumber = p.id.split('@')[0];
                        const adminTag = p.admin === "admin" ? "👑 " : p.admin === "superadmin" ? "🌟 " : "  ";
                        miembrosList += `${adminTag}${i+1}. @${phoneNumber}\n`;
                        mentions.push(p.id);
                    }
                    if (participants.length > 20) miembrosList += `\n... y ${participants.length - 20} miembros más`;
                    miembrosList += `\n━━━━━━━━━━━━━━━━━\n📊 Total: ${participants.length} miembros`;
                    await sock.sendMessage(from, { text: miembrosList, mentions });
                } catch (err) { await sock.sendMessage(from, { text: "❌ Error obteniendo miembros" }); }
            }

            if (command === "link") {
                try {
                    const inviteCode = await sock.groupInviteCode(from);
                    await sock.sendMessage(from, { text: `🔗 Link de invitación:\nhttps://chat.whatsapp.com/${inviteCode}` });
                } catch (err) { await sock.sendMessage(from, { text: "❌ No se pudo obtener el link. Asegúrate de que soy admin." }); }
            }

            if (command === "pp") {
                try {
                    const ppUrl = await sock.profilePictureUrl(from, "image");
                    await sock.sendMessage(from, { text: `🖼️ Foto de perfil del grupo:\n${ppUrl}` });
                } catch (err) { await sock.sendMessage(from, { text: "❌ El grupo no tiene foto de perfil." }); }
            }

            if (command === "reglas") {
                if (args[0] === "set" && args.length > 1 && isAdmin) {
                    const rules = args.slice(1).join(" ");
                    fs.writeFileSync(`./rules_${from}.txt`, rules);
                    await sock.sendMessage(from, { text: `📋 Reglas actualizadas:\n━━━━━━━━━━━━━━━━━\n${rules}` });
                } else {
                    let rules = "📋 REGLAS DEL GRUPO\n━━━━━━━━━━━━━━━━━\n";
                    if (fs.existsSync(`./rules_${from}.txt`)) rules += fs.readFileSync(`./rules_${from}.txt`, "utf-8");
                    else rules += `1️⃣ Respeta a todos los miembros\n2️⃣ Sin spam ni publicidad\n3️⃣ Contenido apropiado\n4️⃣ No compartir números sin permiso\n5️⃣ Sigue las instrucciones de los admins\n\n✏️ Usa "${BOT_CONFIG.prefix}reglas set [texto]" para actualizar`;
                    await sock.sendMessage(from, { text: rules });
                }
            }

            // ========== ADMINISTRACIÓN ==========
            if (!isAdmin && !["menu","hola","ping","kiss","grupoinfo","miembros","reglas","admin"].includes(command)) {
                await sock.sendMessage(from, { text: "❌ Solo administradores pueden usar este comando." });
                return;
            }

            function getMentionedJids(msg) {
                const jids = [];
                if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid) jids.push(...msg.message.extendedTextMessage.contextInfo.mentionedJid);
                if (msg.message?.extendedTextMessage?.contextInfo?.participant) jids.push(msg.message.extendedTextMessage.contextInfo.participant);
                return jids;
            }

            if (command === "ban" || command === "kick") {
                let mentioned = getMentionedJids(msg);
                if (mentioned.length === 0 && getQuotedMessageSender(msg)) mentioned.push(getQuotedMessageSender(msg));
                if (mentioned.length === 0) return await sock.sendMessage(from, { text: "❌ Menciona al usuario que quieres expulsar o responde a su mensaje." });
                for (const user of mentioned) {
                    try {
                        await sock.groupParticipantsUpdate(from, [user], "remove");
                        const userName = await getDisplayName(sock, user);
                        const phone = user.split('@')[0];
                        await sock.sendMessage(from, { text: `🚫 @${phone} (${userName}) ha sido expulsado del grupo.`, mentions: [user] });
                    } catch { await sock.sendMessage(from, { text: `❌ No se pudo expulsar al usuario` }); }
                }
            }

            if (command === "mute") {
                let mentioned = getMentionedJids(msg);
                if (mentioned.length === 0 && getQuotedMessageSender(msg)) mentioned.push(getQuotedMessageSender(msg));
                if (mentioned.length === 0) return await sock.sendMessage(from, { text: "❌ Menciona al usuario que quieres silenciar o responde a su mensaje." });
                let duration = 3600000;
                if (args.length > 0 && !isNaN(args[0]) && !args[0].startsWith("@")) duration = parseInt(args[0]) * 60000;
                for (const user of mentioned) {
                    mutedUsers.set(`${from}|${user}`, Date.now() + duration);
                    const userName = await getDisplayName(sock, user);
                    const phone = user.split('@')[0];
                    const durationText = duration === 3600000 ? "1 hora" : `${duration/60000} minutos`;
                    await sock.sendMessage(from, { text: `🔇 @${phone} (${userName}) ha sido silenciado por ${durationText}.`, mentions: [user] });
                }
            }


            // ========== COMANDO FRUTIFANTÁSTICO ==========



            if (command === "unmute") {
                let mentioned = getMentionedJids(msg);
                if (mentioned.length === 0 && getQuotedMessageSender(msg)) mentioned.push(getQuotedMessageSender(msg));
                if (mentioned.length === 0) return await sock.sendMessage(from, { text: "❌ Menciona al usuario que quieres desilenciar o responde a su mensaje." });
                for (const user of mentioned) {
                    mutedUsers.delete(`${from}|${user}`);
                    const userName = await getDisplayName(sock, user);
                    const phone = user.split('@')[0];
                    await sock.sendMessage(from, { text: `🔊 @${phone} (${userName}) ya puede enviar mensajes.`, mentions: [user] });
                }
            }

            if (command === "promote") {
                let mentioned = getMentionedJids(msg);
                if (mentioned.length === 0 && getQuotedMessageSender(msg)) mentioned.push(getQuotedMessageSender(msg));
                if (mentioned.length === 0) return await sock.sendMessage(from, { text: "❌ Menciona al usuario que quieres hacer admin o responde a su mensaje." });
                for (const user of mentioned) {
                    try {
                        await sock.groupParticipantsUpdate(from, [user], "promote");
                        const userName = await getDisplayName(sock, user);
                        const phone = user.split('@')[0];
                        await sock.sendMessage(from, { text: `👑 @${phone} (${userName}) ahora es administrador.`, mentions: [user] });
                    } catch { await sock.sendMessage(from, { text: `❌ No se pudo promover al usuario` }); }
                }
            }

            if (command === "demote") {
                let mentioned = getMentionedJids(msg);
                if (mentioned.length === 0 && getQuotedMessageSender(msg)) mentioned.push(getQuotedMessageSender(msg));
                if (mentioned.length === 0) return await sock.sendMessage(from, { text: "❌ Menciona al usuario que quieres quitar admin o responde a su mensaje." });
                for (const user of mentioned) {
                    try {
                        await sock.groupParticipantsUpdate(from, [user], "demote");
                        const userName = await getDisplayName(sock, user);
                        const phone = user.split('@')[0];
                        await sock.sendMessage(from, { text: `📛 @${phone} (${userName}) ya no es administrador.`, mentions: [user] });
                    } catch { await sock.sendMessage(from, { text: `❌ No se pudo degradar al usuario` }); }
                }
            }

            if (command === "warn") {
                let mentioned = getMentionedJids(msg);
                if (mentioned.length === 0 && getQuotedMessageSender(msg)) mentioned.push(getQuotedMessageSender(msg));
                if (mentioned.length === 0) return await sock.sendMessage(from, { text: "❌ Menciona al usuario que quieres advertir o responde a su mensaje." });
                for (const user of mentioned) {
                    const warnKey = `${from}|${user}`;
                    const currentWarns = (warnings.get(warnKey) || 0) + 1;
                    warnings.set(warnKey, currentWarns);
                    const userName = await getDisplayName(sock, user);
                    const phone = user.split('@')[0];
                    await sock.sendMessage(from, { text: `⚠️ @${phone} (${userName}) ha recibido una advertencia.\nAdvertencias: ${currentWarns}/${BOT_CONFIG.maxWarnings}`, mentions: [user] });
                    if (currentWarns >= BOT_CONFIG.maxWarnings) {
                        await sock.groupParticipantsUpdate(from, [user], "remove");
                        await sock.sendMessage(from, { text: `🚫 @${phone} (${userName}) ha sido expulsado por exceder el límite de advertencias.`, mentions: [user] });
                        warnings.delete(warnKey);
                    }
                }
            }

            if (command === "warns") {
                let mentioned = getMentionedJids(msg);
                if (mentioned.length === 0 && getQuotedMessageSender(msg)) mentioned.push(getQuotedMessageSender(msg));
                if (mentioned.length === 0) return await sock.sendMessage(from, { text: "❌ Menciona al usuario para ver sus advertencias o responde a su mensaje." });
                for (const user of mentioned) {
                    const warnKey = `${from}|${user}`;
                    const currentWarns = warnings.get(warnKey) || 0;
                    const userName = await getDisplayName(sock, user);
                    const phone = user.split('@')[0];
                    await sock.sendMessage(from, { text: `📋 @${phone} (${userName}) tiene ${currentWarns}/${BOT_CONFIG.maxWarnings} advertencias.`, mentions: [user] });
                }
            }

            if (command === "delwarn" || command === "resetwarns") {
                let mentioned = getMentionedJids(msg);
                if (mentioned.length === 0 && getQuotedMessageSender(msg)) mentioned.push(getQuotedMessageSender(msg));
                if (mentioned.length === 0) return await sock.sendMessage(from, { text: "❌ Menciona al usuario para borrar sus advertencias o responde a su mensaje." });
                for (const user of mentioned) {
                    warnings.delete(`${from}|${user}`);
                    const userName = await getDisplayName(sock, user);
                    const phone = user.split('@')[0];
                    await sock.sendMessage(from, { text: `✅ Se han borrado las advertencias de @${phone} (${userName}).`, mentions: [user] });
                }
            }

            if (command === "delete" || command === "del") {
                const quotedMsgId = getQuotedMessageId(msg);
                const quotedParticipant = getQuotedMessageSender(msg);
                if (quotedMsgId) {
                    const key = { remoteJid: from, fromMe: false, id: quotedMsgId, participant: quotedParticipant || from };
                    await sock.sendMessage(from, { delete: key });
                    await sock.sendMessage(from, { text: "✅ Mensaje eliminado." });
                } else await sock.sendMessage(from, { text: "❌ Responde al mensaje que quieres eliminar con !delete" });
            }

            if (command === "clear") await sock.sendMessage(from, { text: "⚠️ Esta función no está completamente soportada en WhatsApp Web." });
            if (command === "lock") { await sock.groupSettingUpdate(from, "announcement"); await sock.sendMessage(from, { text: "🔒 Grupo cerrado. Solo admins pueden enviar mensajes." }); }
            if (command === "unlock") { await sock.groupSettingUpdate(from, "not_announcement"); await sock.sendMessage(from, { text: "🔓 Grupo abierto. Todos pueden enviar mensajes." }); }

            if (command === "antilink") {
                if (args[0] === "on") { BOT_CONFIG.antiLink = true; await sock.sendMessage(from, { text: "✅ Anti-enlaces activado." }); }
                else if (args[0] === "off") { BOT_CONFIG.antiLink = false; await sock.sendMessage(from, { text: "❌ Anti-enlaces desactivado." }); }
                else await sock.sendMessage(from, { text: `📋 Anti-enlaces: ${BOT_CONFIG.antiLink ? "activado" : "desactivado"}\nUsa ${BOT_CONFIG.prefix}antilink on/off` });
            }
            if (command === "antispam") {
                if (args[0] === "on") { BOT_CONFIG.antiSpam = true; await sock.sendMessage(from, { text: "✅ Anti-spam activado." }); }
                else if (args[0] === "off") { BOT_CONFIG.antiSpam = false; await sock.sendMessage(from, { text: "❌ Anti-spam desactivado." }); }
                else await sock.sendMessage(from, { text: `📋 Anti-spam: ${BOT_CONFIG.antiSpam ? "activado" : "desactivado"}\nUsa ${BOT_CONFIG.prefix}antispam on/off` });
            }
            if (command === "welcome") {
                if (args[0] === "on") { BOT_CONFIG.welcomeEnabled = true; await sock.sendMessage(from, { text: "✅ Mensajes de bienvenida activados." }); }
                else if (args[0] === "off") { BOT_CONFIG.welcomeEnabled = false; await sock.sendMessage(from, { text: "❌ Mensajes de bienvenida desactivados." }); }
                else await sock.sendMessage(from, { text: `📋 Bienvenidas: ${BOT_CONFIG.welcomeEnabled ? "activadas" : "desactivadas"}` });
            }
            if (command === "goodbye") {
                if (args[0] === "on") { BOT_CONFIG.goodbyeEnabled = true; await sock.sendMessage(from, { text: "✅ Mensajes de despedida activados." }); }
                else if (args[0] === "off") { BOT_CONFIG.goodbyeEnabled = false; await sock.sendMessage(from, { text: "❌ Mensajes de despedida desactivados." }); }
                else await sock.sendMessage(from, { text: `📋 Despedidas: ${BOT_CONFIG.goodbyeEnabled ? "activadas" : "desactivadas"}` });
            }
            if (command === "setname") {
                const newName = args.join(" ");
                if (!newName) return await sock.sendMessage(from, { text: "❌ Escribe el nuevo nombre del grupo.\nEjemplo: !setname Mi Grupo" });
                await sock.groupUpdateSubject(from, newName);
                await sock.sendMessage(from, { text: `✅ Nombre del grupo actualizado a: ${newName}` });
            }
            if (command === "setdesc") {
                const newDesc = args.join(" ");
                if (!newDesc) return await sock.sendMessage(from, { text: "❌ Escribe la nueva descripción.\nEjemplo: !setdesc Bienvenidos al grupo" });
                await sock.groupUpdateDescription(from, newDesc);
                await sock.sendMessage(from, { text: `✅ Descripción actualizada.` });
            }
            if (command === "setpp" && msg.message.imageMessage) {
                try {
                    const media = await sock.downloadMediaMessage(msg);
                    await sock.updateProfilePicture(from, media);
                    await sock.sendMessage(from, { text: "✅ Foto de perfil del grupo actualizada." });
                } catch { await sock.sendMessage(from, { text: "❌ Error al actualizar la foto. Asegúrate de enviar una imagen con el comando." }); }
            }
        }

        // ========== COMANDOS PARA ADMINS DEL BOT ==========
        const isBotAdmin = BOT_CONFIG.admins.includes(sender.split('@')[0]);
        if (isBotAdmin && command === "broadcast") {
            const broadcastMsg = args.join(" ");
            if (!broadcastMsg) return await sock.sendMessage(from, { text: "❌ Escribe un mensaje para difundir" });
            await sock.sendMessage(from, { text: "📢 Iniciando difusión..." });
            const groups = await sock.groupFetchAllParticipating();
            let sent = 0, failed = 0;
            for (const groupId in groups) {
                try {
                    await sock.sendMessage(groupId, { text: `📢 ANUNCIO:\n\n${broadcastMsg}` });
                    sent++;
                    await new Promise(resolve => setTimeout(resolve, 1500));
                } catch { failed++; }
            }
            await sock.sendMessage(from, { text: `✅ Difusión completada!\n📨 Enviados: ${sent} grupos\n❌ Fallidos: ${failed} grupos` });
        }
        if (isBotAdmin && command === "stats") {
            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600), minutes = Math.floor((uptime % 3600) / 60), seconds = Math.floor(uptime % 60);
            const gifsCount = fs.existsSync(path.join(__dirname, 'gifs')) ? fs.readdirSync(path.join(__dirname, 'gifs')).filter(f => f.endsWith('.gif') || f.endsWith('.mp4')).length : 0;
            const stats = `📊 ESTADÍSTICAS DEL BOT\n━━━━━━━━━━━━━━━━━\n⏱️ Uptime: ${hours}h ${minutes}m ${seconds}s\n🤖 Nombre: ${BOT_CONFIG.botName}\n📋 Prefijo: ${BOT_CONFIG.prefix}\n💋 Kiss: Activo (${gifsCount} GIFs)\n🛡️ Anti-spam: ${BOT_CONFIG.antiSpam ? "Activado" : "Desactivado"}\n🔗 Anti-link: ${BOT_CONFIG.antiLink ? "Activado" : "Desactivado"}`;
            await sock.sendMessage(from, { text: stats });
        }
    });
}

process.on("uncaughtException", (err) => log(LOG_LEVELS.ERROR, `Error no capturado: ${err.message}`));
process.on("unhandledRejection", (reason) => log(LOG_LEVELS.ERROR, `Promesa rechazada: ${reason}`));

log(LOG_LEVELS.BOT, `Iniciando ${BOT_CONFIG.botName}...`);
startBot().catch(err => { log(LOG_LEVELS.ERROR, `Error fatal: ${err.message}`); process.exit(1); });