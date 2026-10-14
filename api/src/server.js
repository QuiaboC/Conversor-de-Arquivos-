const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { pipeline } = require("node:stream/promises");
const { Pool } = require("pg");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { publishJob } = require("./queue");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = 500 * 1024 * 1024;
const UPLOAD_DIR = path.join(os.tmpdir(), "conversor-uploads");
const BUCKET = process.env.S3_BUCKET || "videos";
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "conversor",
  password: process.env.DB_PASSWORD || "conversor123",
  database: process.env.DB_NAME || "conversor",
});
pool.on("error", (error) => {
  console.error("Erro inesperado no pool PostgreSQL:", error.message);
});

// Configura o cliente S3 para se conectar ao MinIO ou outro serviço compatível com S3.
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || "minioadmin",
    secretAccessKey: process.env.S3_SECRET_KEY || "minioadmin123",
  },
});

const allowedFormats = ["mp4", "webm", "mp3", "jpg", "jpeg", "png", "webp"];

// Configura o Multer para armazenar arquivos temporariamente no diretório UPLOAD_DIR.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => {
      callback(null, UPLOAD_DIR);
    },
    filename: (req, file, callback) => {
      callback(null, crypto.randomUUID());
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter: (req, file, callback) => {
    if (!file.originalname || !file.originalname.trim()) {
      return callback(new Error("O arquivo precisa ter um nome válido."));
    }
    callback(null, true);
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function isValidUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function sanitizeFilename(filename) {
  const basename = path.basename(filename);

  const sanitized = basename
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 200);

  return sanitized || "video";
}

// Verifica se a API está funcionando.
app.get("/", (req, res) => {
  res.json({
    mensagem: "API funcionando",
  });
});

// Verifica a conexão com o PostgreSQL.
app.get("/health/db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "ok",
      banco: "PostgreSQL conectado",
      horario: result.rows[0].now,
    });
  } catch (error) {
    console.error("Erro ao verificar PostgreSQL:", error.message);

    res.status(503).json({
      erro: "Não foi possível conectar ao banco de dados.",
    });
  }
});

// Recebe um vídeo, armazena-o no S3 e cria o job de conversão.
// Envie o arquivo no campo multipart/form-data chamado "file".
// Envie também o campo "output_format": mp4, webm ou mp3.
app.post("/jobs", upload.single("file"), async (req, res) => {
  let inputKey = null;
  let uploadedToS3 = false;
  let jobCreated = false;
  const jobId = crypto.randomUUID();
  try {
    if (!req.file) {
      return res.status(400).json({
        erro: "Envie um arquivo no campo 'file'.",
      });
    }

    const email = String(req.body.email || "").trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email) || email.length > 255) {
      return res.status(400).json({
        erro: "Informe um endereço de e-mail válido.",
      });
    }

    const outputFormat = String(req.body.output_format || "").toLowerCase();

    if (!allowedFormats.includes(outputFormat)) {
      return res.status(400).json({
        erro: "Formato inválido.",
        formatos_permitidos: allowedFormats,
      });
    }

    const originalFilename = path.basename(req.file.originalname).slice(0, 255);
    const storedFilename = sanitizeFilename(originalFilename);
    inputKey = `inputs/${jobId}/${storedFilename}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: inputKey,
        Body: fs.createReadStream(req.file.path),
        ContentLength: req.file.size,
        ContentType: req.file.mimetype || "application/octet-stream",
      }),
    );

    uploadedToS3 = true;

    await pool.query(
      `INSERT INTO jobs (
      id, original_filename, output_format, status,
      input_key, email, created_at, updated_at
    )
    VALUES ($1, $2, $3, 'pending', $4, $5, NOW(), NOW())`,
      [jobId, originalFilename, outputFormat, inputKey, email],
    );

    // antenha aqui o restante do código atual da rota.M

    jobCreated = true;

    // 3. Marca como queued ANTES de publicar a mensagem.
    // Assim, o worker não pode começar o processamento e ter seu
    // status sobrescrito pela API.
    const queuedResult = await pool.query(
      `UPDATE jobs
       SET status = 'queued',
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND status = 'pending'
       RETURNING id`,
      [jobId],
    );

    if (queuedResult.rowCount !== 1) {
      throw new Error("Não foi possível preparar o job para entrar na fila.");
    }

    // 4. Publica a mensagem no RabbitMQ.
    try {
      await publishJob({
        id: jobId,
        original_filename: originalFilename,
        output_format: outputFormat,
      });
    } catch (queueError) {
      console.error(`Erro ao publicar job ${jobId}:`, queueError.message);

      // Se a publicação falhar, não deixa o job aparentar
      // estar aguardando processamento indefinidamente.
      await pool.query(
        `UPDATE jobs
         SET status = 'failed',
             error_message = $2,
             updated_at = NOW()
         WHERE id = $1
           AND status = 'queued'`,
        [
          jobId,
          `Falha ao publicar na fila: ${queueError.message}`.slice(0, 2000),
        ],
      );
      return res.status(503).json({
        erro: "O vídeo foi armazenado, mas não foi possível enviá-lo para a fila de conversão.",
        job_id: jobId,
        consultar: `/jobs/${jobId}`,
      });
    }

    // 5. Busca o estado atual, pois o worker pode já ter iniciado.
    const finalResult = await pool.query(
      `SELECT
         id,
         original_filename,
         output_format,
         status,
         input_key,
         output_key,
         error_message,
         created_at,
         updated_at
       FROM jobs
       WHERE id = $1`,
      [jobId],
    );
    return res.status(201).json({
      mensagem: "Vídeo recebido e job enviado para a fila.",
      job: finalResult.rows[0],
    });
  } catch (error) {
    console.error(`Erro ao criar job ${jobId}:`, error.message);
    // Se o arquivo chegou ao S3, mas o registro do job não foi
    // criado, tenta remover o objeto para evitar arquivos órfãos.
    if (uploadedToS3 && !jobCreated && inputKey) {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: inputKey,
          }),
        );
      } catch (cleanupError) {
        console.error(
          "Não foi possível remover o arquivo temporário do S3:",
          cleanupError.message,
        );
      }
    }
    return res.status(500).json({
      erro: "Não foi possível criar o job de conversão.",
    });
  } finally {
    if (req.file?.path) {
      try {
        await fsp.unlink(req.file.path);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          console.error(
            "Erro ao remover arquivo temporário:",
            cleanupError.message,
          );
        }
      }
    }
  }
});

// Consulta o estado de um job.
app.get("/jobs/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({
      erro: "O ID informado não é um UUID válido.",
    });
  }
  try {
    const result = await pool.query(
      `SELECT
         id,
         original_filename,
         output_format,
         status,
         input_key,
         output_key,
         error_message,
         created_at,
         updated_at
       FROM jobs
       WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({
        erro: "Job não encontrado.",
      });
    }
    return res.json({
      job: result.rows[0],
    });
  } catch (error) {
    console.error("Erro ao consultar job:", error.message);
    return res.status(500).json({
      erro: "Não foi possível consultar o job.",
    });
  }
});


