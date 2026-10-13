
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Testa o contrato da mensagem que o consumer recebe.
function validarMensagem(message) {
  assert.ok(message, 'A mensagem é obrigatória');

  assert.ok(
    typeof message.jobId === 'string' && message.jobId.length > 0,
    'A mensagem deve possuir jobId válido'
  );

  assert.ok(
    typeof message.targetFormat === 'string' &&
      message.targetFormat.length > 0,
    'A mensagem deve possuir formato de destino'
  );

  assert.equal(
    Object.hasOwn(message, 'fileBuffer'),
    false,
    'A mensagem não deve transportar fileBuffer'
  );

  assert.equal(
    Object.hasOwn(message, 'buffer'),
    false,
    'A mensagem não deve transportar buffer'
  );

  assert.equal(
    Object.hasOwn(message, 'fileContent'),
    false,
    'A mensagem não deve transportar conteúdo binário'
  );
}

test('Consumer: aceita mensagem com metadados válidos', () => {
  assert.doesNotThrow(() => {
    validarMensagem({
      jobId: 'job-teste-001',
      targetFormat: 'webp',
    });
  });
});

test('Consumer: rejeita mensagem sem jobId', () => {
  assert.throws(
    () => validarMensagem({ targetFormat: 'webp' }),
    /jobId válido/
  );
});

test('Consumer: rejeita mensagem sem formato de destino', () => {
  assert.throws(
    () => validarMensagem({ jobId: 'job-teste-002' }),
    /formato de destino/
  );
});

test('Consumer: rejeita mensagem nula', () => {
  assert.throws(
    () => validarMensagem(null),
    /mensagem é obrigatória/
  );
});

test('Consumer: não aceita mensagem contendo buffer do arquivo', () => {
  assert.throws(
    () =>
      validarMensagem({
        jobId: 'job-teste-003',
        targetFormat: 'webp',
        buffer: Buffer.from('arquivo'),
      }),
    /não deve transportar buffer/
  );
});

test('Consumer: permite metadados sem conteúdo binário', () => {
  const message = {
    jobId: 'job-teste-004',
    targetFormat: 'mp4',
    inputKey: 'inputs/job-teste-004/video.mov',
  };

  assert.doesNotThrow(() => validarMensagem(message));
  assert.equal(message.jobId, 'job-teste-004');
});
