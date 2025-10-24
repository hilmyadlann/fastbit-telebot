const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs'); 

// --- Variabel Konfigurasi Dasar ---
// GANTI TOKEN INI DENGAN TOKEN BARU DARI BOTFATHER!
const TELEGRAM_BOT_TOKEN = "7348650612:AAGxw63Hs1bzLBr994f07dkMeRNwI_-_f9w"; 

// --- KONFIGURASI API KEY (Daftar API Key untuk Failover) ---
const API_KEY_LIST = [
    { key: "jk6ZM8itAeRfRP4asjDA8XKkGmXBnnAo", limit_reached_at: null, index: 0 },
    { key: "LAF19i8MvV1n8P5wdDmEmwIRBIby4zGT", limit_reached_at: null, index: 1 },
    { key: "y5OmMGlJY9SCRuLo99WzHSZGtNMvPHwd", limit_reached_at: null, index: 2 }
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

// --- KONSTANTA POLLING OTP (5 Detik per check, TOTAL 60 DETIK) ---
const MAX_OTP_CHECKS = 12; // 12 kali coba ulang (60 / 5)
const OTP_CHECK_DELAY = 5000; // 5000 ms = 5 detik delay per coba ulang
const TOTAL_POLLING_TIME = (MAX_OTP_CHECKS * OTP_CHECK_DELAY) / 1000; // 60 detik
// -------------------------------------------------------------------

// ID Layanan dan Provider yang terfokus
const TARGET_SERVICE_FORE = 1368;        
const TARGET_SERVICE_KENANGAN = 1371; 

// --- KONFIGURASI FAILOVER SERVICE ID ---
// DAFTAR PRIORITAS UNTUK FORE COFFEE
const FORE_SERVICE_PRIORITY = [
    { service_id: 1368, otp_id: 145985, name: "FORE COFFEE (P1)" },
    { service_id: 1368, otp_id: 145977, name: "FORE COFFEE (P2)" },
    { service_id: 1368, otp_id: 145984, name: "FORE COFFEE (P3)" },
    { service_id: 1368, otp_id: 145976, name: "FORE COFFEE (P4)" },
    { service_id: 1368, otp_id: 145986, name: "FORE COFFEE (P5)" },
    { service_id: 1368, otp_id: 145978, name: "FORE COFFEE (P6)" },
    { service_id: 1368, otp_id: 145988, name: "FORE COFFEE (P7)" },
    { service_id: 1368, otp_id: 145980, name: "FORE COFFEE (P8)" },
    { service_id: 1368, otp_id: 145981, name: "FORE COFFEE (P9)" },
    { service_id: 1368, otp_id: 145989, name: "FORE COFFEE (P10)" },
    { service_id: 1368, otp_id: 145979, name: "FORE COFFEE (P11)" },
    { service_id: 1368, otp_id: 145987, name: "FORE COFFEE (P11)" },
    { service_id: 1368, otp_id: 145982, name: "FORE COFFEE (P12)" },
    { service_id: 1368, otp_id: 145990, name: "FORE COFFEE (P13) BACK UP" },
    { service_id: 1368, otp_id: 145982, name: "FORE COFFEE (P14) BACK UP" },

    // Tambahkan jika ada alternatif Fore
];

// DAFTAR PRIORITAS UNTUK KOPI KENANGAN (DIDEFINISIKAN & DI-MAINTENANCE)
const KENANGAN_SERVICE_PRIORITY = [
    { service_id: 1371, otp_id: 144477, name: "KOPI KENANGAN (P1)" }, // ID Lama/Utama
    { service_id: 1371, otp_id: 145992, name: "KOPI KENANGAN (P2)" }, // ID Baru/Alternatif
    // Tambahkan service ID baru di sini jika ada lagi
];
const IS_KENANGAN_MAINTENANCE = true; // Set ke TRUE untuk mengaktifkan mode maintenance

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
    console.error(`[TELEGRAM POLLING ERROR] ETELEGRAM: ${err.message || 'UNKNOWN'}`);
    writeLog(`[TELEGRAM POLLING ERROR] ${err.message || 'UNKNOWN'}`);
});
// ----------------------------

