
const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire');

function criarPublisher({ erroConfirmacao = null } = {}) {
  const chamadas = {
    fila: null,
    mensagem: null,
    opcoes: null,
    filaConfiguracao: null,
  };

  const channel = {
    assertQueue: async (nome, configuracao) => {
      chamadas.fila = nome;
      chamadas.filaConfiguracao = configuracao;
    },

    sendToQueue: (fila, mensagem, opcoes, callback) => {
      chamadas.fila = fila;
      chamadas.mensagem = mensagem;
      chamadas.opcoes = opcoes;

      callback(erroConfirmacao);
    },
  };

  const connection = {
    on() {},

    createConfirmChannel: async () => channel,
  };

  const amqpFake = {
    connect: async () => connection,
  };

  const { publishJob } = proxyquire('../api/src/queue.js', {
    amqplib: amqpFake,
  });

  return { publishJob, chamadas };
}

test('Publisher: publica na fila correta', async () => {
  const { publishJob, chamadas } = criarPublisher();

  await publishJob({
    jobId: 'job-teste-1',
    targetFormat: 'webp',
  });

  assert.equal(chamadas.fila, 'video.conversion');
});

test('Publisher: publica mensagem JSON persistente', async () => {
  const { publishJob, chamadas } = criarPublisher();

  const job = {
    jobId: 'job-teste-2',
    targetFormat: 'webp',
  };

  await publishJob(job);

  assert.deepEqual(
    JSON.parse(chamadas.mensagem.toString()),
    job
  );

  assert.equal(chamadas.opcoes.persistent, true);
  assert.equal(chamadas.opcoes.contentType, 'application/json');
});

test('Publisher: declara a fila como durável', async () => {
  const { publishJob, chamadas } = criarPublisher();

  await publishJob({
    jobId: 'job-teste-3',
    targetFormat: 'mp4',
  });

  assert.equal(chamadas.fila, 'video.conversion');
  assert.equal(chamadas.filaConfiguracao.durable, true);
});

test('Publisher: rejeita a Promise se o RabbitMQ confirmar erro', async () => {
  const erro = new Error('Falha simulada na publicação');
  const { publishJob } = criarPublisher({
    erroConfirmacao: erro,
  });

  await assert.rejects(
    publishJob({
      jobId: 'job-teste-4',
      targetFormat: 'mp3',
    }),
    /Falha simulada na publicação/
  );
});