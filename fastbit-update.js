const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs'); 

// --- Variabel Konfigurasi Dasar ---
const TELEGRAM_BOT_TOKEN = "7348650612:AAGxw63Hs1bzLBr994f07dkMeRNwI_-_f9w"; 

// --- KONFIGURASI API KEY (Daftar API Key untuk Failover) ---
const API_KEY_LIST = [
    { key: "jxA5WWudkNyCsavNUJiTRktDoiJ4i358", limit_reached_at: null, index: 0 },
    { key: "YTJwp36jS0THRiJ74YWs8Vxj7TxYIQAU", limit_reached_at: null, index: 1 },
    { key: "y5OmMGlJY9SCRuLo99WzHSZGtNMvPHwd", limit_reached_at: null, index: 2 },
    { key: "LAF19i8MvV1n8P5wdDmEmwIRBIby4zGT", limit_reached_at: null, index: 3 }
];

let currentKeyIndex = 0;
const REFRESH_DELAY_MS = 20 * 60 * 1000; 

// --- Konstanta Logging ---
const LOG_FILE = 'aktivitas_bot.txt';
const HISTORY_FILE = 'riwayat_order.json'; 

// --- Fungsi Utilitas File System (tidak berubah) ---
function writeLog(message) {
    const timestamp = new Date().toLocaleString('id-ID');
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFile(LOG_FILE, logEntry, (err) => {
        if (err) console.error('Gagal menulis log ke file:', err);
    });
}

function readHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            return JSON.parse(data);
        }
        return {};
    } catch (e) {
        console.error('Gagal membaca file riwayat:', e);
        return {};
    }
}

function writeHistory(history) {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (e) {
        console.error('Gagal menulis file riwayat:', e);
    }
}

function updateHistory(chatId, orderId, number, service, status) {
    const history = readHistory();
    if (!history[chatId]) {
        history[chatId] = [];
    }
    
    const index = history[chatId].findIndex(item => item.id === orderId);
    const timestamp = new Date().toLocaleString('id-ID');

    if (index !== -1) {
        const currentItem = history[chatId][index];
        
        // PASTIKAN NILAI LAMA DIAMBIL JIKA YANG BARU ADALAH NULL
        const finalNumber = number || currentItem.number;
        const finalService = service || currentItem.service;
        
        history[chatId][index] = { 
            ...currentItem, 
            number: finalNumber,
            service: finalService,
            status, 
            timestamp 
        };
    } else {
        // Jika ini adalah order baru (status ACTIVE), gunakan data yang masuk
        history[chatId].push({ id: orderId, number, service, status, timestamp });
    }
    
    writeHistory(history);
}
// --- AKHIR FUNGSI UTILITIES ---


// --- Endpoints & Konstanta Bisnis ---
const PROFILE_URL = "https://fastbit.tech/api/profile";
const GENERATE_ORDER_URL = "https://fastbit.tech/api/virtual-number/generate-order"; 
const ORDER_DETAILS_BASE_URL = "https://fastbit.tech/api/virtual-number/orders"; 
const ORDER_BASE_URL = "https://fastbit.tech/api/virtual-number/orders"; 

// Konstanta Retry Umum (Untuk mendapatkan nomor virtual)
const MAX_RETRIES = 6; 
const RETRY_DELAY = 1000; 

// --- KONSTANTA POLLING OTP (10 Detik per check, TOTAL 60 DETIK) ---
const MAX_OTP_CHECKS = 6; // 6 kali coba ulang
const OTP_CHECK_DELAY = 10000; // 10 detik delay per coba ulang
const TOTAL_POLLING_TIME = (MAX_OTP_CHECKS * OTP_CHECK_DELAY) / 1000; // 60 detik
// -------------------------------------------------------------------

// ID Layanan dan Provider yang terfokus
const TARGET_SERVICE_FORE = 1368;        
const TARGET_SERVICE_KENANGAN = 1371; 

// --- KONFIGURASI FAILOVER SERVICE ID ---
// DAFTAR PRIORITAS UNTUK FORE COFFEE
const FORE_SERVICE_PRIORITY = [
    { service_id: 1368, otp_id: 145163, name: "FORE COFFEE (P1)" },
    { service_id: 1368, otp_id: 145980, name: "FORE COFFEE (P2)" },
    { service_id: 1368, otp_id: 145987, name: "FORE COFFEE (P3)" },
    { service_id: 1368, otp_id: 145979, name: "FORE COFFEE (P4)" },
    { service_id: 1368, otp_id: 145990, name: "FORE COFFEE (P5)" },
    { service_id: 1368, otp_id: 145982, name: "FORE COFFEE (P6)" },
    { service_id: 1368, otp_id: 145981, name: "FORE COFFEE (P7)" },
    { service_id: 1368, otp_id: 145977, name: "FORE COFFEE (P8)" },
    { service_id: 1368, otp_id: 145978, name: "FORE COFFEE (P9)" },
    { service_id: 1368, otp_id: 145976, name: "FORE COFFEE (P10)" },
    { service_id: 1368, otp_id: 145163, name: "FORE COFFEE (P11)" },

    // Tambahkan jika ada alternatif Fore
];

