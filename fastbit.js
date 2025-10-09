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
const REFRESH_DELAY_MS = 20 * 60 * 1000; // 20 menit
// --- AKHIR KONFIGURASI API KEY ---

// --- Konstanta Logging ---
const LOG_FILE = 'aktivitas_bot.txt';
const HISTORY_FILE = 'riwayat_order.json'; 

// --- Fungsi Utilitas File System ---
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
        history[chatId][index] = { ...history[chatId][index], status, timestamp };
    } else {
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

// Konstanta Retry (6 kali, 1 detik/retry = 6 detik total)
const MAX_RETRIES = 6; 
const RETRY_DELAY = 1000; 

// ID Layanan dan Provider yang terfokus
const TARGET_SERVICE_FORE = 1368;        
const TARGET_SERVICE_KENANGAN = 1371; 
const OTP_ID_FORE = 145163;         
const OTP_ID_KENANGAN = 144477; 

// Variabel dan Fungsi Utilitas
let activeOrders = {}; 
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fungsi untuk mendapatkan/mengganti API Key
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
    const oldKeyData = API_KEY_LIST.find(k => k.key === oldKey);
    oldKeyData.limit_reached_at = Date.now();
    
    for (let i = 1; i <= API_KEY_LIST.length; i++) {
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

// --- TANGANI POLLING ERROR ---
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

async function logAndEdit(chatId, messageId, text, options) {
    writeLog(`[CHAT EDIT] Msg ID ${messageId} to ${chatId}: ${text.substring(0, 50)}...`);
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
}

// =======================================================
// FUNGSI UTAMA GENERATE ORDER DENGAN FAILOVER
// =======================================================
async function tryGenerateOrderWithFailover(url_generate) {
    const maxFailoverAttempts = API_KEY_LIST.length;
    let attempts = 0;
    
    while (attempts < maxFailoverAttempts) {
        const currentApiKey = getCurrentApiKey();
        const headers = { "X-API-KEY": currentApiKey, "Content-Type": "application/json" };
        
        try {
            const response = await axios.get(url_generate, { headers });
            const result = response.data;

            if (result.success) {
                return { success: true, result, apiKey: currentApiKey };
            }
            
            const errorMessage = result.message || '';
            if (errorMessage.toLowerCase().includes('insufficient balance')) {
                if (attempts < maxFailoverAttempts - 1) {
                    switchApiKey();
                    attempts++;
                    continue; // Coba lagi di iterasi berikutnya
                } else {
                    return { success: false, result, message: "Semua API Key kehabisan saldo." };
                }
            } else {
                return { success: false, result, message: errorMessage };
            }

        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            
            let shouldFailover = false;

            if (error.response?.status === 400 && errorMsg.toLowerCase().includes('insufficient balance')) {
                shouldFailover = true;
            } else if (error.response?.status === 401 || error.response?.status === 403 || errorMsg.toLowerCase().includes('invalid token')) { // Tambah 403 (Forbidden)
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
    return { success: false, message: "Semua upaya failover gagal." };
}


// --- Fungsi untuk menghasilkan Inline Keyboard Aksi ---
function getOrderActionKeyboard(order_id, service_id_for_next_order) {
    return {
        inline_keyboard: [
            [
                { text: '❌ Cancel', callback_data: `cancel_${order_id}` },
                { text: '🔄 Get code / Get new code', callback_data: `check_${order_id}` },
                { text: '✅ Finish', callback_data: `finish_${order_id}` }
            ],
            [
                { text: '🛍 Beli Nomer Lagi', callback_data: `order_service_${service_id_for_next_order}` } 
            ]
        ]
    };
}

// --- Fungsi untuk memformat pesan OTP ---
async function formatOtpMessage(order_id) {
    const url_details = `${ORDER_DETAILS_BASE_URL}/${order_id}`;
    const headers = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
    const response = await axios.get(url_details, { headers });
    const order_data = response.data.data;
    
    if (!order_data || !order_data.computed || !order_data.number) {
        throw new Error("Data detail order tidak lengkap atau hilang dari API.");
    }
    
    let otp_code = "Menunggu OTP...";
    let otp_code_raw = null;
    
    let raw_number = order_data.number || order_data.formatted_number;
    
    const isKenangan = (order_data.service.id === TARGET_SERVICE_KENANGAN);
    if (isKenangan) {
        raw_number = raw_number.replace(/^\+?62/, '');
        if (!raw_number.startsWith('8')) {
            raw_number = '8' + raw_number; 
        }
    } else {
        raw_number = raw_number.replace(/^\+/, '');
    }
    
    const clean_number = raw_number; 

    // Logika Ekstraksi OTP Berdasarkan Prioritas
    if (order_data.sms_count > 0) {
        let extracted_otp = null;
        
        if (order_data.sms && order_data.sms["0"] && order_data.sms["0"].code) {
             extracted_otp = order_data.sms["0"].code;
        } else if (order_data.sms && order_data.sms.new_messages && order_data.sms.new_messages.length > 0) {
            extracted_otp = order_data.sms.new_messages[0].code || order_data.sms.new_messages[0].message;
        } else if (order_data.sms && order_data.sms["0"] && order_data.sms["0"].text) {
             extracted_otp = order_data.sms["0"].text;
        } else if (order_data.sms_code) {
             extracted_otp = order_data.sms_code;
        }

        if (extracted_otp) {
            // FIX FINAL: HANYA TAMPILKAN KODE MENTAH TANPA TANDA BINTANG
            otp_code = extracted_otp;
            otp_code_raw = extracted_otp;
        }
    }

    const service_name = isKenangan ? "KOPI KENANGAN" : "FORE COFFEE";

    // FORMAT PESAN UTAMA (Nomor dan OTP menyatu dalam satu code block)
    // FIX FINAL: Kedua nilai dibungkus code block agar bisa di-copy
    const finalMessage = 
        `${service_name}: \`${clean_number}\` | \`${otp_code}\``;

    // Tombol aksi standar
    const action_keyboard = getOrderActionKeyboard(order_id, order_data.service.id).inline_keyboard;

    return {
        text: finalMessage,
        options: { 
            parse_mode: 'Markdown',
            // MEMASANG TOMBOL AKSI STANDAR
            reply_markup: {
                inline_keyboard: [
                    ...action_keyboard
                ]
            }
        },
        logData: { clean_number, otp_code: otp_code_raw || otp_code, service: service_name }
    };
}

// =======================================================
// 1. HANDLER PERINTAH /start 
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
// 3. HANDLER RIWAYAT ORDER
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

    // Filter hanya yang sudah selesai/dibatalkan (asumsi OTP masuk hanya untuk FINISHED)
    const finalHistory = allHistory.filter(item => item.status === 'FINISHED' || item.status === 'CANCELED');

    if (finalHistory.length === 0) {
        return logAndSend(chatId, "Riwayat order yang sudah selesai/dibatalkan tidak ditemukan.");
    }

    const groupedHistory = finalHistory.reduce((acc, item) => {
        if (!acc[item.service]) {
            acc[item.service] = [];
        }
        // Hanya tambahkan nomor yang statusnya FINISHED (OTP masuk)
        if (item.status === 'FINISHED') {
             acc[item.service].push(item.number);
        }
       
        return acc;
    }, {});

    let message = "*📜 Riwayat Order yang Selesai (OTP Masuk):*\n\n";

    let foundAnyFinished = false;

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
// 4. HANDLER HAPUS RIWAYAT
// =======================================================
bot.onText(/(\/hapusriwayat|\s*🗑️\s*Hapus Riwayat)/i, async (msg) => {
    const chatId = msg.chat.id;
    writeLog(`User ${chatId} meminta penghapusan riwayat.`);
    
    const history = readHistory();

    if (!history[chatId] || history[chatId].length === 0) {
        return logAndSend(chatId, "Riwayat Anda sudah kosong.");
    }
    
    // Hapus riwayat hanya untuk chat ID ini
    delete history[chatId];
    writeHistory(history);

    logAndSend(chatId, "✅ Riwayat order Anda telah dihapus.");
});


// =======================================================
// 5. HANDLER /beli_kode_otp (Menampilkan Menu Pilihan Tunggal)
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
// 6. HANDLER Callback Query (Memproses Order dengan Failover)
// =======================================================
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

    // --- Tombol Salin (Dinonaktifkan) ---
    if (data.startsWith('copy_num_') || data.startsWith('copy_otp_') || data.startsWith('service_info')) {
        // Cukup jawab callback query tanpa melakukan apa-apa
        try { bot.answerCallbackQuery(callbackQuery.id); } catch (e) {}
        return; 
    }

    // Tangani ETELEGRAM error, hanya jawab jika query tidak terlalu lama
    try {
        bot.answerCallbackQuery(callbackQuery.id);
    } catch (e) {
        console.error(`[WARN] Gagal menjawab callback query lama: ${e.message}`);
    }

    // --- ALUR ORDER BARU (FORE COFFEE & KOPI KENANGAN) ---
    if (data.startsWith('order_service_')) {
        
        // Ambil ID Layanan dari callback data
        const targetServiceId = parseInt(data.split('_')[2]); 
        
        // --- KRUSIAL: Menentukan OTP ID berdasarkan Service ID ---
        const otpServiceId = (targetServiceId === TARGET_SERVICE_KENANGAN) ? OTP_ID_KENANGAN : OTP_ID_FORE;
        // -----------------------------------------------------------
        
        // Hapus pesan inline keyboard Pilih Layanan yang baru saja diklik
        if (message.text.includes("Pilih Layanan")) {
            bot.deleteMessage(chatId, message.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan lama: ${err.message}`));
        }
        
        let waitMessage = await logAndSend(chatId, `⏳ Pesanan dibuat. Mencari nomor virtual (Max ${MAX_RETRIES}x coba ulang)...`);
        
        let order_id = null; 

        try {
            // PANGGILAN 1: Generate Order DENGAN FAILOVER
            const url_generate = 
                `${GENERATE_ORDER_URL}?otp_service_id=${otpServiceId}&application_id=${targetServiceId}&quantity=1`;
                
            const failoverResult = await tryGenerateOrderWithFailover(url_generate);
            
            if (failoverResult.success) {
                const result = failoverResult.result;
                order_id = result.data.order_ids[0]; 
                
                if (!order_id) throw new Error("UUID pesanan tidak ditemukan di respons Generate Order.");

                writeLog(`[INFO] Order ID ${order_id} berhasil dibuat dengan Key ${failoverResult.apiKey.substring(0, 5)}....`);

                // --- LOGIKA UTAMA: RETRY LOOP ---
                let formatted = null;
                let success = false;
                
                for (let i = 0; i < MAX_RETRIES; i++) {
                    try {
                        formatted = await formatOtpMessage(order_id);
                        if (formatted.text) { 
                             success = true; 
                             break;
                        }
                    } catch (e) {
                        console.log(`[RETRY] Percobaan ${i + 1}/${MAX_RETRIES} gagal mengambil detail. Menunggu 1 detik...`);
                        await delay(RETRY_DELAY);
                    }
                }
                
                if (!success) {
                    throw new Error("Gagal mendapatkan nomor virtual dan OTP setelah semua percobaan.");
                }

                // Logika pesan sukses
                
                // --- UPDATE RIWAYAT: Status SUCCESS ---
                updateHistory(chatId, order_id, formatted.logData.clean_number, formatted.logData.service, 'SUCCESS');
                // -------------------------------------

                // --- HAPUS PESAN TUNGGU & KIRIM PESAN BARU ---
                bot.deleteMessage(chatId, waitMessage.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan tunggu: ${err.message}`));
                
                logAndSend(chatId, formatted.text, formatted.options);
                // Catat log sukses
                writeLog(`[SUCCESS] Nomor virtual ${formatted.logData.clean_number} | OTP: ${formatted.logData.otp_code.replace(/\*/g, '')} untuk ${order_id} ditampilkan ke ${chatId}.`);
                // --- AKHIR HAPUS & KIRIM BARU ---

            } else {
                 // Gagal setelah semua upaya failover
                bot.deleteMessage(chatId, waitMessage.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan tunggu: ${err.message}`));
                logAndSend(chatId, `⚠️ Gagal membuat pesanan: ${failoverResult.message}`);
                writeLog(`[ERROR] Gagal Generate Order (FAILOVER GAGAL) untuk ${chatId}: ${failoverResult.message}`);
            }

        } catch (error) {
            let errorMessage = "❌ Terjadi kesalahan saat memproses pembelian.";
            
            if (error.message.includes("Gagal mendapatkan nomor virtual") || error.message.includes("setelah semua percobaan")) {
                errorMessage = `❌ ${error.message} Coba *Get new code* di chat terpisah.`;
            } else if (error.message.includes("UUID pesanan tidak ditemukan")) {
                errorMessage = `❌ ${error.message}. Coba batalkan order di web.`;
            } else if (error.response) {
                errorMessage = `❌ Kesalahan API: ${error.response.data.message || 'Pastikan ID Layanan aktif.'}`;
            } else {
                errorMessage += `\nDetail: ${error.message}`;
            }
            
            console.error(`[DEBUG ERROR] Gagal Memproses Order. Order ID: ${order_id}`, error);
            writeLog(`[FATAL ERROR] Pemrosesan order gagal untuk ${chatId}. Order ID: ${order_id}. Detail: ${errorMessage}`);
            
            // Hapus pesan tunggu dan kirim pesan error sebagai pesan baru
            bot.deleteMessage(chatId, waitMessage.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan tunggu: ${err.message}`));
            logAndSend(chatId, errorMessage);
        }
    } 
    
    // --- ALUR CHECK OTP (Untuk tombol "Get new code") ---
    else if (data.startsWith('check_')) {
        const order_id = data.split('_')[1];
        writeLog(`User ${chatId} mengecek OTP untuk Order ID: ${order_id}.`);
        
        let checkMessageText = `⏳ Memeriksa SMS terbaru...`;
        
        try {
            // Edit pesan yang diklik menjadi pesan tunggu/periksa
            logAndEdit(chatId, message.message_id, checkMessageText, {
                parse_mode: 'Markdown'
            });
            
            // Dapatkan format pesan OTP yang baru
            const formatted = await formatOtpMessage(order_id);
            
            // Edit pesan tunggu menjadi pesan hasil dengan Inline Keyboard
            logAndEdit(chatId, message.message_id, formatted.text, formatted.options);
            // Catat log saat check OTP selesai
            writeLog(`[INFO] Check OTP sukses untuk Order ID ${order_id}. Nomor: ${formatted.logData.clean_number} | OTP Status: ${formatted.logData.otp_code.replace(/\*/g, '')}`);


        } catch (error) {
             logAndSend(chatId, "❌ Gagal memeriksa status order. Coba lagi.");
             writeLog(`[ERROR] Gagal memproses Check OTP untuk ${order_id}: ${error.message}`);
        }
    }
    
    // --- ALUR CANCEL ---
    else if (data.startsWith('cancel_')) {
        const order_id = data.split('_')[1];
        try {
            const headers = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
            const CANCEL_URL = `${ORDER_BASE_URL}/${order_id}/cancel`;
            const response = await axios.get(CANCEL_URL, { headers });
            const result = response.data;
            
            let isSuccess = (response.status === 200 && result.status === 'success');
            let isAlreadyCanceled = result.message?.toLowerCase().includes('order cancelled successfully');
            
            if (isSuccess || isAlreadyCanceled) {
                logAndEdit(chatId, message.message_id, `✅ *Pesanan DIBATALKAN!* Order ID: \`${order_id}\``, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } // Hapus tombol
                });
                writeLog(`[ACTION] Pesanan ID ${order_id} dibatalkan oleh ${chatId}.`);
                updateHistory(chatId, order_id, null, null, 'CANCELED');
            } else {
                logAndSend(chatId, `⚠️ Gagal membatalkan pesanan (ID: \`${order_id}\`). Pesan: ${result.message || 'Coba lagi setelah 1 menit.'}`);
                writeLog(`[ERROR] Gagal Cancel ID ${order_id}: ${result.message || 'Unknown Error'}`);
            }
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            
            if (errorMsg.toLowerCase().includes('order cancelled successfully')) {
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

    // --- ALUR FINISH ---
    else if (data.startsWith('finish_')) {
        const order_id = data.split('_')[1];
        try {
            const headers = { "X-API-KEY": getCurrentApiKey(), "Content-Type": "application/json" };
            const FINISH_URL = `${ORDER_BASE_URL}/${order_id}/finish`;
            const response = await axios.get(FINISH_URL, { headers });
            const result = response.data;
            
            let isSuccess = (response.status === 200 && result.status === 'success');
            let isAlreadyFinished = result.message?.toLowerCase().includes('order finished successfully') || result.message?.toLowerCase().includes('order already completed');

            if (isSuccess || isAlreadyFinished) {
                logAndEdit(chatId, message.message_id, `✅ *Pesanan SELESAI!* Order ID: \`${order_id}\``, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } // Hapus tombol
                });
                writeLog(`[ACTION] Pesanan ID ${order_id} diselesaikan oleh ${chatId}.`);
                updateHistory(chatId, order_id, null, null, 'FINISHED');
            } else {
                logAndSend(chatId, `⚠️ Gagal menyelesaikan pesanan (ID: \`${order_id}\`). Pesan: ${result.message || 'Status order tidak valid.'}`);
                writeLog(`[ERROR] Gagal Finish ID ${order_id}: ${result.message || 'Unknown Error'}`);
            }
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            
            if (errorMsg.toLowerCase().includes('order finished successfully') || errorMsg.toLowerCase().includes('order already completed')) {
                 logAndEdit(chatId, message.message_id, `✅ *Pesanan SELESAI!* Order ID: \`${order_id}\``, { 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } 
                });
                 writeLog(`[ACTION] Pesanan ID ${order_id} diselesaikan oleh ${chatId}. (Catch Block Success)`);
                 updateHistory(chatId, order_id, null, null, 'FINISHED');
            } else {
                logAndSend(chatId, `❌ Terjadi kesalahan saat Finish Order. Coba lagi.`);
            }
        }
    }
});