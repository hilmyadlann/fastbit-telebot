const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs'); // Pastikan modul FS dimuat di awal

// --- Fungsi Utilitas untuk Logging ke file ---
const LOG_FILE = 'aktivitas_bot.txt';

function writeLog(message) {
    // Fungsi ini harus memanggil fs.appendFile
    const timestamp = new Date().toLocaleString('id-ID');
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFile(LOG_FILE, logEntry, (err) => {
        if (err) console.error('Gagal menulis log ke file:', err);
    });
}
// --- AKHIR FUNGSI LOG ---

// --- KONFIGURASI BOT & API KEY ---
const TELEGRAM_BOT_TOKEN = "7348650612:AAGxw63Hs1bzLBr994f07dkMeRNwI_-_f9w"; 
const API_KEY = "jxA5WWudkNyCsavNUJiTRktDoiJ4i358";

// Endpoints
const PROFILE_URL = "https://fastbit.tech/api/profile";
const GENERATE_ORDER_URL = "https://fastbit.tech/api/virtual-number/generate-order"; 
const ORDER_DETAILS_BASE_URL = "https://fastbit.tech/api/virtual-number/orders"; 
const ORDER_BASE_URL = "https://fastbit.tech/api/virtual-number/orders"; 

// Konstanta Retry (6 kali, 1 detik/retry = 6 detik total)
const MAX_RETRIES = 6; 
const RETRY_DELAY = 1000; 

// ID Layanan dan Provider yang terfokus
const TARGET_SERVICE_ID = 1368;        
const OTP_SERVICE_ID = 145163;         
const TARGET_COUNTRY_ID = 91;          

// Headers API
const API_HEADERS = {
    "X-API-KEY": API_KEY,
    "Content-Type": "application/json"
};

// Variabel dan Fungsi Utilitas
let activeOrders = {}; 
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// --- AKHIR KONFIGURASI ---

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log("Bot Telegram MIWE-BOT sedang berjalan...");
writeLog("Bot dimulai dan siap melayani."); // Ini adalah panggilan pertama ke writeLog

// --- Fungsi untuk menghasilkan Inline Keyboard Aksi ---
function getOrderActionKeyboard(order_id) {
    return {
        inline_keyboard: [
            [
                { text: '🔄 Get code / Get new code', callback_data: `check_${order_id}` } 
            ]
        ]
    };
}

// --- Fungsi untuk memformat pesan OTP ---
async function formatOtpMessage(order_id) {
    const url_details = `${ORDER_DETAILS_BASE_URL}/${order_id}`;
    const response = await axios.get(url_details, { headers: API_HEADERS });
    const order_data = response.data.data;
    
    // Penanganan data null/kosong dari API
    if (!order_data || !order_data.computed || !order_data.number) {
        throw new Error("Data detail order tidak lengkap atau hilang dari API.");
    }
    
    let otp_code = "Menunggu OTP...";
    
    const raw_number = order_data.number || order_data.formatted_number;
    const clean_number = raw_number.startsWith('+') ? raw_number.substring(1) : raw_number; 

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
            otp_code = `*${extracted_otp}* (OTP Diterima)`;
        }
    }

    const finalMessage = 
        `FORE COFFEE: \`${clean_number}\` | ${otp_code}`;

    return {
        text: finalMessage,
        options: { 
            parse_mode: 'Markdown',
            reply_markup: getOrderActionKeyboard(order_id)
        },
        logData: { clean_number, otp_code }
    };
}

// =======================================================
// 1. HANDLER PERINTAH /start (Menampilkan Tombol Menu Utama)
// =======================================================
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    writeLog(`User ${chatId} memulai chat.`);
    
    const options = {
        reply_markup: {
            keyboard: [
                [{ text: 'Beli Kode OTP' }] 
            ],
            resize_keyboard: true
        }
    };
    
    const welcomeMessage = "Selamat datang di Bot MiweDigital! Silakan pilih opsi di bawah ini.";
    bot.sendMessage(chatId, welcomeMessage, options);
});


// =======================================================
// 2. HANDLER /ceksaldo
// =======================================================
bot.onText(/(\/ceksaldo|💰 Cek Saldo)/, async (msg) => {
    const chatId = msg.chat.id;
    writeLog(`User ${chatId} mengecek saldo.`);
    try {
        const response = await axios.get(PROFILE_URL, { headers: API_HEADERS });
        const data = response.data;
        if (data.status === 200 && data.user) {
            const user_data = data.user;
            const name = user_data.name || "Nama tidak ditemukan";
            const active_balance = user_data.active_balance || "Rp 0"; 
            const message = `*Laporan Saldo*\n\n👤 *Nama:* \`${name}\`\n💰 *Saldo Aktif Anda:* \`${active_balance}\``;
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `⚠️ Gagal mengecek saldo. Pesan API: ${data.message || 'Format respons tidak valid'}`);
        }
    } catch (error) {
        let errorMessage = "❌ Terjadi kesalahan saat menghubungi API (Cek Saldo).";
        if (error.response && error.response.status) { errorMessage = `❌ Kesalahan HTTP: Kode ${error.response.status}.`; } else { errorMessage += `\nDetail: ${error.message}`; }
        bot.sendMessage(chatId, errorMessage);
        writeLog(`[ERROR] Gagal Cek Saldo untuk ${chatId}: ${error.message}`);
    }
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
                [{ text: 'FORE COFFEE', callback_data: `order_service_${TARGET_SERVICE_ID}` }]
            ]
        }
    };
    
    bot.sendMessage(chatId, "Pilih Layanan:", options);
});