// DAFTAR PRIORITAS UNTUK KOPI KENANGAN (Prioritas 1 akan dicoba lebih dulu)
const KENANGAN_SERVICE_PRIORITY = [
    { service_id: 1371, otp_id: 144477, name: "KOPI KENANGAN (P1)" }, // ID Lama/Utama
    { service_id: 1371, otp_id: 145992, name: "KOPI KENANGAN (P2)" }, // ID Baru/Alternatif
    // Tambahkan service ID baru di sini jika ada lagi
];
// ----------------------------------------


// Variabel dan Fungsi Utilitas
let activeOrders = {}; 
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Fungsi untuk mendapatkan/mengganti API Key (tidak berubah) ---
function getCurrentApiKey() {
    const index = getCurrentApiKeyIndex();
    if (index === -1) return null; 
    return API_KEY_LIST[index].key;
}

function getCurrentApiKeyIndex() {
    for (let i = 0; i < API_KEY_LIST.length; i++) {
        const keyData = API_KEY_LIST[i];
        if (!keyData.limit_reached_at) {
            return i;
        }
        if (i === 0 && Date.now() - keyData.limit_reached_at > REFRESH_DELAY_MS) {
            keyData.limit_reached_at = null;
            writeLog(`[FAILOVER RESET] Limit Key Utama ${keyData.key.substring(0, 5)}.... direset setelah 20 menit.`);
            return 0;
        }
    }
    return -1; 
}

