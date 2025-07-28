// backend/scripts/init-wallets.ts
import { Keypair } from '@solana/web3.js';
import { promises as fs } from 'fs';
import { scrypt, createCipheriv, randomBytes } from 'crypto';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

async function main() {
    const argv = await yargs(hideBin(process.argv))
        .option('count', {
            alias: 'c',
            type: 'number',
            description: 'Number of wallets to generate',
            demandOption: true,
        })
        .option('encryption-key', {
            alias: 'k',
            type: 'string',
            description: 'The master encryption key from your .env file',
            demandOption: true,
        })
        .option('output', {
            alias: 'o',
            type: 'string',
            description: 'Output file path',
            default: '../wallets.json', // Default to the project root
        })
        .help()
        .argv;

    const { encryptionKey, count, output } = argv;

    console.log(`Generating ${count} new wallets...`);

    const wallets = [];
    for (let i = 0; i < count; i++) {
        const keypair = Keypair.generate();
        wallets.push({
            publicKey: keypair.publicKey.toBase58(),
            secretKey: Buffer.from(keypair.secretKey).toString('base64'),
        });
    }

    const walletData = { wallets };
    const plainText = JSON.stringify(walletData);

    const iv = randomBytes(16);
    const salt = randomBytes(16);

    const key = await new Promise<Buffer>((resolve, reject) => {
        scrypt(encryptionKey, salt, 32, (err, derivedKey) => {
            if (err) reject(err);
            resolve(derivedKey);
        });
    });

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let encryptedContent = cipher.update(plainText, 'utf8', 'hex');
    encryptedContent += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    const encryptedFile = {
        iv: iv.toString('hex'),
        salt: salt.toString('hex'),
        authTag: authTag.toString('hex'),
        content: encryptedContent,
    };

    await fs.writeFile(output, JSON.stringify(encryptedFile, null, 4));
    console.log(`Successfully created and encrypted wallets in ${output}`);
}

main().catch(console.error);