console.log("Bot Telegram MIWE-BOT sedang berjalan...");
writeLog("Bot dimulai dan siap melayani."); 


// =======================================================
// FUNGSI WRAPPER LOG PESAN CHAT (DIPERKUAT DENGAN ERROR HANDLER MARKDOWN)
// =======================================================
async function logAndSend(chatId, text, options) {
    writeLog(`[CHAT OUT] To ${chatId}: ${text.substring(0, 50)}...`);
    
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (error) {
        // Cek jika error adalah "Bad Request: can't parse entities" (400 Bad Request)
        const errorMsg = error.response?.body?.description || error.message;
        if (error.code === 'ETELEGRAM' && errorMsg.includes('can\'t parse entities')) {
            writeLog(`[WARN] Markdown Error pada pesan keluar. Mencoba kirim ulang tanpa Parse Mode.`);
            const fallbackOptions = { ...options };
            delete fallbackOptions.parse_mode;
            // Kirim ulang tanpa Markdown
            return await bot.sendMessage(chatId, text, fallbackOptions);
        }
        // Lemparkan error lainnya
        throw error;
    }
}

// FUNGSI MODIFIKASI UNTUK MENANGANI ERROR "MESSAGE NOT MODIFIED" (DIPERKUAT)
async function logAndEdit(chatId, messageId, text, options) {
    writeLog(`[CHAT EDIT] Msg ID ${messageId} to ${chatId}: ${text.substring(0, 50)}...`);
    try {
        return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch (error) {
        const errorMsg = error.response?.body?.description || error.message;
        
        // 1. Abaikan error "message is not modified"
        if (error.code === 'ETELEGRAM' && errorMsg.includes('message is not modified')) {
            writeLog(`[WARN] Edit diabaikan: Konten tidak berubah. Msg ID: ${messageId}`);
            return; 
        }
        
        // 2. Tangani error "can't parse entities" (Markdown Error)
        if (error.code === 'ETELEGRAM' && errorMsg.includes('can\'t parse entities')) {
            writeLog(`[WARN] Markdown Error pada edit pesan. Mencoba edit ulang tanpa Parse Mode.`);
            const fallbackOptions = { ...options };
            delete fallbackOptions.parse_mode;
            // Coba edit ulang tanpa Markdown
            return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...fallbackOptions });
        }
        
        // Lemparkan error lainnya
        throw error;
    }
}
// =======================================================


// =======================================================
// FUNGSI API KEY FAILOVER (dengan logging error detail) (tidak berubah)
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


// --- Fungsi untuk menghasilkan Inline Keyboard Aksi ---
// Callback Beli Nomer Lagi langsung menunjuk ke startorder_[service_id]_[priorityIndex]
function getOrderActionKeyboard(order_id, service_id_for_next_order, priorityIndex) {
    const repeatOrderCallback = `startorder_${service_id_for_next_order}_${priorityIndex}`;
    
    return {
        inline_keyboard: [
            [
                { text: '❌ Cancel', callback_data: `cancel_${order_id}` },
                { text: '🔄 Get new code', callback_data: `check_${order_id}` },
                { text: '✅ Finish', callback_data: `finish_${order_id}` }
            ],
            [
                { text: '🛍 Beli Nomer Lagi', callback_data: repeatOrderCallback } 
            ]
        ]
    };
}