function switchApiKey() {
    const oldKey = getCurrentApiKey();
    // Cari data key yang sedang aktif untuk di-update status limitnya
    const oldKeyData = API_KEY_LIST.find(k => k.key === oldKey);
    // Hanya set limit_reached_at jika key tersebut benar-benar ditemukan
    if (oldKeyData) {
       oldKeyData.limit_reached_at = Date.now();
    }
    
    for (let i = 1; i <= API_KEY_LIST.length; i++) {
        // Logika sederhana untuk mencari key berikutnya yang belum limit
        const nextIndex = (oldKeyData.index + i) % API_KEY_LIST.length;
        const newKeyData = API_KEY_LIST[nextIndex];
        
        if (!newKeyData.limit_reached_at) {
            currentKeyIndex = newKeyData.index; 
            writeLog(`[FAILOVER] Key ${oldKey.substring(0, 5)}.... mencapai limit. Beralih ke Key ${newKeyData.key.substring(0, 5)}....`);
            return newKeyData.key;
        }
    }
    
    currentKeyIndex = 0;
    writeLog(`[FAILOVER MAX] Semua key mencapai limit. Kembali ke Key Utama untuk menunggu 20 menit.`);
    return null; 
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- TANGANI POLLING ERROR (tidak berubah) ---
bot.on('polling_error', (err) => {
    console.error(`[TELEGRAM POLLING ERROR] ${err.code || 'UNKNOWN'}: ${err.message || ''}`);
    writeLog(`[TELEGRAM POLLING ERROR] ${err.code || 'UNKNOWN'}`);
});
// ----------------------------

console.log("Bot Telegram MIWE-BOT sedang berjalan...");
writeLog("Bot dimulai dan siap melayani."); 


// =======================================================
// FUNGSI WRAPPER LOG PESAN CHAT
// =======================================================
async function logAndSend(chatId, text, options) {
    writeLog(`[CHAT OUT] To ${chatId}: ${text.substring(0, 50)}...`);
    return bot.sendMessage(chatId, text, options);
}

// FUNGSI MODIFIKASI UNTUK MENANGANI ERROR "MESSAGE NOT MODIFIED"
async function logAndEdit(chatId, messageId, text, options) {
    writeLog(`[CHAT EDIT] Msg ID ${messageId} to ${chatId}: ${text.substring(0, 50)}...`);
    try {
        return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch (error) {
        // Cek jika error adalah 'message is not modified' (400 Bad Request)
        const errorMsg = error.response?.body?.description || error.message;
        if (error.code === 'ETELEGRAM' && errorMsg.includes('message is not modified')) {
            // Abaikan error ini agar polling dapat berlanjut tanpa crash
            writeLog(`[WARN] Edit diabaikan: Konten tidak berubah. Msg ID: ${messageId}`);
            return; 
        }
        // Lemparkan error lainnya
        throw error;
    }
}
// =======================================================


// =======================================================
// FUNGSI API KEY FAILOVER (dengan logging error detail)
// =======================================================
async function tryGenerateOrderWithFailover(url_generate) {
    const maxFailoverAttempts = API_KEY_LIST.length;
    let attempts = 0;
    
    while (attempts < maxFailoverAttempts) {
        const currentApiKey = getCurrentApiKey();
        if (!currentApiKey) return { success: false, message: "Semua API Key mencapai limit dan belum direset." };

        const headers = { "X-API-KEY": currentApiKey, "Content-Type": "application/json" };
        
        try {
            const response = await axios.get(url_generate, { headers });
            const result = response.data;

            if (result.success) {
                return { success: true, result, apiKey: currentApiKey };
            }
            
            const errorMessage = result.message || 'Respons API non-sukses tanpa pesan.';
            // LOGGING RESPONS GAGAL DARI API (200 OK, tapi success: false)
            writeLog(`[API FAIL] Key ${currentApiKey.substring(0, 5)}.... gagal. Pesan: ${errorMessage} (Attempt ${attempts + 1})`);
            
            if (errorMessage.toLowerCase().includes('insufficient balance')) {
                if (attempts < maxFailoverAttempts - 1) {
                    switchApiKey();
                    attempts++;
                    continue; 
                } else {
                    return { success: false, result, message: "Semua API Key kehabisan saldo." };
                }
            } else {
                return { success: false, result, message: errorMessage };
            }

        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            
            // LOGGING KESALAHAN JARINGAN/HTTP STATUS DARI AXIOS
            const status = error.response?.status || 'No Status';
            writeLog(`[HTTP ERR] Key ${currentApiKey.substring(0, 5)}.... HTTP ${status}. Pesan: ${errorMsg} (Attempt ${attempts + 1})`);


            let shouldFailover = false;

            if (error.response?.status === 400 && errorMsg.toLowerCase().includes('insufficient balance')) {
                shouldFailover = true;
            } else if (error.response?.status === 401 || error.response?.status === 403 || errorMsg.toLowerCase().includes('invalid token')) { 
                shouldFailover = true;
            }

            if (shouldFailover) {
                if (attempts < maxFailoverAttempts - 1) {
                    switchApiKey();
                    attempts++;
                    continue; 
                } else {
                    return { success: false, result: error.response?.data, message: "Semua API Key gagal otorisasi/saldo habis." };
                }
            }
            
            return { success: false, result: error.response?.data, message: errorMsg };
        }
    }
    return { success: false, message: "Semua upaya failover API Key gagal." };
}


// --- Fungsi untuk menghasilkan Inline Keyboard Aksi (tidak berubah) ---
function getOrderActionKeyboard(order_id, service_id_for_next_order) {
    return {
        inline_keyboard: [
            [
                { text: '❌ Cancel', callback_data: `cancel_${order_id}` },
                { text: '🔄 Get new code', callback_data: `check_${order_id}` },
                { text: '✅ Finish', callback_data: `finish_${order_id}` }
            ],
            [
                { text: '🛍 Beli Nomer Lagi', callback_data: `order_service_${service_id_for_next_order}` } 
            ]
        ]
    };
}

// =======================================================
// FUNGSI UTAMA EKSTRAKSI OTP 
// =======================================================
async function formatOtpMessage(order_id) {
    const url_details = `${ORDER_DETAILS_BASE_URL}/${order_id}`;
    const headers = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" }; 
    
    let response;
    try {
        response = await axios.get(url_details, { headers });
    } catch (error) {
        throw error;
    }

    const order_data = response.data.data;

    if (!order_data || !order_data.number) { 
        throw new Error("Data detail order tidak lengkap atau hilang dari API.");
    }
    
    let otp_code = "Menunggu OTP...";
    let raw_number = order_data.number || order_data.formatted_number;
    
    // Logika penentuan isKenangan sekarang cek semua ID di array prioritas
    const kenanganIds = KENANGAN_SERVICE_PRIORITY.map(c => c.service_id);
    const isKenangan = kenanganIds.includes(order_data.service.id);
    
    if (isKenangan) {
        raw_number = raw_number.replace(/^\+?62/, '');
        if (!raw_number.startsWith('8')) {
            raw_number = '8' + raw_number; 
        }
    } else {
        raw_number = raw_number.replace(/^\+/, '');
    }
    
    const clean_number = raw_number; 

    let sms_source = order_data.sms;
    let final_sms_array = [];

    if (sms_source && typeof sms_source === 'object' && !Array.isArray(sms_source)) {
        final_sms_array = Object.values(sms_source);
    } else if (Array.isArray(sms_source)) {
        final_sms_array = sms_source;
    }

    let extracted_otp_list = final_sms_array
                             .map(sms => sms.code || sms.otp_code || sms.text)
                             .filter(code => code && code.length >= 4); 
    
    const service_name = isKenangan ? "KOPI KENANGAN" : "FORE COFFEE";
    const action_keyboard = getOrderActionKeyboard(order_id, order_data.service.id).inline_keyboard;


    if (extracted_otp_list.length > 0) {
        // --- PERBAIKAN LOGIKA: MEMASTIKAN KODE TERBARU DIAMBIL DARI AKHIR ARRAY ---
        
        // 1. Buat salinan array dan balikkan untuk mendapatkan yang terbaru di indeks 0
        const reversed_otp_list = [...extracted_otp_list].reverse(); 
        
        const latest_code = reversed_otp_list[0];
        // Sisa array adalah riwayat
        const history_codes = reversed_otp_list.slice(1);
        
        // Gabungkan semua kode untuk log
        otp_code = reversed_otp_list.join(', '); 
        
        let message_parts = [];
        message_parts.push(`${service_name}: \`${clean_number}\``);
        message_parts.push(`Kode Terbaru: \`${latest_code}\``);
        
        if (history_codes.length > 0) {
            // Balik riwayat untuk ditampilkan dari terlama ke terbaru
            message_parts.push(`Riwayat OTP: \`${history_codes.reverse().join(', ')}\``); 
        }
        
        const finalMessage = message_parts.join('\n');

        return {
            text: finalMessage,
            options: { 
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [ ...action_keyboard ]
                }
            },
            logData: { clean_number, otp_code: latest_code, service: service_name }
        };

    } else if (order_data.sms_code && order_data.sms_code.length >= 4) {
             // KODE DITERIMA (Fallback)
             otp_code = order_data.sms_code;
             
             let message_parts = [];
             message_parts.push(`${service_name}: \`${clean_number}\``);
             message_parts.push(`Kode Terbaru: \`${otp_code}\``);
             
             const finalMessage = message_parts.join('\n');
    
             return {
                 text: finalMessage,
                 options: { 
                     parse_mode: 'Markdown',
                     reply_markup: {
                         inline_keyboard: [ ...action_keyboard ]
                     }
                 },
                 logData: { clean_number, otp_code: otp_code, service: service_name }
             };
    }
    
    // KODE BELUM DITERIMA (Menunggu OTP...)
    const finalMessageMenunggu = `${service_name}: \`${clean_number}\`\nOTP Status: \`Menunggu OTP...\``;

    return {
        text: finalMessageMenunggu,
        options: { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [ ...action_keyboard ]
            }
        },
        logData: { clean_number, otp_code: "Menunggu OTP...", service: service_name }
    };
}


