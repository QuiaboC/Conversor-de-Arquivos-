
const { test } = require("node:test");
const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

function criarDependencias({ erroNoBanco = false } = {}) {
    const chamadas = {
        ack: [],
        filas: [],
        prefetch: [],
        consultas: [],
        mensagens: [],
        confirms: 0,
        consume: null
    };

    const channel = {
        assertQueue: async (fila, opcoes) => {
            chamadas.filas.push({ fila, opcoes });
        },

        prefetch: async (quantidade) => {
            chamadas.prefetch.push(quantidade);
        },

        consume: async (fila, callback) => {
            chamadas.consume = { fila, callback };
        },

        ack: (mensagem) => chamadas.ack.push(mensagem),

        sendToQueue: (fila, conteudo, opcoes) => {
            chamadas.mensagens.push({
                fila,
                conteudo: conteudo.toString(),
                opcoes
            });
        },

        waitForConfirms: async () => {
            chamadas.confirms++;

            if (erroNoBanco) {
                // A falha do banco é simulada separadamente abaixo.
            }
        }
    };

    const connection = {
        createConfirmChannel: async () => channel
    };

    const amqp = {
        connect: async () => connection
    };

    
const pool = {
    query: async (...args) => {
        chamadas.consultas.push(args);

        if (erroNoBanco) {
            throw new Error("Falha simulada no banco");
        }

        // Simula um job que não existe no banco.
        if (args[0].includes("SELECT id, original_filename")) {
            return {
                rowCount: 0,
                rows: []
            };
        }

        return {
            rowCount: 0,
            rows: []
        };
    }
};


    class S3Client {
        async send() {
            return {};
        }
    }

    class S3Command {
        constructor(input) {
            this.input = input;
        }
    }

    const sharp = () => ({
        jpeg() { return this; },
        png() { return this; },
        webp() { return this; },
        toFile: async () => {}
    });

    const nodemailer = {
        createTransport: () => ({
            sendMail: async () => ({
                messageId: "email-teste",
                accepted: [],
                rejected: []
            })
        })
    };

    const worker = proxyquire("../worker/src/worker.js", {
        amqplib: amqp,
        pg: {
            Pool: function () {
                return pool;
            }
        },
        sharp,
        "@aws-sdk/client-s3": {
            S3Client,
            HeadBucketCommand: S3Command,
            CreateBucketCommand: S3Command,
            GetObjectCommand: S3Command,
            PutObjectCommand: S3Command,
            DeleteObjectCommand: S3Command
        },
        nodemailer,
        "node:child_process": {
            spawn: () => {
                throw new Error("FFmpeg não deveria ser chamado neste teste");
            }
        },
        "node:fs/promises": {
            mkdtemp: async () => "/tmp/test-worker",
            rm: async () => {},
            readFile: async () => Buffer.from("resultado")
        },
        "node:fs": {
            createWriteStream: () => ({})
        },
        "node:stream/promises": {
            pipeline: async () => {}
        }
    });

    return { worker, chamadas };
}

async function iniciarConsumer(dependencias) {
    await dependencias.worker.main();

    assert.ok(dependencias.chamadas.consume);

    return dependencias.chamadas.consume.callback;
}

function criarMensagem(payload, headers = {}) {
    return {
        content: Buffer.from(JSON.stringify(payload)),
        properties: { headers }
    };
}

test("Consumer: declara a fila DLQ durável", async () => {
    const deps = criarDependencias();
    await iniciarConsumer(deps);

    assert.ok(
        deps.chamadas.filas.some(
            ({ fila, opcoes }) =>
                fila === "video.conversion.dlq" &&
                opcoes.durable === true
        )
    );
});

test("Consumer: configura prefetch igual a 1", async () => {
    const deps = criarDependencias();
    await iniciarConsumer(deps);

    assert.deepEqual(deps.chamadas.prefetch, [1]);
});

test("Consumer: consome a fila correta", async () => {
    const deps = criarDependencias();
    await iniciarConsumer(deps);

    assert.equal(
        deps.chamadas.consume.fila,
        "video.conversion"
    );
});

test("Consumer: confirma mensagem sem id", async () => {
    const deps = criarDependencias();
    const callback = await iniciarConsumer(deps);
    const message = criarMensagem({ targetFormat: "webp" });

    await callback(message);

    assert.deepEqual(deps.chamadas.ack, [message]);
    assert.equal(deps.chamadas.mensagens.length, 0);
});

test("Consumer: envia para retry quando o processamento lança erro", async () => {
    const deps = criarDependencias({ erroNoBanco: true });
    const callback = await iniciarConsumer(deps);
    const message = criarMensagem({ id: "job-teste" });

    await callback(message);

    assert.equal(deps.chamadas.mensagens.length, 1);
    assert.equal(
        deps.chamadas.mensagens[0].fila,
        "video.conversion"
    );
    assert.equal(
        deps.chamadas.mensagens[0].opcoes.headers["x-retry-count"],
        1
    );
    assert.deepEqual(deps.chamadas.ack, [message]);
    assert.equal(deps.chamadas.confirms, 1);
});

test("Consumer: encaminha para DLQ após duas retentativas anteriores", async () => {
    const deps = criarDependencias({ erroNoBanco: true });
    const callback = await iniciarConsumer(deps);

    const message = criarMensagem(
        { id: "job-teste" },
        { "x-retry-count": 2 }
    );

    await callback(message);

    assert.equal(deps.chamadas.mensagens.length, 1);
    assert.equal(
        deps.chamadas.mensagens[0].fila,
        "video.conversion.dlq"
    );
    assert.deepEqual(deps.chamadas.ack, [message]);
    assert.equal(deps.chamadas.confirms, 1);
});

test("Consumer: preserva os headers existentes durante retry", async () => {
    const deps = criarDependencias({ erroNoBanco: true });
    const callback = await iniciarConsumer(deps);

    const message = criarMensagem(
        { id: "job-teste" },
        {
            "x-retry-count": 0,
            "origem-teste": "automacao"
        }
    );

    await callback(message);

    const headers = deps.chamadas.mensagens[0].opcoes.headers;

    assert.equal(headers["x-retry-count"], 1);
    assert.equal(headers["origem-teste"], "automacao");
});