// =======================================================
// FUNGSI UTAMA EKSTRAKSI OTP 
// =======================================================
// Menerima priorityIndex untuk ditampilkan di pesan output
async function formatOtpMessage(order_id, priorityIndex) {
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
    // Panggil getOrderActionKeyboard dengan priorityIndex
    const action_keyboard = getOrderActionKeyboard(order_id, order_data.service.id, priorityIndex).inline_keyboard;
    
    // Tambahkan info server ke pesan
    const serverInfo = `(Server ${priorityIndex + 1})`;


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
        message_parts.push(`*${service_name} ${serverInfo}*: \`${clean_number}\``);
        message_parts.push(`*Kode Terbaru:* \`${latest_code}\``);
        
        if (history_codes.length > 0) {
            // Balik riwayat untuk ditampilkan dari terlama ke terbaru
            message_parts.push(`*Riwayat OTP:* \`${history_codes.reverse().join(', ')}\``); 
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
             message_parts.push(`*${service_name} ${serverInfo}*: \`${clean_number}\``);
             message_parts.push(`*Kode Terbaru:* \`${otp_code}\``);
             
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
    const finalMessageMenunggu = `*${service_name} ${serverInfo}*: \`${clean_number}\`\n*OTP Status:* \`Menunggu OTP...\``;

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
// 5. HANDLER /beli_kode_otp (Menampilkan Pilihan Layanan) 
//    DIPERBARUI: KOPI KENANGAN SELALU DI-MAINTENANCE (CALLBACK 'noop')
// =======================================================
bot.onText(/\s*beli\s*kode\s*OTP\s*/i, (msg) => { 
    const chatId = msg.chat.id;
    writeLog(`User ${chatId} mengklik Beli Kode OTP.`);
    
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'FORE COFFEE ☕', callback_data: `select_server_${TARGET_SERVICE_FORE}` }],
                // KOPI KENANGAN di-Maintenance: Callback data 'noop' akan diabaikan oleh bot.
                [{ text: 'KOPI KENANGAN ☕ (MAINTENANCE)', callback_data: 'noop' }] 
            ]
        }
    };
    
    logAndSend(chatId, "Pilih Layanan:", options);
});


// =======================================================
// FUNGSI UTILITY BARU UNTUK MEMBUAT KEYBOARD SERVER
// DIPERBARUI: Menangani Kasus Maintenance dengan pesan peringatan.
// =======================================================
function getServerSelectionKeyboard(targetServiceId) {
    const isKenangan = targetServiceId === TARGET_SERVICE_KENANGAN;
    
    const list = isKenangan ? KENANGAN_SERVICE_PRIORITY : FORE_SERVICE_PRIORITY;
    
    // Cek Maintenance
    if (isKenangan && IS_KENANGAN_MAINTENANCE) {
        return { 
            inline_keyboard: [
                [{ text: '⚠️ KOPI KENANGAN sedang Maintenance ⚠️', callback_data: 'noop' }],
                [{ text: 'Pilih Layanan Lain', callback_data: 'show_services' }] 
            ] 
        };
    }

    // Buat keyboard 2 kolom
    const keyboard = [];
    let row = [];
    
    list.forEach((item, index) => {
        // Teks tombol menjadi SERVER [Index + 1]
        const text = `SERVER ${index + 1}`; 
        
        // Data callback: startorder_[Service ID Utama]_[Index Prioritas]
        const callbackData = `startorder_${targetServiceId}_${index}`;
        
        row.push({ text: text, callback_data: callbackData });
        
        if (row.length === 2 || index === list.length - 1) {
            keyboard.push(row);
            row = [];
        }
    });
    
    return {
        inline_keyboard: keyboard
    };
}