// =======================================================
// 1. HANDLER PERINTAH /start (tidak berubah)
// =======================================================
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    writeLog(`User ${chatId} memulai chat.`);
    
    const options = {
        reply_markup: {
            keyboard: [
                [{ text: '☕ Beli Kode OTP' }], 
                [{ text: '📜 Riwayat Order' }, { text: '🗑️ Hapus Riwayat' }] 
            ],
            resize_keyboard: true
        }
    };
    
    const welcomeMessage = "Selamat datang di Bot MiweDigital! Silakan pilih opsi di bawah ini.";
    logAndSend(chatId, welcomeMessage, options);
});


// =======================================================
// 3. HANDLER RIWAYAT ORDER (tidak berubah)
// =======================================================
bot.onText(/(\/riwayat|\s*📜\s*Riwayat Order)/i, async (msg) => {
    const chatId = msg.chat.id;
    writeLog(`User ${chatId} meminta riwayat order.`);
    
    const history = readHistory();
    const userHistory = history[chatId] || [];

    if (userHistory.length === 0) {
        return logAndSend(chatId, "Riwayat order Anda masih kosong.");
    }

    const allHistory = userHistory.reverse(); 

    const finalHistory = allHistory.filter(item => item.status === 'FINISHED' || item.status === 'CANCELED');
    let foundAnyFinished = false;

    if (finalHistory.length === 0) {
        return logAndSend(chatId, "Riwayat order yang sudah selesai/dibatalkan tidak ditemukan.");
    }

    const groupedHistory = finalHistory.reduce((acc, item) => {
        if (!acc[item.service]) {
            acc[item.service] = [];
        }
        if (item.status === 'FINISHED') {
            acc[item.service].push(item.number);
        }
        
        return acc;
    }, {});

    let message = "*📜 Riwayat Order yang Selesai (OTP Masuk):*\n\n";

    for (const service in groupedHistory) {
        message += `*${service}:*\n`;
        const uniqueNumbers = [...new Set(groupedHistory[service])]; 
        if (uniqueNumbers.length > 0) {
            uniqueNumbers.forEach(number => {
                message += `\`${number}\`\n`;
            });
            message += "\n";
            foundAnyFinished = true;
        }
    }
    
    if (!foundAnyFinished) {
        message = "Riwayat order yang sudah selesai (OTP masuk) tidak ditemukan.";
    }

    logAndSend(chatId, message, { parse_mode: 'Markdown' });
});

