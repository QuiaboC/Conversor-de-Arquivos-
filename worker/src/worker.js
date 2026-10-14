const amqp = require("amqplib");
const { Pool } = require("pg");
const sharp = require("sharp");

const {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const nodemailer = require("nodemailer");

const smtpPort = Number(process.env.SMTP_PORT || 587);

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: smtpPort,
  secure: smtpPort === 465,

  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_USER;


async function enviarEmailConclusao(email, jobId, outputFormat) {
  if (!email) {
    console.log(
      `Job ${jobId} sem e-mail cadastrado. Notificação ignorada.`
    );
    return;
  }

  const downloadUrl =
    `http://localhost:3000/jobs/${jobId}/download`;

  console.log(`Tentando enviar e-mail para ${email}...`);

  try {
    const info = await mailer.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject: "Sua conversão foi concluída!",
      text: [
        "Olá!",
        "",
        "Seu arquivo foi convertido com sucesso.",
        `Formato: ${outputFormat}`,
        `ID do job: ${jobId}`,
        "",
        "Você pode baixar o arquivo pelo link:",
        downloadUrl,
      ].join("\n"),
      html: `
        <h2>Conversão concluída!</h2>
        <p>Seu arquivo foi convertido com sucesso.</p>
        <p><strong>Formato:</strong> ${outputFormat}</p>
        <p><strong>ID do job:</strong> ${jobId}</p>
        <p><a href="${downloadUrl}">Baixar arquivo convertido</a></p>
      `,
    });

    console.log("E-mail aceito pelo servidor SMTP:", {
      jobId,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
    });
  } catch (error) {
    console.error(`Falha ao enviar e-mail do job ${jobId}:`, {
      message: error.message,
      code: error.code,
      response: error.response,
      command: error.command,
    });

    throw error;
  }
}


const QUEUE_NAME = "video.conversion";
const BUCKET = process.env.S3_BUCKET || "videos";

const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "conversor",
    password: process.env.DB_PASSWORD || "conversor123",
    database: process.env.DB_NAME || "conversor"
});

const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || "minioadmin",
        secretAccessKey: process.env.S3_SECRET_KEY || "minioadmin123"
    }
});

async function ensureBucket() {
    try {
        await s3.send(
            new HeadBucketCommand({
                Bucket: BUCKET
            })
        );
    } catch (error) {
        if (
            error.name !== "NotFound" &&
            error.name !== "NoSuchBucket" &&
            error.$metadata?.httpStatusCode !== 404
        ) {
            throw error;
        }

        await s3.send(
            new CreateBucketCommand({
                Bucket: BUCKET
            })
        );

        console.log(`Bucket "${BUCKET}" criado.`);
    }
}

function runFFmpeg(inputPath, outputPath, format) {
    const args = ["-y", "-i", inputPath];

    if (format === "mp4") {
        args.push(
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart"
        );
    } else if (format === "webm") {
        args.push(
            "-c:v", "libvpx-vp9",
            "-crf", "32",
            "-b:v", "0",
            "-c:a", "libopus"
        );
    } else if (format === "mp3") {
        args.push(
            "-vn",
            "-codec:a", "libmp3lame",
            "-q:a", "2"
        );
    } else {
        throw new Error("Formato de saída não suportado.");
    }

    args.push(outputPath);

    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", args, {
            stdio: ["ignore", "ignore", "pipe"]
        });

        let errorOutput = "";

        ffmpeg.stderr.on("data", (chunk) => {
            errorOutput += chunk.toString();

            if (errorOutput.length > 12000) {
                errorOutput = errorOutput.slice(-12000);
            }
        });

        ffmpeg.on("error", reject);

        ffmpeg.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(
                    new Error(
                        `FFmpeg encerrou com código ${code}: ${errorOutput.slice(-2000)}`
                    )
                );
            }
        });
    });
}

async function runImageConversion(inputPath, outputPath, format) {
  let image = sharp(inputPath);

  switch (format) {
    case "jpg":
    case "jpeg":
      image = image.jpeg({ quality: 85 });
      break;

    case "png":
      image = image.png({ compressionLevel: 8 });
      break;

    case "webp":
      image = image.webp({ quality: 85 });
      break;

    default:
      throw new Error(`Formato de imagem não suportado: ${format}`);
  }

  await image.toFile(outputPath);
}

