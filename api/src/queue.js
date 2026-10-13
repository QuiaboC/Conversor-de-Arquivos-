const amqp = require("amqplib");

const QUEUE_NAME = "video.conversion";
let channelPromise;

async function getChannel() {
    if (!channelPromise) {
        channelPromise = amqp
            .connect(process.env.RABBITMQ_URL)
            .then(async (connection) => {
                connection.on("close", () => {
                    channelPromise = null;
                });

                const channel = await connection.createConfirmChannel();

                await channel.assertQueue(QUEUE_NAME, {
                    durable: true
                });

                return channel;
            })
            .catch((error) => {
                channelPromise = null;
                throw error;
            });
    }

    return channelPromise;
}

async function publishJob(job) {
    const channel = await getChannel();

    return new Promise((resolve, reject) => {
        channel.sendToQueue(
            QUEUE_NAME,
            Buffer.from(JSON.stringify(job)),
            {
                persistent: true,
                contentType: "application/json"
            },
            (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            }
        );
    });
}

module.exports = { publishJob };