// =======================================================
// 4. HANDLER HAPUS RIWAYAT (Konfirmasi Inline) (tidak berubah)
// =======================================================
bot.onText(/(\/hapusriwayat|\s*🗑️\s*Hapus Riwayat)/i, async (msg) => {
    const chatId = msg.chat.id;
    writeLog(`User ${chatId} meminta penghapusan riwayat (Konfirmasi).`);
    
    const history = readHistory();

    if (!history[chatId] || history[chatId].length === 0) {
        return logAndSend(chatId, "Riwayat Anda sudah kosong, tidak ada yang perlu dihapus.");
    }
    
    // Kirim pesan konfirmasi dengan Inline Keyboard
    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ YA, Hapus', callback_data: 'confirm_delete_history' },
                    { text: '❌ TIDAK, Batal', callback_data: 'cancel_delete_history' }
                ]
            ]
        }
    };

    logAndSend(chatId, "⚠️ *Apakah Anda yakin ingin menghapus semua riwayat order Anda?* Tindakan ini tidak dapat dibatalkan.", { parse_mode: 'Markdown', ...options });
});


// =======================================================
// 5. HANDLER /beli_kode_otp (Menggunakan ID Layanan Utama)
// =======================================================
bot.onText(/\s*beli\s*kode\s*OTP\s*/i, (msg) => { 
    const chatId = msg.chat.id;
    writeLog(`User ${chatId} mengklik Beli Kode OTP.`);
    
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'FORE COFFEE', callback_data: `order_service_${TARGET_SERVICE_FORE}` }],
                [{ text: 'KOPI KENANGAN', callback_data: `order_service_${TARGET_SERVICE_KENANGAN}` }] 
            ]
        }
    };
    
    logAndSend(chatId, "Pilih Layanan:", options);
});