// =======================================================
// 6. HANDLER Callback Query (Memproses Order)
// =======================================================
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

    bot.answerCallbackQuery(callbackQuery.id);

    // --- ALUR ORDER BARU (FORE COFFEE) ---
    if (data.startsWith('order_service_')) {
        
        // Hapus pesan inline keyboard FORE COFFEE yang baru saja diklik
        bot.deleteMessage(chatId, message.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan lama: ${err.message}`));
        
        let waitMessage = await bot.sendMessage(chatId, `⏳ Pesanan dibuat. Mencari nomor virtual (Max ${MAX_RETRIES}x coba ulang)...`);
        
        let order_id = null; 

        try {
            // PANGGILAN 1: Generate Order
            const url_generate = 
                `${GENERATE_ORDER_URL}?otp_service_id=${OTP_SERVICE_ID}&quantity=1`;
                
            const response = await axios.get(url_generate, { headers: API_HEADERS });
            const result = response.data;
            
            if (result.success) {
                
                order_id = result.data.order_ids[0]; 
                
                if (!order_id) throw new Error("UUID pesanan tidak ditemukan di respons Generate Order.");

                writeLog(`[INFO] Order ID ${order_id} berhasil dibuat.`);

                // --- LOGIKA UTAMA: RETRY LOOP ---
                let formatted = null;
                let success = false;
                
                for (let i = 0; i < MAX_RETRIES; i++) {
                    try {
                        formatted = await formatOtpMessage(order_id);
                        if (formatted.text) { 
                             success = true; // Berhasil, keluar dari loop
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
                activeOrders[chatId] = order_id; 

                // --- HAPUS PESAN TUNGGU & KIRIM PESAN BARU ---
                bot.deleteMessage(chatId, waitMessage.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan tunggu: ${err.message}`));
                
                bot.sendMessage(chatId, formatted.text, formatted.options);
                // Catat log sukses
                writeLog(`[SUCCESS] Nomor virtual ${formatted.logData.clean_number} | OTP: ${formatted.logData.otp_code.replace(/\*/g, '')} untuk ${order_id} ditampilkan ke ${chatId}.`);
                // --- AKHIR HAPUS & KIRIM BARU ---

            } else {
                bot.deleteMessage(chatId, waitMessage.message_id).catch(err => console.log(`[WARN] Gagal menghapus pesan tunggu: ${err.message}`));
                bot.sendMessage(chatId, `⚠️ Gagal membuat pesanan: ${result.message || 'Error Generate Order.'}`);
                writeLog(`[ERROR] Gagal Generate Order untuk ${chatId}: ${result.message || 'Unknown error'}`);
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
            bot.sendMessage(chatId, errorMessage);
        }
    } 
    
    // --- ALUR CHECK OTP (Untuk tombol "Get new code") ---
    else if (data.startsWith('check_')) {
        const order_id = data.split('_')[1];
        writeLog(`User ${chatId} mengecek OTP untuk Order ID: ${order_id}.`);
        
        // --- PERBAIKAN: Mengedit pesan yang sedang diklik (current message) ---
        let checkMessageText = `⏳ Memeriksa SMS terbaru...`;
        
        try {
            // Edit pesan yang diklik menjadi pesan tunggu/periksa
            bot.editMessageText(checkMessageText, {
                chat_id: chatId,
                message_id: message.message_id,
            });
            
            // Dapatkan format pesan OTP yang baru
            const formatted = await formatOtpMessage(order_id);
            
            // Edit pesan tunggu menjadi pesan hasil dengan Inline Keyboard
            bot.editMessageText(formatted.text, { 
                chat_id: chatId, 
                message_id: message.message_id, // EDIT PESAN YANG SAMA
                ...formatted.options 
            });
            // Catat log saat check OTP selesai
            writeLog(`[INFO] Check OTP sukses untuk Order ID ${order_id}. Nomor: ${formatted.logData.clean_number} | OTP Status: ${formatted.logData.otp_code.replace(/\*/g, '')}`);


        } catch (error) {
             bot.sendMessage(chatId, "❌ Gagal memeriksa status order. Coba lagi.");
             writeLog(`[ERROR] Gagal memproses Check OTP untuk ${order_id}: ${error.message}`);
        }
    }
    
    // --- ALUR CANCEL (DINONAKTIFKAN DARI TOMBOL) ---
    else if (data.startsWith('cancel_')) {
        bot.sendMessage(chatId, `⚠️ Pembatalan tidak diizinkan melalui bot ini.`);
    }

    // --- ALUR FINISH (DINONAKTIFKAN DARI TOMBOL) ---
    else if (data.startsWith('finish_')) {
        bot.sendMessage(chatId, `⚠️ Penyelesaian pesanan tidak diizinkan melalui bot ini.`);
    }
});