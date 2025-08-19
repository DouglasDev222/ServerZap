const express = require("express");
const rateLimit = require("express-rate-limit");
const { Client, LocalAuth } = require("whatsapp-web.js"); // Reintroduzindo LocalAuth
const qrcode = require("qrcode");
const { Queue, Worker } = require("bullmq");
const Redis = require("ioredis");
const fs = require("fs").promises; // Importa o módulo fs.promises para operações de arquivo assíncronas
const path = require("path"); // Importa o módulo path para manipular caminhos de arquivo

// Tratamento de erro global para promessas não tratadas
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Opcional: Adicionar lógica para tentar recuperar ou logar o erro em um sistema de monitoramento
  // Para ambientes de produção, pode-se considerar encerrar o processo de forma controlada
});

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());

app.set("trust proxy", 1); // Confia no primeiro proxy para o express-rate-limit

// Rate limit básico para evitar sobrecarga por requisições
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 300, // máx. 300 req/IP por janela
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const API_KEY = process.env.API_KEY || "12345678"; // Em produção, use variável segura!

// Middleware de autenticação
const authenticateApiKey = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    return res
      .status(401)
      .json({ status: "error", description: "Token de autenticação ausente." });
  }

  const token = authHeader.split(" ")[1];
  if (token !== API_KEY) {
    return res
      .status(401)
      .json({ status: "error", description: "Token de autenticação inválido." });
  }
  next();
};

app.use(authenticateApiKey);

let client;
let qrCodeData = null; // DataURL (base64) gerado sob demanda
let qrRaw = null; // string do QR original emitido pelo evento
let clientReady = false;

// Configuração do Redis para BullMQ
const connection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Fila de mensagens do WhatsApp
const messageQueue = new Queue("whatsappMessages", { connection });

// Função para limpar a pasta de sessão do WhatsApp Web JS
const cleanSessionFolder = async () => {
  const sessionPath = path.join(__dirname, ".wwebjs_auth");
  try {
    await fs.rm(sessionPath, { recursive: true, force: true });
    console.log("Pasta de sessão limpa com sucesso.");
  } catch (e) {
    console.error("Erro ao limpar a pasta de sessão:", e.message);
  }
};

// Função para destruir o cliente de forma segura
const destroyClient = async () => {
  if (client) {
    try {
      if (client.pupBrowser) {
        await client.pupBrowser.close(); // Fecha o navegador Puppeteer
      }
      // Tenta destruir a sessão do whatsapp-web.js
      await client.destroy(); 
      console.log("Cliente WhatsApp destruído com sucesso.");
    } catch (e) {
      console.error("Erro ao destruir o cliente WhatsApp:", e.message);
      // Ignora erros como EBUSY ou Protocol error, pois o objetivo é evitar a queda da aplicação
    }
    client = null;
  }
};

// Inicializa o cliente do WhatsApp
const initializeWhatsAppClient = async () => {
  await destroyClient(); // Garante que o cliente anterior seja destruído de forma segura
  await cleanSessionFolder(); // Limpa a pasta de sessão antes de inicializar um novo cliente

  client = new Client({
    authStrategy: new LocalAuth(), // Reintroduzindo LocalAuth
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-breakpad",
        "--disable-component-extensions-with-background-pages",
        "--disable-features=TranslateUI,BlinkGenPropertyTrees",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-pings",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
    },
  });

  client.on("qr", (qr) => {
    console.log("QR RECEIVED");
    qrRaw = qr;
    qrCodeData = null; // Limpa o QR base64 anterior
    clientReady = false; // Garante que o status seja atualizado para qr_code_needed
  });

  client.on("ready", () => {
    console.log("Client is ready!");
    clientReady = true;
    qrCodeData = null;
    qrRaw = null;
  });

  client.on("disconnected", async (reason) => {
    console.log("Client was disconnected", reason);
    clientReady = false;
    qrCodeData = null;
    qrRaw = null;
    // Tenta reiniciar o cliente após um pequeno atraso para permitir um novo QR
    setTimeout(() => initializeWhatsAppClient(), 5000); 
  });

  client.on("auth_failure", async (msg) => {
    console.error("AUTHENTICATION FAILURE", msg);
    clientReady = false;
    qrCodeData = null;
    qrRaw = null;
    // Tenta reiniciar o cliente após um pequeno atraso em caso de falha de autenticação
    setTimeout(() => initializeWhatsAppClient(), 5000); 
  });

  try {
    await client.initialize();
  } catch (e) {
    console.error("Erro na inicialização do cliente WhatsApp:", e.message);
    // A aplicação não deve cair devido a isso, mas o erro é logado
  }
};

