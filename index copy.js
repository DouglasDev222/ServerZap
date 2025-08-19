const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const { Queue, Worker } = require("bullmq");
const Redis = require("ioredis");
const os = require("os");
const path = require("path");

const app = express();
const port = 5000;

app.use(express.json());

const API_KEY = process.env.API_KEY || "12345678"; 

// Middleware de autenticação
const authenticateApiKey = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
        return res.status(401).json({ status: "error", description: "Token de autenticação ausente." });
    }
    const token = authHeader.split(" ")[1];
    if (token !== API_KEY) {
        return res.status(401).json({ status: "error", description: "Token de autenticação inválido." });
    }
    next();
};

app.use(authenticateApiKey);

let client;
let qrCodeData = null;
let clientReady = false;

// Configuração do Redis para BullMQ
const connection = new Redis({
    host: "localhost",
    port: 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

// Fila de mensagens do WhatsApp
const messageQueue = new Queue("whatsappMessages", { connection });

// Detecta sistema operacional e define executablePath
const getChromeExecutablePath = () => {
    const platform = os.platform();
    if (platform === "win32") {
        // Windows: usa Chrome instalado
        return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    } else if (platform === "linux") {
        // Linux: usa Chromium do sistema
        return "/usr/bin/chromium-browser";
    } else if (platform === "darwin") {
        // MacOS
        return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    } else {
        // fallback: usa Chromium baixado pelo Puppeteer
        return null;
    }
};

// Inicializa o cliente do WhatsApp
const initializeWhatsAppClient = () => {
    const executablePath = getChromeExecutablePath();

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: executablePath || undefined,
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--disable-gpu",
                "--disable-extensions",
                "--disable-software-rasterizer"
            ],
        }
    });

    client.on("qr", (qr) => {
        console.log("QR RECEIVED", qr);
        qrcode.toDataURL(qr, (err, url) => {
            qrCodeData = url;
        });
    });

    client.on("ready", () => {
        console.log("Client is ready!");
        clientReady = true;
        qrCodeData = null;
    });

    client.on("disconnected", async (reason) => {
        console.log("Client was disconnected", reason);
        clientReady = false;
        qrCodeData = null;
        if (client.pupBrowser) {
            await client.pupBrowser.close().catch(() => {});
        }
        // Reconexão opcional
        // setTimeout(() => initializeWhatsAppClient(), 5000);
    });

    client.on("auth_failure", (msg) => {
        console.error("AUTHENTICATION FAILURE", msg);
        clientReady = false;
        qrCodeData = null;
    });

    client.initialize();
};

initializeWhatsAppClient();

// Worker BullMQ
const worker = new Worker("whatsappMessages", async (job) => {
    const { number, message } = job.data;

    if (!clientReady) {
        throw new Error("Cliente WhatsApp não está pronto.");
    }

    const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
    const msg = await client.sendMessage(chatId, message);
    return { messageId: msg.id._serialized };
}, { connection });

worker.on("completed", (job) => {
    console.log(`Job ${job.id} concluído com sucesso.`);
});

worker.on("failed", (job, err) => {
    console.error(`Job ${job.id} falhou com erro: ${err.message}`);
});

// Endpoints
app.get("/status", (req, res) => {
    let connectionStatus = "disconnected";
    if (clientReady) connectionStatus = "connected";
    else if (qrCodeData) connectionStatus = "qr_code_needed";
    else if (client && client.pupBrowser) connectionStatus = "connecting";

    res.json({
        status: "success",
        connectionStatus,
        description: `Status da conexão: ${connectionStatus}`
    });
});

app.get("/qrcode", (req, res) => {
    if (clientReady) return res.status(409).json({ status: "error", description: "Já conectado." });
    if (qrCodeData) return res.json({ status: "success", qrCode: qrCodeData, description: "QR Code gerado." });
    return res.status(500).json({ status: "error", description: "QR Code não disponível no momento." });
});

app.post("/send-message", async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ status: "error", description: "Número e mensagem são obrigatórios." });

    try {
        const job = await messageQueue.add("sendMessage", { number, message }, {
            attempts: 3,
            backoff: { type: "exponential", delay: 1000 },
        });

        res.json({ status: "success", jobId: job.id, description: "Mensagem adicionada à fila." });
    } catch (error) {
        res.status(500).json({ status: "error", description: `Erro ao adicionar à fila: ${error.message}` });
    }
});

app.listen(port, () => console.log(`Servidor rodando em http://0.0.0.0:${port}`));