// =======================================================
// 6. HANDLER Callback Query (LOGIKA FAILOVER SERVICE ID TERBARU)
// =======================================================
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

    try {
        bot.answerCallbackQuery(callbackQuery.id);
    } catch (e) {
        console.error(`[WARN] Gagal menjawab callback query lama: ${e.message}`);
    }

    // --- ALUR ORDER BARU (menggunakan Full Failover) ---
    if (data.startsWith('order_service_')) {
        
        const targetServiceId = parseInt(data.split('_')[2]); // ID Layanan Utama (1368/1371)
        
        if (message.text.includes("Pilih Layanan")) {
            bot.deleteMessage(chatId, message.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan lama: ${err.message}`));
        }
        
        // Inisialisasi daftar prioritas di sini
        const priorityList = (targetServiceId === TARGET_SERVICE_KENANGAN) 
            ? KENANGAN_SERVICE_PRIORITY 
            : FORE_SERVICE_PRIORITY;

        let order_id = null; 
        let isOrderSuccess = false;
        
        let waitMessage = await logAndSend(chatId, `⏳ Pesanan dibuat. Mencoba ${priorityList.length} Service ID dan semua API Key...`);

        // --- LOOP BARU UNTUK MENGULANG SELURUH PROSES BERDASARKAN PRIORITAS SERVICE ID ---
        for (let i = 0; i < priorityList.length; i++) {
            const serviceConfig = priorityList[i];
            const url_generate = 
                `${GENERATE_ORDER_URL}?otp_service_id=${serviceConfig.otp_id}&application_id=${serviceConfig.service_id}&quantity=1`;

            writeLog(`[FULL FAILOVER] Mencoba Service: ${serviceConfig.name} (Service ID: ${serviceConfig.service_id})`);
            await logAndEdit(chatId, waitMessage.message_id, `⏳ Mencoba Service ID **${serviceConfig.service_id}** (${serviceConfig.name})...`, { parse_mode: 'Markdown' });

            try {
                // Langkah 1: Mencoba membuat Order ID (dengan API Key Failover)
                const apiFailoverResult = await tryGenerateOrderWithFailover(url_generate);

                if (!apiFailoverResult.success) {
                    // Jika API Key failover gagal, log dan lanjut ke Service ID berikutnya
                    writeLog(`[FAILOVER INFO] Gagal membuat order dengan Service ID ${serviceConfig.service_id}: ${apiFailoverResult.message}. Lanjut ke berikutnya.`);
                    continue; 
                }

                order_id = apiFailoverResult.result.data.order_ids[0];
                if (!order_id) throw new Error("UUID pesanan tidak ditemukan di respons Generate Order.");

                writeLog(`[INFO] Order ID ${order_id} berhasil dibuat dengan Key ${apiFailoverResult.apiKey.substring(0, 5)}.... menggunakan Service ID ${serviceConfig.service_id}.`);

                // Langkah 2: RETRY LOOP UNTUK MENDAPATKAN NOMOR VIRTUAL
                let formatted = null;
                let success = false;
                
                await logAndEdit(chatId, waitMessage.message_id, `⏳ Order berhasil dibuat. Mencari nomor virtual... (ID: \`${order_id}\`)`, { parse_mode: 'Markdown' });

                for (let j = 0; j < MAX_RETRIES + 2; j++) { 
                    try {
                        formatted = await formatOtpMessage(order_id);
                        if (formatted.logData.clean_number) {
                            success = true; 
                            break; 
                        }
                    } catch (e) {
                        // Jika ada error API (misal 404/400) saat cek detail order, ini order bermasalah
                        if (e.message.includes("404") || e.message.includes("400") || e.message.includes("Order not found")) {
                            throw new Error(`Gagal mendapatkan nomor virtual: Order ID ${order_id} bermasalah di API.`); 
                        }
                    }
                    if (j < MAX_RETRIES + 1) {
                        await delay(RETRY_DELAY); 
                    }
                }

                if (!success) {
                    // Ini adalah error yang Anda temukan di log (Gagal mendapatkan nomor virtual)
                    throw new Error("Gagal mendapatkan nomor virtual setelah semua percobaan polling.");
                }
                
                isOrderSuccess = true;
                
                // --- LANJUTKAN KE ALUR POLLING OTP STANDAR ---
                let pollingMessageBase = `*Nomor berhasil didapat:* \`${formatted.logData.clean_number}\`.\nBot akan *cek OTP otomatis* selama **${TOTAL_POLLING_TIME} detik** (${MAX_OTP_CHECKS}x check @ ${OTP_CHECK_DELAY / 1000}s).`;
                await logAndEdit(chatId, waitMessage.message_id, `${pollingMessageBase}\n*Status:* Menunggu OTP... (*Polling 0/${MAX_OTP_CHECKS}*)`, { parse_mode: 'Markdown' });

                let finalFormatted = null;

                for (let k = 0; k < MAX_OTP_CHECKS; k++) { 
                    finalFormatted = await formatOtpMessage(order_id);
                    
                    if (finalFormatted.logData.otp_code !== "Menunggu OTP...") {
                        logAndEdit(chatId, waitMessage.message_id, finalFormatted.text, finalFormatted.options);
                        writeLog(`[INFO] OTP masuk cepat. Order ID: ${order_id}`);
                        break;
                    }

                    await logAndEdit(chatId, waitMessage.message_id, 
                        `${pollingMessageBase}\n*Status:* Menunggu OTP... (*Polling ${k+1}/${MAX_OTP_CHECKS}*)`, 
                        { parse_mode: 'Markdown' });
                    
                    if (k < MAX_OTP_CHECKS - 1) {
                        await delay(OTP_CHECK_DELAY); // TUNGGU 10 DETIK
                    }
                }
                
                finalFormatted = await formatOtpMessage(order_id);

                if (finalFormatted.logData.otp_code === "Menunggu OTP...") {
                    bot.deleteMessage(chatId, waitMessage.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan tunggu: ${err.message}`));
                    logAndSend(chatId, finalFormatted.text, finalFormatted.options);
                } else {
                    logAndEdit(chatId, waitMessage.message_id, finalFormatted.text, finalFormatted.options);
                }
                
                updateHistory(chatId, order_id, finalFormatted.logData.clean_number, finalFormatted.logData.service, 'ACTIVE'); 
                writeLog(`[ACTIVE] Nomor virtual ${finalFormatted.logData.clean_number} untuk ${order_id} ditampilkan ke ${chatId}. Status OTP: ${finalFormatted.logData.otp_code}`);

                break; // KELUAR DARI LOOP SERVICE ID KARENA SUKSES

            } catch (error) {
                // TANGANI ERROR DALAM SATU SERVICE ID TRY/CATCH
                let errorMessage = error.message;

                // Coba batalkan order yang bermasalah sebelum lanjut ke Service ID berikutnya
                if (order_id) {
                    try {
                        const CANCEL_URL = `${ORDER_BASE_URL}/${order_id}/cancel`;
                        // Gunakan API Key saat ini untuk membatalkan
                        const cancelHeaders = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
                        await axios.get(CANCEL_URL, { headers: cancelHeaders });
                        updateHistory(chatId, order_id, null, null, 'CANCELED');
                        writeLog(`[ACTION] Order ID ${order_id} dibatalkan otomatis setelah gagal mendapatkan nomor/OTP.`);
                    } catch (cancelError) {
                        writeLog(`[WARN] Gagal membatalkan Order ID ${order_id} setelah kegagalan: ${cancelError.message}`);
                    }
                    order_id = null; // Reset order_id agar tidak dibatalkan lagi
                }
                
                // Jika masih ada service ID lain di daftar, Lanjut ke Service ID berikutnya
                if (i < priorityList.length - 1) {
                    await logAndEdit(chatId, waitMessage.message_id, `❌ Gagal dengan Service ID **${serviceConfig.service_id}**. Mencoba Service ID berikutnya...`, { parse_mode: 'Markdown' });
                    continue; // Lanjut ke iterasi loop Service ID berikutnya
                } else {
                    // Semua Service ID telah dicoba dan gagal
                    isOrderSuccess = false;
                    break; 
                }
            }
        } // --- AKHIR LOOP SERVICE ID ---

        // Pesan GAGAL TOTAL
        if (!isOrderSuccess) {
            bot.deleteMessage(chatId, waitMessage.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan tunggu: ${err.message}`));
            logAndSend(chatId, "❌ *Semua upaya pembelian gagal total.* Semua Service ID dan API Key yang tersedia telah dicoba. Silakan coba lagi nanti.", { parse_mode: 'Markdown' });
            writeLog(`[FATAL ERROR] Semua upaya FULL FAILOVER gagal total untuk ${chatId}.`);
        }
    } 
    
    // --- ALUR KONFIRMASI HAPUS RIWAYAT: YA (tidak berubah) ---
    else if (data === 'confirm_delete_history') {
        const history = readHistory();

        if (history[chatId]) {
            delete history[chatId];
            writeHistory(history);

            logAndEdit(chatId, message.message_id, 
                "✅ Riwayat order Anda *telah* dihapus.", 
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
            );
            writeLog(`[ACTION] Riwayat ${chatId} berhasil dihapus.`);
        } else {
            logAndEdit(chatId, message.message_id, 
                "⚠️ Riwayat Anda sudah kosong.", 
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
            );
        }
    }
    
    // --- ALUR KONFIRMASI HAPUS RIWAYAT: TIDAK (tidak berubah) ---
    else if (data === 'cancel_delete_history') {
        logAndEdit(chatId, message.message_id, 
            "❌ Penghapusan riwayat *dibatalkan*.", 
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
        );
        writeLog(`[ACTION] Penghapusan riwayat ${chatId} dibatalkan.`);
    }

    // --- ALUR CHECK OTP (telah diperbaiki agar aman) ---
    else if (data.startsWith('check_')) {
        const order_id = data.split('_')[1];
        writeLog(`User ${chatId} mengecek OTP untuk Order ID: ${order_id}.`);
        
        let checkMessageText = `⏳ Memeriksa SMS terbaru...`;
        
        try {
            // Edit pesan yang diklik menjadi pesan tunggu/periksa
            await logAndEdit(chatId, message.message_id, checkMessageText, {
                parse_mode: 'Markdown',
                reply_markup: message.reply_markup 
            });
            
            const formatted = await formatOtpMessage(order_id);
            
            // Edit pesan tunggu menjadi pesan hasil (aman karena pakai logAndEdit)
            await logAndEdit(chatId, message.message_id, formatted.text, formatted.options);
            
            writeLog(`[INFO] Check OTP sukses untuk Order ID ${order_id}. Nomor: ${formatted.logData.clean_number} | OTP Status: ${formatted.logData.otp_code}`);

        } catch (error) {
             let errorMessage = "❌ Gagal mendapatkan detail order atau terjadi error API.";
             if (error.response?.data?.message) {
                 errorMessage = `❌ Error API: ${error.response.data.message}`;
             }
             writeLog(`[ERROR] Gagal Check OTP Order ID ${order_id}: ${errorMessage}`);
             logAndSend(chatId, errorMessage);
        }
    }
    
    // --- ALUR CANCEL (tidak berubah) ---
    else if (data.startsWith('cancel_')) {
        const order_id = data.split('_')[1];
        try {
            const headers = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
            const CANCEL_URL = `${ORDER_BASE_URL}/${order_id}/cancel`;
            const response = await axios.get(CANCEL_URL, { headers });
            const result = response.data;
            
            let isSuccess = (response.status === 200 && result.status === 'success');
            let isAlreadyCanceled = result.message?.toLowerCase().includes('order cancelled successfully') || result.message?.toLowerCase().includes('order already canceled');
            
            if (isSuccess || isAlreadyCanceled) {
                logAndEdit(chatId, message.message_id, `✅ *Pesanan DIBATALKAN!* Order ID: \`${order_id}\``, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } 
                });
                writeLog(`[ACTION] Pesanan ID ${order_id} dibatalkan oleh ${chatId}.`);
                updateHistory(chatId, order_id, null, null, 'CANCELED');
            } else {
                logAndSend(chatId, `⚠️ Gagal membatalkan pesanan (ID: \`${order_id}\`). Pesan: ${result.message || 'Coba lagi setelah 1 menit.'}`);
                writeLog(`[ERROR] Gagal Cancel ID ${order_id}: ${result.message || 'Unknown Error'}`);
            }
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            
            if (errorMsg.toLowerCase().includes('order cancelled successfully') || errorMsg.toLowerCase().includes('order already canceled')) {
                logAndEdit(chatId, message.message_id, `✅ *Pesanan DIBATALKAN!* Order ID: \`${order_id}\``, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } 
                });
                writeLog(`[ACTION] Pesanan ID ${order_id} dibatalkan oleh ${chatId}. (Catch Block Success)`);
                updateHistory(chatId, order_id, null, null, 'CANCELED');
            } else {
                logAndSend(chatId, `❌ Gagal Cancel Order. Pesan: ${errorMsg}`);
            }
        }
    }

    // --- ALUR FINISH (memanggil updateHistory yang sudah diperbaiki) ---
    else if (data.startsWith('finish_')) {
        const order_id = data.split('_')[1];
        try {
            const headers = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
            const FINISH_URL = `${ORDER_BASE_URL}/${order_id}/finish`;
            const response = await axios.get(FINISH_URL, { headers });
            const result = response.data;
            
            const errorMsg = result.message?.toLowerCase() || '';
            const isAlreadyCompleted = errorMsg.includes('order already completed') || errorMsg.includes('order cannot be finished');

            let isSuccess = (response.status === 200 && result.status === 'success');
            let isAlreadyFinished = isAlreadyCompleted || result.message?.toLowerCase().includes('order finished successfully');


            if (isSuccess || isAlreadyFinished) {
                logAndEdit(chatId, message.message_id, `✅ *Pesanan SELESAI!* Order ID: \`${order_id}\``, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } 
                });
                writeLog(`[ACTION] Pesanan ID ${order_id} diselesaikan oleh ${chatId}.`);
                // Memanggil updateHistory dengan null, namun fungsi tersebut akan mengambil data lama
                updateHistory(chatId, order_id, null, null, 'FINISHED'); 
            } else {
                logAndSend(chatId, `⚠️ Gagal menyelesaikan pesanan (ID: \`${order_id}\`). Pesan: ${result.message || 'Status order tidak valid.'}`);
                writeLog(`[ERROR] Gagal Finish ID ${order_id}: ${result.message || 'Unknown Error'}`);
            }
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            const isAlreadyCompleted = errorMsg.toLowerCase().includes('order already completed') || errorMsg.toLowerCase().includes('order cannot be finished');

            
            if (isAlreadyCompleted || errorMsg.toLowerCase().includes('order finished successfully')) {
                 logAndEdit(chatId, message.message_id, `✅ *Pesanan SELESAI!* Order ID: \`${order_id}\``, { 
                     parse_mode: 'Markdown',
                     reply_markup: { inline_keyboard: [] } 
                 });
                 writeLog(`[ACTION] Pesanan ID ${order_id} diselesaikan oleh ${chatId}. (Catch Block Success)`);
                 // Memanggil updateHistory dengan null, namun fungsi tersebut akan mengambil data lama
                 updateHistory(chatId, order_id, null, null, 'FINISHED');
            } else {
                logAndSend(chatId, `❌ Terjadi kesalahan saat Finish Order. Coba lagi.`);
            }
        }
    }
});