initializeWhatsAppClient();

const workerConcurrency = Number(process.env.WORKER_CONCURRENCY || 1);
const worker = new Worker(
  "whatsappMessages",
  async (job) => {
    const { number, message } = job.data;

    if (!clientReady) {
      console.error(
        `Worker: Cliente WhatsApp não está pronto para enviar mensagem para ${number}. Reagendando...`
      );
      // Não lança erro aqui para evitar que o job fique em loop infinito de retentativas
      // em caso de desconexão prolongada. A mensagem será retentada quando o cliente estiver pronto.
      return { status: "failed", description: "Cliente WhatsApp não está pronto." };
    }

    try {
      const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
      console.log(`Worker: Enviando mensagem para ${chatId}`);
      const msg = await client.sendMessage(chatId, message);
      console.log(
        `Worker: Mensagem enviada com sucesso para ${chatId}. ID: ${msg.id._serialized}`
      );
      return { messageId: msg.id._serialized };
    } catch (error) {
      console.error(`Worker: Erro ao enviar mensagem para ${number}:`, error);
      throw error; // retentativa em caso de outros erros de envio
    }
  },
  { connection, concurrency: workerConcurrency }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} concluído com sucesso.`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job.id} falhou com erro: ${err?.message}`);
});

app.get("/status", (req, res) => {
  let connectionStatus = "disconnected";
  if (clientReady) {
    connectionStatus = "connected";
  } else if (qrRaw) {
    connectionStatus = "qr_code_needed";
  } else if (client && client.pupBrowser) {
    connectionStatus = "connecting";
  }

  res.json({
    status: "success",
    connectionStatus: connectionStatus,
    description: `Status da conexão: ${connectionStatus}`,
  });
});

app.get("/qrcode", async (req, res) => {
  if (clientReady) {
    return res.status(409).json({
      status: "error",
      description: "Já conectado ao WhatsApp ou QR Code não necessário no momento.",
    });
  }

  if (!qrRaw) {
    return res.status(500).json({
      status: "error",
      description: "QR Code não disponível no momento. Tente novamente em breve.",
    });
  }

  try {
    if (!qrCodeData) {
      qrCodeData = await qrcode.toDataURL(qrRaw);
    }
    // Remove o prefixo \'data:image/png;base64,\'
    const base64Qr = qrCodeData.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");

    res.json({
      status: "success",
      qrCode: base64Qr,
      qrCodeType: "base64",
      qrCodeRaw: qrRaw,
      description: "QR Code gerado. Escaneie com seu celular.",
    });
  } catch (err) {
    console.error("Erro ao gerar DataURL do QR:", err);
    res.status(500).json({
      status: "error",
      description: "Falha ao gerar o QR Code.",
    });
  }
});

app.post("/send-message", async (req, res) => {
  const { number, message } = req.body;

  if (!number || !message) {
    return res.status(400).json({
      status: "error",
      description: "Número e mensagem são obrigatórios.",
    });
  }

  try {
    const job = await messageQueue.add(
      "sendMessage",
      { number, message },
      {
        attempts: Number(process.env.JOB_ATTEMPTS || 3),
        backoff: { type: "exponential", delay: Number(process.env.JOB_BACKOFF_MS || 1000) },
        removeOnComplete: true,
        removeOnFail: 50,
      }
    );

    res.json({
      status: "success",
      jobId: job.id,
      description: "Mensagem adicionada à fila para envio.",
    });
  } catch (error) {
    console.error("Erro ao adicionar mensagem à fila:", error);
    res.status(500).json({
      status: "error",
      description: `Erro ao adicionar mensagem à fila. Detalhes: ${error.message}`,
    });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://0.0.0.0:${port}`);
});