async function processJob(id) {

    const result = await pool.query(
        `SELECT id, original_filename, output_format, input_key, status
         FROM jobs
         WHERE id = $1`,
        [id]
    );

    if (result.rowCount === 0) {
        console.log(`Job ${id} não encontrado.`);
        return;
    }

    const job = result.rows[0];

    if (!["queued", "pending"].includes(job.status)) {
        console.log(
            `Job ${id} ignorado: status ${job.status}.`
        );
        return;
    }

    if (!job.input_key) {
        await pool.query(
            `UPDATE jobs
             SET status = 'failed',
                 error_message = $2,
                 updated_at = NOW()
             WHERE id = $1`,
            [
                id,
                "Arquivo original não foi enviado ao armazenamento."
            ]
        );

        console.log(
            `Job ${id} falhou: arquivo original ausente.`
        );

        return;
    }

    const claimed = await pool.query(
        `UPDATE jobs
         SET status = 'processing',
             error_message = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('queued', 'pending')
         RETURNING id`,
        [id]
    );

    if (claimed.rowCount === 0) {
        return;
    }

    const workDir = await fs.mkdtemp(
        path.join("/tmp", "conversion-")
    );

    const inputPath = path.join(workDir, "input");
    const outputPath = path.join(
        workDir,
        `output.${job.output_format}`
    );

    try {
        console.log(`Processando job ${id}...`);

        const download = await s3.send(
            new GetObjectCommand({
                Bucket: BUCKET,
                Key: job.input_key
            })
        );

        await pipeline(
            download.Body,
            createWriteStream(inputPath)
        );

        const imageFormats = ["jpg", "jpeg", "png", "webp"];

        if (imageFormats.includes(job.output_format)) {
        await runImageConversion(
            inputPath,
            outputPath,
            job.output_format
        );
        } else {
        await runFFmpeg(
            inputPath,
            outputPath,
            job.output_format
        );
        }

        const contentTypes = {
        mp4: "video/mp4",
        webm: "video/webm",
        mp3: "audio/mpeg",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp"
        };

        const outputKey =
            `outputs/${id}.${job.output_format}`;

        // Lê o arquivo convertido como Buffer.
        const outputBuffer = await fs.readFile(outputPath);

        // Envia o resultado para o armazenamento S3.
        await s3.send(
            new PutObjectCommand({
                Bucket: BUCKET,
                Key: outputKey,
                Body: outputBuffer,
                ContentType: contentTypes[job.output_format]
            })
        );

        // O arquivo convertido já foi salvo no S3.
// Agora podemos tentar remover o arquivo original.
try {
    await s3.send(
        new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: job.input_key
        })
    );

    console.log(`Arquivo original do job ${id} removido do S3.`);
} catch (deleteError) {
    console.error(
        `Não foi possível remover o arquivo original do job ${id}:`,
        deleteError.message
    );
}

        await pool.query(
            `UPDATE jobs
             SET status = 'completed',
                 output_key = $2,
                 error_message = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [id, outputKey]
        );

        // Busca o e-mail cadastrado para o job.
const emailResult = await pool.query(
    "SELECT email FROM jobs WHERE id = $1",
    [id]
);

const email = emailResult.rows[0]?.email;

// Envia a notificação sem interromper a conversão
// caso o serviço de e-mail esteja indisponível.
try {
    await enviarEmailConclusao(
        email,
        id,
        job.output_format
    );
} catch (emailError) {
    console.error(
        `Job ${id} concluído, mas o e-mail não foi enviado:`,
        emailError.message
    );
}

        console.log(
            `Job ${id} concluído: ${outputKey}`
        );
    } catch (error) {
        console.error(
            `Falha no job ${id}:`,
            error.message
        );

        await pool.query(
            `UPDATE jobs
             SET status = 'failed',
                 error_message = $2,
                 updated_at = NOW()
             WHERE id = $1`,
            [id, error.message.slice(0, 2000)]
        );
    } finally {
        await fs.rm(workDir, {
            recursive: true,
            force: true
        });
    }
}

async function main() {
    await pool.query("SELECT 1");
    await ensureBucket();

    const connection = await amqp.connect(
        process.env.RABBITMQ_URL ||
        "amqp://conversor:conversor123@localhost:5672"
    );

    const channel = await connection.createConfirmChannel();

    await channel.assertQueue(`${QUEUE_NAME}.dlq`, {
    durable: true
    });

    await channel.assertQueue(QUEUE_NAME, {
    durable: true
    });

    await channel.prefetch(1);

    console.log(
        `Worker aguardando mensagens em "${QUEUE_NAME}"...`
    );

    await channel.consume(
        QUEUE_NAME,
        async (message) => {
            if (!message) return;

            try {
                const payload = JSON.parse(
                    message.content.toString()
                );

                if (
                    !payload.id ||
                    typeof payload.id !== "string"
                ) {
                    channel.ack(message);
                    return;
                }

                await processJob(payload.id);

                channel.ack(message);
            } catch (error) {
                console.error(
                    "Erro ao processar mensagem:",
                    error.message
                );

                const headers = message.properties.headers || {};
                const retryCount = Number(
                    headers["x-retry-count"] || 0
                );

                const destination =
                    retryCount < 2
                        ? QUEUE_NAME
                        : `${QUEUE_NAME}.dlq`;

                const nextHeaders = {
                    ...headers
                };

                if (destination === QUEUE_NAME) {
                    nextHeaders["x-retry-count"] = retryCount + 1;
                }

                channel.sendToQueue(
                    destination,
                    message.content,
                    {
                        persistent: true,
                        contentType: "application/json",
                        headers: nextHeaders
                    }
                );

                // Espera a confirmação da publicação antes
                // de confirmar a mensagem original.
                await channel.waitForConfirms();

                channel.ack(message);

                if (destination === `${QUEUE_NAME}.dlq`) {
                    console.error(
                        `Mensagem encaminhada para a DLQ após ${retryCount + 1} tentativas.`
                    );
                } else {
                    console.log(
                        `Mensagem reenfileirada para tentativa ${retryCount + 2}.`
                    );
                }
            }
        }
    );
}

if (require.main === module) {
    main().catch((error) => {
        console.error("Falha ao iniciar o worker:", error);
        process.exitCode = 1;
    });
}

module.exports = {
    main,
    processJob,
    runFFmpeg,
    runImageConversion,
    enviarEmailConclusao
};