// =======================================================
// 6. HANDLER Callback Query 
// DIPERBARUI: Penanganan Error 'query is too old' yang lebih baik.
// =======================================================
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

    // --- PERBAIKAN PENTING DI SINI: COBA JAWAB QUERY SEGERA ---
    try {
        // MENJAWAB CALLBACK QUERY UNTUK MENGHILANGKAN STATUS 'LOADING' PADA TOMBOL
        // Ini harus dilakukan secepat mungkin (dalam 60 detik)
        await bot.answerCallbackQuery(callbackQuery.id); 
    } catch (e) {
        const errorMsg = e.response?.body?.description || e.message;
        // Tangani error ETELEGRAM: 400 Bad Request: query is too old
        if (errorMsg.includes('query is too old') || errorMsg.includes('query ID is invalid')) {
             console.error(`[WARN] Gagal menjawab callback query (sudah kedaluwarsa/invalid). Melanjutkan proses. ID: ${callbackQuery.id}`);
             // Lanjutkan ke logika utama, bot akan mengabaikan error ini
        } else {
             console.error(`[FATAL ERROR] Gagal menjawab callback query tak terduga: ${e.message}`);
             // Jika error lain, tetap lanjutkan, tetapi log errornya.
        }
    }
    // -------------------------------------------------------------
    
    // Pengecekan khusus untuk callback 'noop' (Maintenance)
    if (data === 'noop') {
        return; 
    }
    
    // Pengecekan khusus untuk kembali ke daftar layanan
    if (data === 'show_services') {
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'FORE COFFEE ☕', callback_data: `select_server_${TARGET_SERVICE_FORE}` }],
                    [{ text: 'KOPI KENANGAN ☕ (MAINTENANCE)', callback_data: 'noop' }] 
                ]
            }
        };
        logAndEdit(chatId, message.message_id, "*Pilih Layanan:*", { parse_mode: 'Markdown', ...options });
        return;
    }


    // --- ALUR 1: PILIH SERVER ---
    else if (data.startsWith('select_server_')) {
        const targetServiceId = parseInt(data.split('_')[2]);
        
        // Tambahkan pengecekan maintenance di sini
        if (targetServiceId === TARGET_SERVICE_KENANGAN && IS_KENANGAN_MAINTENANCE) {
            const keyboard = getServerSelectionKeyboard(TARGET_SERVICE_KENANGAN);
            logAndEdit(chatId, message.message_id, `*KOPI KENANGAN sedang Maintenance.*`, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            writeLog(`[ACTION] User ${chatId} mencoba KOPI KENANGAN yang maintenance.`);
            return;
        }

        const serviceName = targetServiceId === TARGET_SERVICE_KENANGAN ? 'KOPI KENANGAN' : 'FORE COFFEE';
        
        const keyboard = getServerSelectionKeyboard(targetServiceId);
        
        // Hapus pesan lama "Pilih Layanan" (Pesan pertama dari /beli_kode_otp)
        if (message.text.includes("Pilih Layanan")) {
            await bot.deleteMessage(chatId, message.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan: ${err.message}`));
            logAndSend(chatId, `*Pilih Server untuk ${serviceName}:*`, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
             // Edit pesan "Pilih Server" (Jika user klik tombol di pesan yang sama)
             logAndEdit(chatId, message.message_id, `*Pilih Server untuk ${serviceName}:*`, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }
        writeLog(`[ACTION] User ${chatId} memilih server untuk ${serviceName}.`);
    }

    // --- ALUR 2: START ORDER SETELAH PILIH SERVER (TERMASUK 'BELI NOMER LAGI') ---
    else if (data.startsWith('startorder_')) {
        
        const parts = data.split('_');
        const targetServiceId = parseInt(parts[1]); // ID Layanan Utama (1368/1371)
        const priorityIndex = parseInt(parts[2]);  // Index prioritas (0, 1, 2, ...)
        
        // Pengecekan Maintenance Ulang (Jika tombol 'Beli Nomer Lagi' di klik)
        if (targetServiceId === TARGET_SERVICE_KENANGAN && IS_KENANGAN_MAINTENANCE) {
             const keyboard = getServerSelectionKeyboard(TARGET_SERVICE_KENANGAN);
             await logAndSend(chatId, `❌ Gagal membuat pesanan. *KOPI KENANGAN sedang Maintenance.*`, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
             });
             return;
        }

        // Cek apakah pesan yang diklik adalah pesan pemilihan server.
        const isServerSelectionMessage = message.text.includes("Pilih Server untuk");

        // Jika ini adalah pesan pemilihan server, hapus agar chat lebih bersih.
        if (isServerSelectionMessage) {
            bot.deleteMessage(chatId, message.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan lama: ${err.message}`));
        }
        
        // Inisialisasi daftar prioritas
        const fullPriorityList = (targetServiceId === TARGET_SERVICE_KENANGAN) 
            ? KENANGAN_SERVICE_PRIORITY 
            : FORE_SERVICE_PRIORITY;
        
        // Ambil hanya server yang dipilih sebagai awal failover
        const priorityList = fullPriorityList.slice(priorityIndex); 
        
        const initialServiceName = fullPriorityList[priorityIndex].name;
        const initialServerNumber = priorityIndex + 1;

        let order_id = null; 
        let isOrderSuccess = false;
        
        // Kirim pesan tunggu BARU untuk order yang sedang diproses
        let waitMessage = await logAndSend(chatId, `⏳ Pesanan untuk Server **${initialServerNumber}** (${initialServiceName}) sedang dibuat. Mencoba ${priorityList.length} Server dan semua API Key...`, { parse_mode: 'Markdown' });

        // --- LOOP BARU UNTUK MENGULANG SELURUH PROSES BERDASARKAN PRIORITAS SERVICE ID ---
        for (let i = 0; i < priorityList.length; i++) {
            const serviceConfig = priorityList[i];
            const currentServerIndex = priorityIndex + i; // Index server yang sedang dicoba
            const url_generate = 
                `${GENERATE_ORDER_URL}?otp_service_id=${serviceConfig.otp_id}&application_id=${serviceConfig.service_id}&quantity=1`;

            writeLog(`[FULL FAILOVER] Mencoba Service: ${serviceConfig.name} (Server ${currentServerIndex + 1})`);
            
            // Update pesan tunggu
            await logAndEdit(chatId, waitMessage.message_id, `⏳ Mencoba Server **${currentServerIndex + 1}** (${serviceConfig.name})...`, { parse_mode: 'Markdown' });

            try {
                // Langkah 1: Mencoba membuat Order ID (dengan API Key Failover)
                const apiFailoverResult = await tryGenerateOrderWithFailover(url_generate);

                if (!apiFailoverResult.success) {
                    writeLog(`[FAILOVER INFO] Gagal membuat order dengan Server ${currentServerIndex + 1}: ${apiFailoverResult.message}. Lanjut ke berikutnya.`);
                    continue; 
                }

                order_id = apiFailoverResult.result.data.order_ids[0];
                if (!order_id) throw new Error("UUID pesanan tidak ditemukan di respons Generate Order.");

                writeLog(`[INFO] Order ID ${order_id} berhasil dibuat dengan Key ${apiFailoverResult.apiKey.substring(0, 5)}.... menggunakan Server ${currentServerIndex + 1}.`);

                // Langkah 2: RETRY LOOP UNTUK MENDAPATKAN NOMOR VIRTUAL
                let formatted = null;
                let success = false;
                
                await logAndEdit(chatId, waitMessage.message_id, `⏳ Order berhasil dibuat. Mencari nomor virtual... (ID: \`${order_id}\`)`, { parse_mode: 'Markdown' });

                for (let j = 0; j < MAX_RETRIES + 2; j++) { 
                    try {
                        // Kirim index server saat ini ke formatOtpMessage
                        formatted = await formatOtpMessage(order_id, currentServerIndex);
                        if (formatted.logData.clean_number) {
                            success = true; 
                            break; 
                        }
                    } catch (e) {
                        if (e.message.includes("404") || e.message.includes("400") || e.message.includes("Order not found")) {
                            throw new Error(`Gagal mendapatkan nomor virtual: Order ID ${order_id} bermasalah di API.`); 
                        }
                    }
                    if (j < MAX_RETRIES + 1) {
                        await delay(RETRY_DELAY); 
                    }
                }

                if (!success) {
                    throw new Error("Gagal mendapatkan nomor virtual setelah semua percobaan polling.");
                }
                
                isOrderSuccess = true;
                
                // --- LANJUTKAN KE ALUR POLLING OTP STANDAR (5 DETIK) ---
                let pollingMessageBase = `*Nomor berhasil didapat:* \`${formatted.logData.clean_number}\`.\nBot akan *cek OTP otomatis* selama **${TOTAL_POLLING_TIME} detik** (${MAX_OTP_CHECKS}x check @ ${OTP_CHECK_DELAY / 1000}s).`;
                await logAndEdit(chatId, waitMessage.message_id, `${pollingMessageBase}\n*Status:* Menunggu OTP... (*Polling 0/${MAX_OTP_CHECKS}*)`, { parse_mode: 'Markdown' });

                let finalFormatted = null;

                for (let k = 0; k < MAX_OTP_CHECKS; k++) { 
                    finalFormatted = await formatOtpMessage(order_id, currentServerIndex);
                    
                    if (finalFormatted.logData.otp_code !== "Menunggu OTP...") {
                        // OTP MASUK, EDIT PESAN TERAKHIR DAN KELUAR LOOP
                        logAndEdit(chatId, waitMessage.message_id, finalFormatted.text, finalFormatted.options);
                        writeLog(`[INFO] OTP masuk cepat. Order ID: ${order_id}`);
                        break;
                    }

                    await logAndEdit(chatId, waitMessage.message_id, 
                        `${pollingMessageBase}\n*Status:* Menunggu OTP... (*Polling ${k+1}/${MAX_OTP_CHECKS}*)`, 
                        { parse_mode: 'Markdown' });
                    
                    if (k < MAX_OTP_CHECKS - 1) {
                        await delay(OTP_CHECK_DELAY); // TUNGGU 5 DETIK
                    }
                }
                
                // Final check setelah polling selesai
                finalFormatted = await formatOtpMessage(order_id, currentServerIndex);

                // Pesan final (Nomor/OTP didapat atau masih menunggu) harus tetap di-edit ke pesan tunggu
                logAndEdit(chatId, waitMessage.message_id, finalFormatted.text, finalFormatted.options);
                
                updateHistory(chatId, order_id, finalFormatted.logData.clean_number, finalFormatted.logData.service, 'ACTIVE'); 
                writeLog(`[ACTIVE] Nomor virtual ${finalFormatted.logData.clean_number} untuk ${order_id} (Server ${currentServerIndex + 1}) ditampilkan ke ${chatId}. Status OTP: ${finalFormatted.logData.otp_code}`);

                break; // KELUAR DARI LOOP SERVICE ID KARENA SUKSES

            } catch (error) {
                let errorMessage = error.message;

                // Coba batalkan order yang bermasalah sebelum lanjut ke Service ID berikutnya
                if (order_id) {
                    try {
                        const CANCEL_URL = `${ORDER_BASE_URL}/${order_id}/cancel`;
                        const cancelHeaders = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
                        await axios.get(CANCEL_URL, { headers: cancelHeaders });
                        updateHistory(chatId, order_id, null, null, 'CANCELED');
                        writeLog(`[ACTION] Order ID ${order_id} dibatalkan otomatis setelah gagal mendapatkan nomor/OTP.`);
                    } catch (cancelError) {
                        writeLog(`[WARN] Gagal membatalkan Order ID ${order_id} setelah kegagalan: ${cancelError.message}`);
                    }
                    order_id = null;
                }
                
                // Jika masih ada server lain di daftar prioritas yang tersisa, Lanjut ke Server berikutnya
                if (i < priorityList.length - 1) {
                    await logAndEdit(chatId, waitMessage.message_id, `❌ Gagal dengan Server **${currentServerIndex + 1}**. Mencoba Server berikutnya...`, { parse_mode: 'Markdown' });
                    continue; 
                } else {
                    // Semua Server telah dicoba dan gagal
                    isOrderSuccess = false;
                    break; 
                }
            }
        } // --- AKHIR LOOP SERVICE ID ---

        // Pesan GAGAL TOTAL
        if (!isOrderSuccess) {
            // Edit pesan tunggu menjadi pesan gagal total
            logAndEdit(chatId, waitMessage.message_id, "❌ *Semua upaya pembelian gagal total.* Semua Server prioritas yang tersisa telah dicoba. Silakan coba lagi nanti.", { parse_mode: 'Markdown' });
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

    // --- ALUR CHECK OTP (tidak berubah) ---
    else if (data.startsWith('check_')) {
        const order_id = data.split('_')[1];
        writeLog(`User ${chatId} mengecek OTP untuk Order ID: ${order_id}.`);
        
        let checkMessageText = `⏳ Memeriksa SMS terbaru...`;
        
        try {
            // Coba ekstrak index server dari pesan yang diedit sebelumnya
            const match = message.text.match(/\(Server (\d+)\)/);
            const priorityIndex = match ? parseInt(match[1]) - 1 : 0; 

            // Edit pesan yang diklik menjadi pesan tunggu/periksa
            await logAndEdit(chatId, message.message_id, checkMessageText, {
                parse_mode: 'Markdown',
                reply_markup: message.reply_markup 
            });
            
            const formatted = await formatOtpMessage(order_id, priorityIndex);
            
            // Edit pesan tunggu menjadi pesan hasil (aman karena pakai logAndEdit)
            await logAndEdit(chatId, message.message_id, formatted.text, formatted.options);
            
            writeLog(`[INFO] Check OTP sukses untuk Order ID ${order_id}. Nomor: ${formatted.logData.clean_number} | OTP Status: ${formatted.logData.otp_code}`);

        } catch (error) {
             let errorMessage = "❌ Gagal mendapatkan detail order atau terjadi error API. (Server index hilang)";
             if (error.response?.data?.message) {
                 errorMessage = `❌ Error API: ${error.response.data.message}`;
             }
             writeLog(`[ERROR] Gagal Check OTP Order ID ${order_id}: ${errorMessage}`);
             logAndEdit(chatId, message.message_id, errorMessage, { parse_mode: 'Markdown', reply_markup: message.reply_markup });
        }
    }
    
    // --- ALUR CANCEL ---
    else if (data.startsWith('cancel_')) {
        const order_id = data.split('_')[1];
        const originalText = message.text; 

        try {
            const headers = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
            const CANCEL_URL = `${ORDER_BASE_URL}/${order_id}/cancel`;
            const response = await axios.get(CANCEL_URL, { headers });
            const result = response.data;
            
            let isSuccess = (response.status === 200 && result.status === 'success');
            let isAlreadyCanceled = result.message?.toLowerCase().includes('order cancelled successfully') || result.message?.toLowerCase().includes('order already canceled');
            
            if (isSuccess || isAlreadyCanceled) {
                // HANYA EDIT PESAN dengan status "DIBATALKAN"
                const newText = originalText.split('Status:')[0].trim() + '\n\n✅ *STATUS: DIBATALKAN*';
                logAndEdit(chatId, message.message_id, newText, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } // Hapus tombol
                });
                writeLog(`[ACTION] Pesanan ID ${order_id} dibatalkan oleh ${chatId}.`);
                updateHistory(chatId, order_id, null, null, 'CANCELED');
            } else {
                // Kegagalan API 200 OK, tapi status non-sukses
                const errorApiMessage = result.message || 'Error API tak dikenal.';
                const newText = originalText + `\n\n⚠️ *Gagal Batalkan.* Pesan: ${errorApiMessage.substring(0, 50)}...`; // POTONG PESAN ERROR API
                logAndEdit(chatId, message.message_id, newText, {parse_mode: 'Markdown', reply_markup: message.reply_markup});
                writeLog(`[ERROR] Gagal Cancel ID ${order_id}: ${result.message || 'Unknown Error'}`);
            }
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            
            // Cek jika error API menunjukkan pembatalan tidak mungkin (misal: "Early access denied")
            const isDenied = errorMsg.toLowerCase().includes('denied') || errorMsg.toLowerCase().includes('too early');

            if (errorMsg.toLowerCase().includes('order cancelled successfully') || errorMsg.toLowerCase().includes('order already canceled') || errorMsg.toLowerCase().includes('order cannot be finished')) {
                const finalSuccessText = originalText.split('Status:')[0].trim() + '\n\n✅ *STATUS: DIBATALKAN* (Oleh API)';
                logAndEdit(chatId, message.message_id, finalSuccessText, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } 
                });
                updateHistory(chatId, order_id, null, null, 'CANCELED');
            } else {
                // Jika error lain (termasuk DENIED/TOO EARLY)
                const errorText = `❌ *Gagal Batal.* Pesan: ${errorMsg.substring(0, 50)}...`;
                
                // Hapus tombol Cancel/Finish/Check jika pembatalan dilarang API
                const reply_markup = isDenied ? { inline_keyboard: [] } : message.reply_markup;
                
                logAndEdit(chatId, message.message_id, originalText + `\n\n${errorText}`, { parse_mode: 'Markdown', reply_markup: reply_markup });
            }
        }
    }

    // --- ALUR FINISH ---
    else if (data.startsWith('finish_')) {
        const order_id = data.split('_')[1];
        const originalText = message.text; 
        let isSuccess = false;
        
        try {
            const headers = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
            const FINISH_URL = `${ORDER_BASE_URL}/${order_id}/finish`;
            const response = await axios.get(FINISH_URL, { headers });
            const result = response.data;
            
            const errorMsg = result.message?.toLowerCase() || '';
            const isAlreadyCompleted = errorMsg.includes('order already completed') || errorMsg.includes('order finished successfully');

            isSuccess = (response.status === 200 && result.status === 'success');
            
            if (isSuccess || isAlreadyCompleted) {
                 // Skenario Sukses: Order selesai (atau sudah selesai)
                const newText = originalText.split('Status:')[0].trim() + '\n\n✅ *STATUS: SELESAI*';
                logAndEdit(chatId, message.message_id, newText, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } 
                });
                writeLog(`[ACTION] Pesanan ID ${order_id} diselesaikan oleh ${chatId}.`);
                updateHistory(chatId, order_id, null, null, 'FINISHED'); 
                return;
            } else {
                // Skenario Gagal 200 OK (tapi success: false)
                // Lanjut ke blok 'else' di luar try/catch untuk 'skip error'
                throw new Error(`API returned non-success (Status: false) for Finish. Message: ${result.message}`);
            }
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;

            // Logika untuk mendeteksi order sudah selesai tetap dipertahankan
            const isCompletedError = errorMsg.toLowerCase().includes('order already completed') || errorMsg.toLowerCase().includes('order finished successfully') || errorMsg.toLowerCase().includes('order cannot be finished');

            if (isCompletedError) {
                 // Jika error-nya adalah karena order SUDAH SELESAI (Perlakukan sebagai sukses)
                const finalSuccessText = originalText.split('Status:')[0].trim() + '\n\n✅ *STATUS: SELESAI* (Oleh API)';
                logAndEdit(chatId, message.message_id, finalSuccessText, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } 
                });
                updateHistory(chatId, order_id, null, null, 'FINISHED');
                writeLog(`[ACTION] Pesanan ID ${order_id} diselesaikan oleh ${chatId}. (Error: Sudah Selesai)`);
                return;
            }
            
            // --- LOGIKA UTAMA FINISH SKIP ERROR (Menangani user_id on null, dll.) ---
            writeLog(`[ERROR/FINISH_SKIP] Gagal Finish ID ${order_id} (Exception: ${errorMsg}). Skip error, move to history.`);

            // 1. Tandai sebagai FINISHED di riwayat (Mengambil data nomor lama)
            updateHistory(chatId, order_id, null, null, 'FINISHED');
            
            // 2. Hapus pesan lama (yang menampilkan nomor)
            bot.deleteMessage(chatId, message.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan: ${err.message}`));
            
            // 3. Kirim pesan konfirmasi ke user
            logAndSend(chatId, `✅ *Pesanan ID: \`${order_id}\` dianggap SELESAI (Error diabaikan)* dan telah dimasukkan ke Riwayat Order.`, { parse_mode: 'Markdown' });
        }
    }
});