// Permite baixar o arquivo convertido, se disponível.
app.get("/jobs/:id/download", async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({
      erro: "O ID informado não é um UUID válido.",
    });
  }
  // Verifica se o job existe e se o arquivo convertido está disponível.
  try {
    const result = await pool.query(
      `SELECT id, status, output_key, output_format
       FROM jobs
       WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({
        erro: "Job não encontrado.",
      });
    }
    const job = result.rows[0];
    if (job.status !== "completed" || !job.output_key) {
      return res.status(409).json({
        erro: "O arquivo convertido ainda não está disponível.",
        status: job.status,
      });
    }
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: job.output_key,
      }),
    );
    const contentTypes = {
      mp4: "video/mp4",
      webm: "video/webm",
      mp3: "audio/mpeg",
    };
    res.setHeader(
      "Content-Type",
      contentTypes[job.output_format] || "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(job.output_key)}"`,
    );
    if (object.ContentLength !== undefined) {
      res.setHeader("Content-Length", object.ContentLength);
    }
    try {
      await pipeline(object.Body, res);
    } catch (streamError) {
      console.error(
        "Erro ao transmitir arquivo para download:",
        streamError.message,
      );
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
        res.removeHeader("Content-Length");

        return res.status(500).json({
          erro: "Não foi possível enviar o arquivo.",
        });
      }
      res.destroy(streamError);
    }
  } catch (error) {
    console.error("Erro ao buscar arquivo convertido:", error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        erro: "Não foi possível recuperar o arquivo convertido.",
      });
    }
    res.destroy(error);
  }
});

// Trata erros do Multer, incluindo arquivos acima de 500 MB.
// trata também erros inesperados, retornando 400 Bad Request.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        erro: "O arquivo ultrapassa o limite de 500 MB.",
      });
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({
        erro: "Envie apenas um arquivo por requisição.",
      });
    }
    return res.status(400).json({
      erro: `Falha no upload: ${error.message}`,
    });
  }
  console.error("Erro na requisição:", error.message);
  return res.status(400).json({
    erro: error.message || "Requisição inválida.",
  });
});

// Inicia o servidor e garante que o diretório de uploads exista.
async function start() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });

  // Confirma que o banco está acessível antes de iniciar a API.
  await pool.query("SELECT 1");

  // Confirma que o bucket S3 está acessível antes de iniciar a API.
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API disponível na porta ${PORT}`);
    console.log(`Limite de upload: ${MAX_FILE_SIZE / 1024 / 1024} MB`);
    console.log(`Bucket S3: ${BUCKET}`);
  });
}

start().catch((error) => {
  console.error("Falha ao iniciar a API:", error.message);
  process.exitCode = 1;
});
