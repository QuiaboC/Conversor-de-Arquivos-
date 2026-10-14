# MediaConvert — Conversor Escalável de Vídeo, Áudio e Imagem

Sistema distribuído de conversão de mídia com **processamento assíncrono**. O usuário envia um arquivo por uma interface web, escolhe o formato de destino e recebe imediatamente um `jobId`. A conversão acontece em segundo plano, por workers independentes que consomem uma fila **RabbitMQ**, e o resultado é guardado em um object storage compatível com S3 (**MinIO/Silo**). Ao final, o usuário é notificado por e-mail.

> Projeto prático de Sistemas Distribuídos / Troca de Mensagens.

---

## Sumário

- [Arquitetura](#arquitetura)
- [Stack utilizada](#stack-utilizada)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Como executar](#como-executar)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Serviços e portas](#serviços-e-portas)
- [Escalando os workers](#escalando-os-workers)
- [API HTTP](#api-http)
- [Formatos suportados](#formatos-suportados)
- [Fluxo de execução](#fluxo-de-execução)
- [Garantias de entrega, retentativas e DLQ](#garantias-de-entrega-retentativas-e-dlq)
- [Ciclo de vida dos arquivos no storage](#ciclo-de-vida-dos-arquivos-no-storage)
- [Modelo de dados](#modelo-de-dados)
- [Testes](#testes)
- [Limitações conhecidas](#limitações-conhecidas)
- [Próximos passos](#próximos-passos)

---

## Arquitetura

```
┌───────────────┐   HTTP    ┌────────────────────┐
│   Frontend    │ ────────► │   API de Ingestão  │
│ (upload +     │ ◄─ jobId ─│     (Producer)     │
│  status)      │           └───┬────────┬───┬───┘
└───────────────┘               │        │   │
                (1) PUT origem  │        │   │ (3) INSERT/UPDATE job
                                ▼        │   ▼
                         ┌────────────┐  │  ┌────────────┐
                         │   MinIO    │  │  │ PostgreSQL │
                         │  (Silo)    │  │  │  (jobs)    │
                         └─────▲──────┘  │  └─────▲──────┘
                               │         │        │
                               │   (2) publica    │ status
                               │      {id,...}    │
                               │         ▼        │
                               │  ┌──────────────┐│
                               │  │   RabbitMQ   ││
                               │  │ video.       ││
                               │  │ conversion   ││
                               │  └──────┬───────┘│
                               │         │ (4) consome
                               │         ▼        │
                               │  ┌──────────────────────┐
                               └──┤  Worker 1 .. Worker N│
          (5) GET origem          │  FFmpeg  +  Sharp    │
          (6) PUT resultado       └──────────┬───────────┘
          (7) DELETE origem                  │ (8) e-mail com link
                                             ▼
                                      ┌─────────────┐
                                      │ SMTP/Mailpit│
                                      └─────────────┘
```

Princípios adotados:

- **Desacoplamento:** a API e os workers não se conhecem. A única interface entre eles é a mensagem na fila (e o estado do job no banco).
- **Payload enxuto:** a mensagem carrega apenas metadados. O binário **nunca** trafega pela fila; ele fica no MinIO.
- **Escalabilidade horizontal:** vários workers competem pela mesma fila (*competing consumers*) e o RabbitMQ distribui o trabalho.
- **Tolerância a falhas:** o `ack` só é enviado depois do processamento; se um worker morrer no meio, a mensagem volta para a fila.

---

## Stack utilizada

| Componente | Tecnologia |
|---|---|
| Frontend | HTML + CSS + JavaScript puro (servido pela própria API) |
| API de ingestão | Node.js 20, Express 5, Multer |
| Broker de mensagens | RabbitMQ 4 (com painel de gerenciamento) |
| Object storage | MinIO (imagem `pgsty/silo`, fork compatível com S3) via `@aws-sdk/client-s3` |
| Conversão de vídeo/áudio | FFmpeg |
| Conversão de imagem | Sharp |
| Estado dos jobs | PostgreSQL 16 |
| E-mail | Nodemailer (SMTP real ou Mailpit local) |
| Orquestração | Docker Compose |
| Testes | `node:test` + `proxyquire` |

---

## Estrutura do repositório

```
.
├── api/
│   └── src/
│       ├── server.js          # API Express: upload, status e download
│       ├── queue.js           # Publisher RabbitMQ (confirm channel)
│       ├── db.js              # Pool do PostgreSQL
│       ├── Dockerfile
│       └── public/            # Frontend (index.html, script.js, style.css)
├── worker/
│   └── src/
│       ├── worker.js          # Consumer: conversão, retentativas, DLQ, e-mail
│       └── Dockerfile         # Inclui FFmpeg
├── infra/
│   └── postgres/init.sql      # Criação da tabela jobs
├── test/                      # Testes do publisher e do consumer
├── docker-compose.yml
├── .env_template              # Modelo das variáveis de SMTP
└── package.json
```

---

## Como executar

### Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) e Docker Compose v2

### Passo a passo

1. **Clone o repositório**

   ```bash
   git clone https://github.com/QuiaboC/Conversor-de-Arquivos-.git
   cd Conversor-de-Arquivos-
   ```

2. **Crie o arquivo `.env`** a partir do modelo

   ```bash
   cp .env_template .env
   ```

   Edite o `.env` conforme a opção de e-mail escolhida (veja [Variáveis de ambiente](#variáveis-de-ambiente)).

   **Opção A — Mailpit (recomendado para testes, não envia e-mails reais):**

   ```env
   SMTP_HOST=mailpit
   SMTP_PORT=1025
   SMTP_USER=
   SMTP_PASS=
   EMAIL_FROM=conversor@exemplo.com
   ```

   **Opção B — Gmail (SMTP real):**

   ```env
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=seuemail@gmail.com
   SMTP_PASS=SUA_SENHA_DE_APP
   EMAIL_FROM=seuemail@gmail.com
   ```

   > Para o Gmail é necessário gerar uma **senha de app** (verificação em duas etapas ativada). Nunca versione o `.env`.

3. **Suba todo o ambiente com um único comando**

   ```bash
   docker compose up --build
   ```

4. **Acesse a aplicação** em <http://localhost:3000>.

Para encerrar: `docker compose down` (use `docker compose down -v` para apagar também os volumes do banco e do storage).

### Bucket do storage

Não é necessário criar o bucket manualmente: o worker executa `ensureBucket()` na inicialização e cria o bucket `videos` caso ele não exista. Caso queira conferir ou inspecionar os objetos, use o console em <http://localhost:9001> (usuário `minioadmin`, senha `minioadmin123`).

---

## Variáveis de ambiente

As variáveis abaixo já estão definidas no `docker-compose.yml`. Só as de SMTP precisam vir do `.env`.

| Variável | Usada por | Padrão | Descrição |
|---|---|---|---|
| `PORT` | API | `3000` | Porta HTTP da API |
| `DB_HOST` / `DB_PORT` | API, Worker | `postgres` / `5432` | Endereço do PostgreSQL |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | API, Worker | `conversor` / `conversor123` / `conversor` | Credenciais do banco |
| `RABBITMQ_URL` | API, Worker | `amqp://conversor:conversor123@rabbitmq:5672` | URL do broker |
| `S3_ENDPOINT` | API, Worker | `http://minio:9000` | Endpoint S3 do MinIO |
| `S3_BUCKET` | API, Worker | `videos` | Bucket de armazenamento |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | API, Worker | `minioadmin` / `minioadmin123` | Credenciais do storage |
| `SMTP_HOST` / `SMTP_PORT` | Worker | — (do `.env`) | Servidor SMTP |
| `SMTP_USER` / `SMTP_PASS` | Worker | — (do `.env`) | Credenciais SMTP |
| `EMAIL_FROM` | Worker | `SMTP_USER` | Remetente dos e-mails |

> ⚠️ As credenciais do compose são **apenas para desenvolvimento**. Troque-as antes de qualquer uso fora do ambiente local.

---

## Serviços e portas

| Serviço | URL / Porta | Descrição |
|---|---|---|
| Aplicação (frontend + API) | <http://localhost:3000> | Interface de upload e API HTTP |
| RabbitMQ — painel | <http://localhost:15672> | Login `conversor` / `conversor123` |
| RabbitMQ — AMQP | `5672` | Conexão dos clientes |
| MinIO — console | <http://localhost:9001> | Login `minioadmin` / `minioadmin123` |
| MinIO — API S3 | `9000` | Endpoint S3 |
| Mailpit — webmail | <http://localhost:8025> | Caixa de entrada de teste |
| Mailpit — SMTP | `1025` | Servidor SMTP de teste |
| PostgreSQL | `5432` | Banco de estado dos jobs |

---

## Escalando os workers

O serviço `worker` não possui `container_name` fixo nem porta publicada, então pode ser replicado livremente. Cada instância usa `prefetch(1)`: recebe uma mensagem por vez, o que distribui a carga de forma justa entre os workers.

```bash
# Sobe com 3 workers
docker compose up --build --scale worker=3

# Ou altera o número de workers com o ambiente já no ar
docker compose up -d --scale worker=5
```

Para acompanhar os logs dos workers:

```bash
docker compose logs -f worker
```

Para evitar conversão duplicada, o worker faz uma "reivindicação" atômica do job no banco (`UPDATE ... WHERE status IN ('queued','pending')`). Se outra instância já assumiu o job, a segunda simplesmente ignora a mensagem.

---

## API HTTP

### `POST /jobs` — cria um pedido de conversão

`multipart/form-data` com os campos:

| Campo | Tipo | Descrição |
|---|---|---|
| `file` | arquivo | Arquivo de origem (máx. 500 MB, um por requisição) |
| `output_format` | texto | `mp4`, `webm`, `mp3`, `jpg`, `jpeg`, `png` ou `webp` |
| `email` | texto | E-mail que receberá a notificação |

```bash
curl -X POST http://localhost:3000/jobs \
  -F "file=@video.mov" \
  -F "output_format=mp4" \
  -F "email=voce@exemplo.com"
```

Resposta `201 Created` (o arquivo já está no storage e a mensagem na fila; a conversão ainda não ocorreu):

```json
{
  "mensagem": "Vídeo recebido e job enviado para a fila.",
  "job": {
    "id": "9f2c1a84-3b77-4e5a-9d21-6c0a8f4b1e30",
    "original_filename": "video.mov",
    "output_format": "mp4",
    "status": "queued",
    "input_key": "inputs/9f2c1a84-.../video.mov",
    "output_key": null,
    "error_message": null,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

Erros: `400` (arquivo/e-mail/formato inválido), `413` (acima de 500 MB), `503` (falha ao publicar na fila; o job é marcado como `failed`), `500` (erro interno).

### `GET /jobs/:id` — consulta o status

Retorna o job com o status atual. `404` se não existir e `400` se o ID não for um UUID válido.

### `GET /jobs/:id/download` — baixa o arquivo convertido

Faz o stream do objeto do storage com o `Content-Type` correto. Responde `409` se o job ainda não estiver `completed`.

### `GET /health/db` — verifica a conexão com o PostgreSQL

### Status possíveis de um job

| Status | Significado |
|---|---|
| `pending` | Registro criado, ainda não enfileirado |
| `queued` | Mensagem publicada no RabbitMQ |
| `processing` | Um worker assumiu o job |
| `completed` | Conversão concluída; resultado disponível |
| `failed` | Falha definitiva (a mensagem de erro fica em `error_message`) |

---

## Formatos suportados

A interface lista os formatos de saída conforme o tipo do arquivo escolhido:

| Tipo de entrada | Formatos de saída | Motor |
|---|---|---|
| Vídeo | MP4 (H.264/AAC), WebM (VP9/Opus), MP3 (extração de áudio) | FFmpeg |
| Áudio | MP3 | FFmpeg |
| Imagem | JPG, JPEG, PNG, WebP | Sharp |

---

## Fluxo de execução

1. O usuário seleciona o arquivo, o formato de destino e informa o e-mail.
2. A API valida os dados e grava o arquivo original no MinIO (`inputs/<jobId>/<nome>`).
3. A API cria o registro do job (`pending`) e o marca como `queued` **antes** de publicar, para que o worker nunca tenha seu status sobrescrito pela API.
4. A API publica a mensagem (com *publisher confirms*) na fila durável `video.conversion` e responde com o `jobId`, sem esperar a conversão.
5. Um worker recebe a mensagem, assume o job (`processing`), baixa a origem, converte em um diretório temporário e envia o resultado para `outputs/<jobId>.<formato>`.
6. Com o resultado gravado, o worker remove o arquivo de origem, marca o job como `completed` e envia o e-mail com o link de download.
7. Só então a mensagem recebe `ack`.
8. O frontend consulta `GET /jobs/:id` e libera o botão de download quando o status é `completed`.

### Contrato da mensagem

A mensagem publicada na fila contém apenas metadados do job. Os demais dados (chave do arquivo, e-mail etc.) são lidos do banco pelo worker a partir do `id`:

```json
{
  "id": "9f2c1a84-3b77-4e5a-9d21-6c0a8f4b1e30",
  "original_filename": "video.mov",
  "output_format": "mp4"
}
```

Propriedades: `persistent: true` e `contentType: application/json`. O conteúdo binário nunca é enviado pela fila.

---

## Garantias de entrega, retentativas e DLQ

- **Fila durável + mensagens persistentes:** sobrevivem a reinício do broker.
- **Publisher confirms:** a API só considera a mensagem publicada após a confirmação do RabbitMQ; se falhar, o job vira `failed` e o cliente recebe `503`.
- **Ack manual:** o worker só confirma a mensagem depois de `processJob` terminar. Se o worker morrer no meio da conversão, o RabbitMQ devolve a mensagem para a fila e outro worker a processa.
- **Retentativas:** em caso de erro ao processar a mensagem, ela é republicada na própria fila com o header `x-retry-count`, até **3 tentativas no total**.
- **Dead Letter Queue:** após esgotar as tentativas, a mensagem é enviada para `video.conversion.dlq`. A republicação é confirmada (`waitForConfirms`) antes do `ack` da mensagem original, evitando perda.
- **Idempotência:** o `jobId` é a chave. O worker só processa jobs em `queued`/`pending`; uma mensagem duplicada para um job já `processing`, `completed` ou `failed` é ignorada, e o e-mail só é disparado uma vez, ao final de um processamento bem-sucedido.

---

## Ciclo de vida dos arquivos no storage

| Etapa | Local | Observação |
|---|---|---|
| Upload | `videos/inputs/<jobId>/<arquivo>` | Gravado pela API |
| Resultado | `videos/outputs/<jobId>.<formato>` | Gravado pelo worker |
| Limpeza | — | A origem é removida **somente depois** de o resultado ser gravado |
| Falha | `videos/inputs/...` | Se a API não conseguir criar o job, o objeto órfão é removido; falhas de conversão marcam o job como `failed` |

---

## Modelo de dados

Tabela `jobs` (criada automaticamente por `infra/postgres/init.sql`):

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | `UUID` (PK) | `jobId` |
| `original_filename` | `VARCHAR(255)` | Nome original do arquivo |
| `output_format` | `VARCHAR(20)` | Formato de destino |
| `status` | `VARCHAR(30)` | `pending`, `queued`, `processing`, `completed`, `failed` |
| `input_key` | `TEXT` | Chave do objeto de origem |
| `output_key` | `TEXT` | Chave do objeto convertido |
| `error_message` | `TEXT` | Mensagem de falha |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | Datas de criação e atualização |

> O e-mail é gravado na coluna `email`, usada pela API e pelo worker. Como o `init.sql` do repositório não a declara, veja a seção [Limitações conhecidas](#limitações-conhecidas).

---

## Testes

Os testes usam o runner nativo do Node (`node:test`) e cobrem o publisher (`queue.js`), o consumer (`worker.js`) e o contrato da mensagem.

```bash
npm install
node --test test/
```

---

## Limitações conhecidas

Pontos em que a implementação atual ainda difere do enunciado ou merece atenção:

- **Coluna `email`:** a API e o worker usam `jobs.email`, mas o `infra/postgres/init.sql` não cria essa coluna. Adicione `email VARCHAR(255)` ao `CREATE TABLE` para um `docker compose up` limpo funcionar de ponta a ponta.
- **Configuração de SMTP:** o worker lê o SMTP do `.env`. Sem o `.env`, o envio de e-mail falha (o job ainda conclui). Para usar o Mailpit, defina `SMTP_HOST=mailpit` e `SMTP_PORT=1025`.
- **Link do e-mail:** o link enviado aponta para `http://localhost:3000/jobs/<id>/download` (download proxy pela API), não para uma URL pública/pré-assinada do MinIO, e só funciona na máquina local.
- **Bucket único:** origem e resultado ficam no mesmo bucket (`videos`), separados por prefixo (`inputs/` e `outputs/`), em vez de buckets `uploads` e `converted`.
- **Notificação acoplada ao worker:** o e-mail é enviado pelo próprio worker, não por um consumidor dedicado de eventos de conclusão.
- **Contrato da mensagem enxuto:** a mensagem leva só `id`, nome e formato; o campo de tentativa fica no header `x-retry-count`.
- **Retentativas:** erros de conversão tratados dentro de `processJob` marcam o job como `failed` e confirmam a mensagem, sem passar pela rota de retentativa/DLQ; a DLQ cobre falhas fora desse tratamento (ex.: indisponibilidade do banco).
- **Worker morto no meio do job:** o job fica em `processing` e uma nova entrega da mesma mensagem é ignorada pela regra de idempotência. Um *timeout/heartbeat* de job resolveria isso.
- **Sem WebSocket/SSE:** o acompanhamento do status é feito por polling.
- **Credenciais padrão** e portas expostas (PostgreSQL, RabbitMQ) são adequadas apenas para ambiente de desenvolvimento.
- O `npm test` do `package.json` ainda é um placeholder; use `node --test test/`.

---

## Próximos passos

- Corrigir o `init.sql` (coluna `email`) e separar os buckets `uploads` / `converted`.
- Gerar URL pré-assinada do MinIO (ou política de leitura pública) para o link do e-mail.
- Extrair a notificação para um serviço consumidor de eventos de conclusão.
- Adicionar suporte a mais formatos (por exemplo MP4 → AVI, WAV → MP3).
- Progresso em tempo real via SSE/WebSocket, priorização de fila por tipo de mídia e métricas de observabilidade.
- Lifecycle do MinIO para expirar objetos convertidos automaticamente.
- Medir e documentar o ganho de throughput com 1 vs. N workers.

---

## Autores

Projeto desenvolvido por [QuiaboC](https://github.com/QuiaboC).
