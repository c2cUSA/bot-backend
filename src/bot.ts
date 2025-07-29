// backend/src/bot.ts

import { config } from 'dotenv';
import { createSlice, PayloadAction, configureStore } from '@reduxjs/toolkit';
import { promises as fs } from 'fs';
import { Keypair, PublicKey, Connection, ComputeBudgetProgram, Transaction, LAMPORTS_PER_SOL, SystemProgram, Signer } from '@solana/web3.js';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { LedgerWalletAdapter } from '@solana/wallet-adapter-ledger';
import { MintLayout } from '@solana/spl-token';
import { WalletData, isWalletData } from './types/wallet';
import logger from './logger';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import {
    Liquidity,
    Token,
    TokenAmount,
    Percent,
    TOKEN_PROGRAM_ID,
    SPL_ACCOUNT_LAYOUT,
    TokenAccount,
    buildTransaction,
    TxVersion,
    LiquidityPoolKeys,
    MAINNET_PROGRAM_ID,
    DEVNET_PROGRAM_ID,
} from '@raydium-io/raydium-sdk';
import { tradeCount, errorCount, healthGauge, metricsRouter } from './metrics';
import { validateConfig } from './config-check';
let ipcRenderer: any;
config();
const rateLimiter = new RateLimiterMemory({
    points: 50,
    duration: 5 * 60,
});

class CircuitBreaker {
    static async check(): Promise<void> {
        const state = store.getState().bot;

        const recentLosses = state.logs.filter(l =>
            l.message.includes('failed') &&
            Date.now() - l.timestamp < 300_000
        ).length;
        if (recentLosses >= 3) throw new Error("Circuit breaker: 3+ recent failures");

        const priceChanges = state.priceHistory.slice(-10);
        const maxChange = priceChanges.length > 1 ? Math.max(...priceChanges.map(p => p.price)) / Math.min(...priceChanges.map(p => p.price)) : 1;
        if (maxChange > 1.15) throw new Error("Circuit breaker: 15% price swing detected");
    }
}

const HEALTH_CHECK_INTERVAL = 30 * 60 * 1000;
const CACHE_TTL = 5 * 60 * 1000;
const EMERGENCY_FILE = '../../emergency_stop.txt';
const WALLET_FILE = '../../wallets/wallets.json';
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY = 1000;
const MAX_SOL_LOSS = 0.5 * LAMPORTS_PER_SOL;
const MAX_CONSECUTIVE_FAILURES = 3;

const NETWORK = process.env.NETWORK || 'mainnet';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || (NETWORK === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const BACKUP_RPCS = (process.env.BACKUP_RPCS || (NETWORK === 'mainnet' ? 'https://solana-mainnet.rpc.extrnode.com,https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com')).split(',');
const C2SD_MINT = new PublicKey(process.env.C2SD_MINT || '8FQa6U4fPDRjfNiVH9Ad3oZnrbtaQftQvAvAc8H3L4V3');
const USDC_MINT = new PublicKey(process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const C2C_MINT = new PublicKey(process.env.C2C_MINT || 'DFXm9DkshojkxfmPSPkgephdbSULzqbQGSW64K5keuzz');
const SOLSCAN_API_KEY = process.env.SOLSCAN_API_KEY;
const PROGRAM_ID = NETWORK === 'mainnet' ? MAINNET_PROGRAM_ID : DEVNET_PROGRAM_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const COINGECKO_C2SD_ID = process.env.COINGECKO_C2SD_ID || '';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const BASE_PRIORITY_FEE = parseInt(process.env.PRIORITY_FEE || '1000000');
const MIN_LIQUIDITY_USD = 10000;
const MAX_SLIPPAGE = new Percent(1, 100);
const MINIMUM_SOL = 0.01 * LAMPORTS_PER_SOL;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const MIN_PROFIT_BPS = 50;
const BASE_TRADE_INTERVAL = 90 * 1000;
const TOTAL_TRADES = 80;

const tokenCache = new Map<string, { data: any; timestamp: number }>();

interface BotState {
    status: any;
    tradeCount: number;
    currentWalletIndex: number;
    failureCount: number;
    lastTradeTime: number;
    logs: Array<{ message: string; timestamp: number; level: string }>;
    isRunning: boolean;
    currentPrice: number;
    priceHistory: Array<{ price: number; timestamp: number }>;
    walletBalances: { [key: string]: number };
    activeAlerts: Array<{ message: string; severity: string; timestamp: number }>;
    totalSolSpent: number;
}

const initialState: BotState = {
    status: 'idle',
    tradeCount: 0,
    currentWalletIndex: 0,
    failureCount: 0,
    lastTradeTime: 0,
    logs: [],
    isRunning: false,
    currentPrice: 0,
    priceHistory: [],
    walletBalances: {},
    activeAlerts: [],
    totalSolSpent: 0,
};

const botSlice = createSlice({
    name: 'TradingBot',
    initialState,
    reducers: {
        incrementTrade: (state) => { state.tradeCount += 1; },
        incrementFailure: (state) => { state.failureCount += 1; },
        resetFailure: (state) => { state.failureCount = 0; },
        setWalletIndex: (state, action: PayloadAction<number>) => {
            state.currentWalletIndex = action.payload;
        },
        setLastTradeTime: (state, action: PayloadAction<number>) => {
            state.lastTradeTime = action.payload;
        },
        addLog: (state, action: PayloadAction<{ message: string; level: string }>) => {
            state.logs.push({ message: action.payload.message, timestamp: Date.now(), level: action.payload.level });
        },
        setRunning: (state, action: PayloadAction<boolean>) => {
            state.isRunning = action.payload;
        },
        setPrice: (state, action: PayloadAction<number>) => {
            state.currentPrice = action.payload;
        },
        addPriceHistory: (state, action: PayloadAction<{ price: number; timestamp: number }>) => {
            state.priceHistory.push(action.payload);
            state.priceHistory = state.priceHistory.filter(p => Date.now() - p.timestamp < 5 * 60 * 1000);
        },
        updateWalletBalance: (state, action: PayloadAction<{ address: string; balance: number }>) => {
            state.walletBalances[action.payload.address] = action.payload.balance;
        },
        addAlert: (state, action: PayloadAction<{ message: string; severity: string; timestamp: number }>) => {
            state.activeAlerts.push(action.payload);
            state.activeAlerts = state.activeAlerts.filter(a => Date.now() - a.timestamp < 60 * 60 * 1000);
        },
        updateSolSpent: (state, action: PayloadAction<number>) => {
            state.totalSolSpent += action.payload;
        },
    }
});

const store = configureStore({
    reducer: {
        bot: botSlice.reducer,
    }
});

let wallet: Keypair;

export const getBotState = () => store.getState().bot;
export const {
    incrementTrade,
    incrementFailure,
    resetFailure,
    setWalletIndex,
    setLastTradeTime,
    addLog,
    setRunning,
    setPrice,
    addPriceHistory,
    updateWalletBalance,
    addAlert,
    updateSolSpent
} = botSlice.actions;

// --- State Management Placeholder ---
// const store = configureStore({ reducer: { bot: botSlice.reducers } });
// export const getBotState = () => store.getState().bot;

// --- Wallet Management ---
let wallets: Keypair[] = [];
let fundingWallet: Keypair | null = null;
let externalWallets: Array<{ publicKey: PublicKey }> = [];

function selectWallet(): number {
    const allWallets = [...wallets, ...externalWallets];
    if (allWallets.length === 0) throw new Error('No wallets available');
    return allWallets.reduce((best, wallet, i) => {
        const perf = walletPerformance[i] || { success: 0, failure: 0 };
        const score = perf.success / (perf.failure + 1);
        const bestScore = walletPerformance[best] ? walletPerformance[best].success / (walletPerformance[best].failure + 1) : -1;
        return score > bestScore ? i : best;
    }, 0);
}

// export async function reloadWallets(): Promise<void> {
//     try {
//         const walletFiles = await fs.readdir('./wallets');
//         const loadedWallets: Keypair[] = [];

//         for (const file of walletFiles) {
//             if (file.endsWith('.json')) {
//                 // The path should be relative to where the script is run (the project root)
//                 const data = await fs.readFile(`./wallets/${file}`, 'utf-8');
//                 const json: WalletData = JSON.parse(data);

//                 if (isWalletData(json)) {
//                     const keypair = Keypair.fromSecretKey(Uint8Array.from(json.secretKey));
//                     loadedWallets.push(keypair);
//                 } else {
//                     logger.warn(`Invalid wallet format: ${file}`);
//                 }
//             }
//         }

//         wallets = loadedWallets;
//         logger.info(`Wallets reloaded: ${wallets.length} wallets loaded.`);
//     } catch (err) {
//         logger.error('Failed to reload wallets: ' + err);
//     }
// }

export async function reloadWallets(): Promise<void> {
    try {
        const walletFiles = await fs.readdir('./wallets');
        const loadedWallets: Keypair[] = [];

        for (const file of walletFiles) {
            if (file.endsWith('.json')) {
                // The path should be relative to where the script is run (the project root)
                const data = await fs.readFile(`./wallets/${file}`, 'utf-8');
                const json: WalletData = JSON.parse(data);

                if (isWalletData(json)) {
                    const keypair = Keypair.fromSecretKey(Uint8Array.from(json.secretKey));
                    loadedWallets.push(keypair);
                } else {
                    logger.warn(`Invalid wallet format: ${file}`);
                }
            }
        }

        wallets = loadedWallets;
        logger.info(`Wallets reloaded: ${wallets.length} wallets loaded.`);
    } catch (err) {
        logger.error('Failed to reload wallets: ' + err);
    }
}

// --- Wallet Connections ---
let phantomAdapter: PhantomWalletAdapter | null = null;
let ledgerAdapter: LedgerWalletAdapter | null = null;
let walletPerformance: Array<{ success: number; failure: number }> = [];

export async function connectPhantom(): Promise<void> {
    try {
        phantomAdapter = new PhantomWalletAdapter();
        await phantomAdapter.connect();

        if (phantomAdapter.connected && phantomAdapter.publicKey) {
            externalWallets.push({ publicKey: phantomAdapter.publicKey });
            logger.info(`Phantom connected: ${phantomAdapter.publicKey.toBase58()}`);
        }
    } catch (err) {
        logger.error('Phantom connection failed: ' + err);
    }
}

export async function connectLedger(): Promise<void> {
    try {
        ledgerAdapter = new LedgerWalletAdapter();
        await ledgerAdapter.connect();

        if (ledgerAdapter.connected && ledgerAdapter.publicKey) {
            externalWallets.push({ publicKey: ledgerAdapter.publicKey });
            logger.info(`Ledger connected: ${ledgerAdapter.publicKey.toBase58()}`);
        }
    } catch (err) {
        logger.error('Ledger connection failed: ' + err);
    }
}

// --- Trading Logic Control ---
let tradingInterval: NodeJS.Timeout | null = null;
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com');
let isPaused = false;
async function tradingLoop(): Promise<void> {
    store.dispatch(setRunning(true));
    try {
        await verifyC2SDToken();
    } catch (error) {
        await logToGUI(`Initial token verification failed: ${error}`, 'error');
        store.dispatch(setRunning(false));
        return;
    }

    const healthCheck = setInterval(async () => {
        try {
            await Promise.all([
                verifyC2SDToken(),
                (async () => (await getVerifiedConnection()).getVersion())(),
                checkFunderBalance(),
                updateWalletBalances(),
            ]);
            await logToGUI('Health check passed', 'info');
            await sendAlert('Health check passed', 'info');
            healthGauge.set(1);
        } catch (error) {
            await logToGUI(`Health check failed: ${error}`, 'error');
            await sendAlert(`Health check failed: ${error}`, 'error');
            healthGauge.set(0);
            isPaused = true;
            store.dispatch(setRunning(false));
            clearInterval(healthCheck);
        }
    }, HEALTH_CHECK_INTERVAL);

    while (
        !(await checkEmergencyStop()) &&
        store.getState().bot.tradeCount < TOTAL_TRADES &&
        store.getState().bot.failureCount < MAX_CONSECUTIVE_FAILURES &&
        !isPaused
    ) {
        const currentTime = Date.now();
        const dynamicInterval = getDynamicInterval();
        if (currentTime - store.getState().bot.lastTradeTime < dynamicInterval) {
            await new Promise(resolve => setTimeout(resolve, dynamicInterval - (currentTime - store.getState().bot.lastTradeTime)));
        }
        if (isPaused || (await checkEmergencyStop())) break;

        try {
            config({ path: './.env' });
            await validateEnvironment();
            await reloadWallets();
            await updateWalletBalances();

            const walletIndex = selectWallet();
            const allWallets: Keypair[] = wallets;
            let wallet = wallets[walletIndex] as Keypair;
            await logToGUI(`Using wallet ${walletIndex + 1}: ${wallet.publicKey.toBase58()}`, 'info');
            await checkBalanceAndTopUp(wallet);

            const direction = store.getState().bot.tradeCount % 2 === 0 ? 'USDCtoC2SD' : 'C2SDtoUSDC';
            const inputMint = direction === 'USDCtoC2SD' ? USDC_MINT : C2SD_MINT;
            const outputMint = direction === 'USDCtoC2SD' ? C2SD_MINT : USDC_MINT;
            let poolKeys = await fetchPoolKeys(inputMint, outputMint);
            if (!poolKeys) {
                rotateWallet();
                wallet = allWallets[store.getState().bot.currentWalletIndex];
                poolKeys = await fetchPoolKeys(inputMint, outputMint);
                if (!poolKeys) throw new Error('No valid pool found after rotation');
            }
            const poolInfo = poolKeys ? await checkLiquidity(poolKeys) : null;
            const amountIn = poolInfo ? calculateTradeAmount(poolInfo.liquidityUSD) : 10;

            await CircuitBreaker.check();

            const txId =
                (await secureSwap(wallet, inputMint, outputMint, amountIn, direction, !poolKeys, poolKeys)) ||
                (await secureSwap(wallet, inputMint, outputMint, amountIn, direction, true, poolKeys));
            if (txId) {
                store.dispatch(incrementTrade());
                store.dispatch(resetFailure());
                rotateWallet();
            } else {
                store.dispatch(incrementFailure());
                if (store.getState().bot.failureCount >= MAX_CONSECUTIVE_FAILURES) {
                    await logToGUI('Circuit breaker: Halting bot after 3 consecutive failures', 'error');
                    await sendAlert('Circuit breaker: Halting bot after 3 consecutive failures', 'error');
                    store.dispatch(setRunning(false));
                    clearInterval(healthCheck);
                    break;
                }
            }

            store.dispatch(setWalletIndex(walletIndex));
            store.dispatch(setLastTradeTime(Date.now()));
        } catch (error) {
            await logToGUI(`Trading loop error: ${error}`, 'error');
            await sendAlert(`Trading loop error: ${error}`, 'error');
            store.dispatch(incrementFailure());
            if (store.getState().bot.failureCount >= MAX_CONSECUTIVE_FAILURES) {
                await logToGUI('Circuit breaker: Halting bot after 3 consecutive failures', 'error');
                await sendAlert('Circuit breaker: Halting bot after 3 consecutive failures', 'error');
                store.dispatch(setRunning(false));
                clearInterval(healthCheck);
                break;
            }
        }
    }
    if (store.getState().bot.tradeCount >= TOTAL_TRADES) {
        await logToGUI('Completed 80 trades!', 'info');
        await sendAlert('Completed 80 trades!', 'info');
        store.dispatch(setRunning(false));
        clearInterval(healthCheck);
    }
}

function calculateTradeAmount(liquidityUSD: number): number {
    const maxPercent = liquidityUSD > 50000 ? 0.001 : 0.0005;
    return Math.min(1000, liquidityUSD * maxPercent);
}

let initialReserveUSD: number | null = null;
async function checkLiquidity(poolKeys: any): Promise<any> {
    try {
        const connection = await getVerifiedConnection();
        const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });
        const baseReserve = poolInfo.baseReserve.toNumber() / 10 ** poolInfo.baseDecimals;
        const quoteReserve = poolInfo.quoteReserve.toNumber() / 10 ** poolInfo.quoteDecimals;
        const liquidityUSD = (baseReserve * 1 + quoteReserve * 1) * 2;
        if (liquidityUSD < MIN_LIQUIDITY_USD) {
            throw new Error(`Liquidity $${liquidityUSD.toFixed(2)} below $${MIN_LIQUIDITY_USD}`);
        }
        if (!initialReserveUSD) initialReserveUSD = liquidityUSD;
        if (liquidityUSD < initialReserveUSD * 0.8) {
            throw new Error('Reserves dropped >20% below initial');
        }
        const isLPLocked = await security.verifyLPLock(connection, poolKeys);
        if (!isLPLocked) throw new Error("LP not locked - possible rug");
        await logToGUI(`Pool liquidity: $${liquidityUSD.toFixed(2)}`, 'info');
        await sendAlert(`Pool liquidity: $${liquidityUSD.toFixed(2)}`, 'info');
        return poolInfo;
    } catch (error) {
        await logToGUI(`Liquidity check failed: ${error}`, 'error');
        await sendAlert(`Liquidity check failed: ${error}`, 'error');
        throw error;
    }
}

async function checkBalanceAndTopUp(wallet: Keypair | { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> }): Promise<void> {
    try {
        const connection = await getVerifiedConnection();
        const balance = await connection.getBalance(wallet.publicKey);
        if (balance < MINIMUM_SOL) {
            await logToGUI(`Wallet ${wallet.publicKey.toBase58()} balance low: ${balance / LAMPORTS_PER_SOL} SOL`, 'warn');
            await sendAlert(`Wallet ${wallet.publicKey.toBase58()} balance low: ${balance / LAMPORTS_PER_SOL} SOL`, 'warning');
            if (fundingWallet) {
                await checkFunderBalance();
                const amount = 0.05 * LAMPORTS_PER_SOL;
                const tx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: fundingWallet.publicKey,
                        toPubkey: wallet.publicKey,
                        lamports: amount,
                    })
                );
                await security.validateTx(tx, connection);
                const txId = await connection.sendTransaction(tx, [fundingWallet], { skipPreflight: false });
                await connection.confirmTransaction(txId);
                await logToGUI(`Topped up ${wallet.publicKey.toBase58()} with 0.05 SOL`, 'info');
                await sendAlert(`Topped up ${wallet.publicKey.toBase58()} with 0.05 SOL`, 'info');
            }
        }
        store.dispatch(updateWalletBalance({ address: wallet.publicKey.toBase58(), balance: balance / LAMPORTS_PER_SOL }));
    } catch (error) {
        await logToGUI(`SOL top-up failed: ${error}`, 'error');
        await sendAlert(`SOL top-up failed: ${error}`, 'error');
    }
}

async function validateEnvironment(): Promise<void> {
    try {
        await validateConfig();
        if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.DISCORD_WEBHOOK) {
            await logToGUI('No alert channels configured', 'warn');
        }
        if (process.env.USDC_MINT === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
            await logToGUI('USDC_MINT not specified, using default Mainnet USDC mint', 'warn');
        }
        const backupRpcs = (process.env.BACKUP_RPCS || '').split(',');
        if (backupRpcs.length === 0 || backupRpcs[0].trim() === '') {
            await logToGUI('No backup RPCs specified', 'warn');
        } else {
            await Promise.all(backupRpcs.map(async (rpc, i) => {
                if (!(await security.checkRpc(rpc))) {
                    throw new Error(`BACKUP_RPCS[${i}] is not a valid HTTPS URL`);
                }
            }));
        }
    } catch (error) {
        throw new Error(`Configuration validation failed: ${error}`);
    }
}
validateEnvironment().catch(error => {
    logger.error(`Environment validation failed: ${error.message}`);
});

async function checkEmergencyStop(): Promise<boolean> {
    if (await fs.access(EMERGENCY_FILE).then(() => true).catch(() => false)) {
        await logToGUI('EMERGENCY STOP TRIGGERED', 'error');
        await sendAlert('EMERGENCY STOP TRIGGERED', 'error');
        await fs.unlink(EMERGENCY_FILE);
        return true;
    }
    return false;
}

function getDynamicInterval(): number {
    const marketHoursMultiplier = isMarketActive() ? 1 : 1.5;
    return BASE_TRADE_INTERVAL * (0.8 + Math.random() * 0.4) * marketHoursMultiplier;
}

function isMarketActive(): boolean {
    const hour = new Date().getUTCHours();
    return hour >= 8 && hour <= 20;
}

async function checkFunderBalance(): Promise<void> {
    if (!fundingWallet) return;
    try {
        const connection = await getVerifiedConnection();
        const balance = await connection.getBalance(fundingWallet.publicKey);
        if (balance < 0.1 * LAMPORTS_PER_SOL) {
            await logToGUI(`Funding wallet balance low: ${balance / LAMPORTS_PER_SOL} SOL`, 'warn');
            await sendAlert(`Funding wallet balance low: ${balance / LAMPORTS_PER_SOL} SOL`, 'warning');
        }
        store.dispatch(updateWalletBalance({ address: fundingWallet.publicKey.toBase58(), balance: balance / LAMPORTS_PER_SOL }));
    } catch (error) {
        await logToGUI(`Funder balance check failed: ${error}`, 'error');
        await sendAlert(`Funder balance check failed: ${error}`, 'error');
    }
}

async function updateWalletBalances(): Promise<void> {
    const allWallets = [...wallets, ...externalWallets];
    for (const wallet of allWallets) {
        try {
            const connection = await getVerifiedConnection();
            const balance = await connection.getBalance(wallet.publicKey);
            store.dispatch(updateWalletBalance({ address: wallet.publicKey.toBase58(), balance: balance / LAMPORTS_PER_SOL }));
        } catch (error) {
            await logToGUI(`Balance check failed for ${wallet.publicKey.toBase58()}: ${error}`, 'error');
        }
    }
}

function rotateWallet(): void {
    const { currentWalletIndex } = store.getState().bot;
    const allWallets = [...wallets, ...externalWallets];
    let nextIndex = (currentWalletIndex + 1) % allWallets.length;

    const walletBalance = store.getState().bot.walletBalances[allWallets[nextIndex].publicKey.toBase58()] || 0;
    if (walletBalance < MINIMUM_SOL * 2) {
        nextIndex = (nextIndex + 1) % allWallets.length;
        if (nextIndex === currentWalletIndex) throw new Error('No valid wallets with sufficient balance');
        rotateWallet();
    }

    store.dispatch(setWalletIndex(nextIndex));
}

// async function verifyC2SDToken(): Promise<void> {
//     try {
//         let tokenData;
//         const cacheKey = C2SD_MINT.toBase58();
//         if (tokenCache.has(cacheKey) && Date.now() - tokenCache.get(cacheKey)!.timestamp < 24 * 60 * 60 * 1000) {
//             tokenData = tokenCache.get(cacheKey)!.data;
//         } else {
//             const response = await withRetry(() => axios.get(`https://api.solscan.io/token/meta?token=${cacheKey}`));
//             tokenData = response.data.data;
//             const rugCheck = await withRetry(() => axios.get(`https://api.rugcheck.xyz/v1/tokens/${cacheKey}/report`));
//             if (rugCheck.data.riskLevel > 0.5) {
//                 throw new Error(`C2SD token rug check failed: Risk level ${rugCheck.data.riskLevel}`);
//             }
//             const { buyTax, sellTax } = await checkTokenTax(C2SD_MINT);
//             if (buyTax > 5 || sellTax > 5) {
//                 throw new Error(`High token tax (buy=${buyTax}%, sell=${sellTax}%)`);
//             }
//             tokenCache.set(cacheKey, { data: tokenData, timestamp: Date.now() });
//         }
//         if (!tokenData) throw new Error('C2SD token not found on Solscan');
//         if (tokenData.freezeAuthority) throw new Error('C2SD token has freeze authority');
//         if (tokenData.mintAuthority) throw new Error('C2SD token is mintable');
//         await logToGUI('C2SD token verified: No freeze authority, non-mintable, rug check passed', 'info');
//         await sendAlert('C2SD token verified: No freeze authority, non-mintable, rug check passed', 'info');
//     } catch (error) {
//         await logToGUI(`C2SD token verification failed: ${error}`, 'error');
//         await sendAlert(`C2SD token verification failed: ${error}`, 'error');
//         throw error;
//     }
// }

async function verifyC2SDToken(): Promise<void> {
    try {
        let tokenData;
        const cacheKey = C2C_MINT.toBase58();
        console.log("cacheKey : " + cacheKey)
        // Define headers to mimic a browser request
        // Define a more complete set of browser-like headers
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        };

        if (tokenCache.has(cacheKey) && Date.now() - tokenCache.get(cacheKey)!.timestamp < 24 * 60 * 60 * 1000) {
            tokenData = tokenCache.get(cacheKey)!.data;
        } else {
            // Add headers to the axios requests
            const response = await fetch(`https://pro-api.solscan.io/v1.0/token/meta?token=${cacheKey}`, {
                headers: {
                    'Authorization': `Bearer ${SOLSCAN_API_KEY}`,
                    'accept': 'application/json',
                }
            });
            // const response = await withRetry(() => axios.get(`https://api.solscan.io/token/meta?token=${cacheKey}`, { headers }));
            tokenData = response;
            // const rugCheck = await withRetry(() => axios.get(`https://api.rugcheck.xyz/v1/tokens/${cacheKey}/report`, { headers }));

            // if (rugCheck.data.riskLevel > 0.5) {
            //     throw new Error(`C2SD token rug check failed: Risk level ${rugCheck.data.riskLevel}`);
            // }
            // const { buyTax, sellTax } = await checkTokenTax(C2C_MINT);
            // if (buyTax > 5 || sellTax > 5) {
            //     throw new Error(`High token tax (buy=${buyTax}%, sell=${sellTax}%)`);
            // }
            tokenCache.set(cacheKey, { data: tokenData, timestamp: Date.now() });
        }
        if (!tokenData) throw new Error('C2SD token not found on Solscan');
        if (tokenData.freezeAuthority) throw new Error('C2SD token has freeze authority');
        if (tokenData.mintAuthority) throw new Error('C2SD token is mintable');
        await logToGUI('C2SD token verified: No freeze authority, non-mintable, rug check passed', 'info');
        await sendAlert('C2SD token verified: No freeze authority, non-mintable, rug check passed', 'info');
    } catch (error) {
        await logToGUI(`C2SD token verification failed: ${error}`, 'error');
        await sendAlert(`C2SD token verification failed: ${error}`, 'error');
        throw error;
    }
}

// async function verifyC2SDToken(): Promise<void> {
//     try {
//         const conn = await getVerifiedConnection();
//         const mintInfo = await conn.getAccountInfo(C2SD_MINT);

//         if (!mintInfo) {
//             throw new Error('C2SD token mint account not found on-chain.');
//         }

//         const decodedMint = MintLayout.decode(mintInfo.data);

//         if (decodedMint.mintAuthority) {
//              throw new Error('C2SD token is still mintable (has a mint authority).');
//         }

//         if (decodedMint.freezeAuthority) {
//             throw new Error('C2SD token has a freeze authority.');
//         }

//         // The external API calls are now removed.
//         await logToGUI('C2SD token verified: No freeze or mint authority.', 'info');
//         await sendAlert('C2SD token verified: No freeze or mint authority.', 'info');

//     } catch (error) {
//         await logToGUI(`C2SD token verification failed: ${error}`, 'error');
//         await sendAlert(`C2SD token verification failed: ${error}`, 'error');
//         throw error;
//     }
// }

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = MAX_RETRIES, baseDelay: number = BASE_RETRY_DELAY): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            // if (attempt === maxRetries) throw new Error(`Failed after ${maxRetries} attempts: ${error}`);
            const delay = baseDelay * Math.pow(2, attempt - 1);
            await logToGUI(`Retry attempt ${attempt}/${maxRetries} after ${delay}ms: ${error}`, 'warn');
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error('Unexpected retry loop exit');
}

async function checkTokenTax(mint: PublicKey): Promise<{ buyTax: number, sellTax: number }> {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`);
    return {
        buyTax: response.data.pair.buyTax || 0,
        sellTax: response.data.pair.sellTax || 0
    };
}

let connectionPool: Connection[] = [];
async function getVerifiedConnection(): Promise<Connection> {
    if (connectionPool.length === 0) {
        const rpcs = [RPC_ENDPOINT, ...BACKUP_RPCS];
        connectionPool = (await Promise.allSettled(
            rpcs.map(async rpc => {
                if (!(await security.checkRpc(rpc))) throw new Error('Non-HTTPS RPC detected');
                const conn = new Connection(rpc, 'confirmed');
                await conn.getVersion();
                return conn;
            })
        )).filter(c => c.status === 'fulfilled').map(c => (c as any).value);
        if (connectionPool.length === 0) {
            throw new Error('All RPCs failed - circuit breaker triggered');
        }
    }
    const validConnection = connectionPool[0];
    if (!validConnection) {
        throw new Error('All RPC connections failed');
    }
    await logToGUI(`Using connection: ${validConnection.rpcEndpoint}`, 'info');
    return validConnection;
}
setInterval(() => {
    connectionPool = [];
}, 60 * 60 * 1000);

const security = {
    validateTx: async (tx: Transaction, connection: Connection): Promise<void> => {
        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err) throw new Error(`Transaction simulation failed: ${JSON.stringify(sim.value.err)}`);
        if (sim.value.logs && sim.value.logs.some(log => log.includes('error'))) {
            throw new Error('Suspicious transaction behavior');
        }
    },
    checkRpc: async (url: string): Promise<boolean> => {
        try {
            const res = await fetch(`${url}/health`);
            if (!res.ok) throw new Error('RPC health check failed');
            return url.startsWith('https://');
        } catch (error) {
            throw new Error(`RPC check failed for ${url}: ${error}`);
        }
    },
    verifyLPLock: async (connection: Connection, poolKeys: any): Promise<boolean> => {
        const lpAccount = await connection.getAccountInfo(poolKeys.lpMint);
        const data = lpAccount?.data;
        if (!data) throw new Error("LP account missing");
        const hasLock = data[44] === 0 && data[52] === 0;
        if (!hasLock) throw new Error("LP NOT LOCKED");
        return hasLock;
    }
};

async function logToGUI(message: string, level: string = 'info'): Promise<void> {
    logger.log({ level, message });
    store.dispatch(addLog({ message, level }));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    //   await pushLogToS3(process.env.AWS_S3_BUCKET, `ENT-WT-v2.0/logs/bot_${timestamp}.log`, JSON.stringify({ message, level, timestamp: Date.now() }));
    if (ipcRenderer) {
        try {
            await rateLimiter.consume('log');
            ipcRenderer.send('log-event', { message, level });
        } catch (error) {
            logger.error(`Failed to send log via IPC: ${error}`);
        }
    }
}
const telegramBot = TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true }) : null;
if (telegramBot) {
    telegramBot.onText(/\/kill/, async (msg) => {
        if (msg.chat.id.toString() === TELEGRAM_CHAT_ID) {
            await fs.writeFile(EMERGENCY_FILE, '');
            await logToGUI('Remote kill switch triggered via Telegram', 'error');
            await sendAlert('Remote kill switch triggered via Telegram', 'error');
        }
    });
}
async function sendAlert(msg: string, severity: string = 'info'): Promise<void> {
    try {
        if (telegramBot) await telegramBot.sendMessage(TELEGRAM_CHAT_ID!, msg);
        if (DISCORD_WEBHOOK) await axios.post(DISCORD_WEBHOOK, { content: msg });
        store.dispatch(addAlert({ message: msg, severity, timestamp: Date.now() }));
    } catch (error) {
        await logToGUI(`Alert failed: ${error}`, 'error');
    }
}

// export async function startTradingLoop() {
//     if (tradingInterval) {
//         logger.warn("Trading loop is already running.");
//         return;
//     }

//     logger.info("Starting trading loop...");
//     tradingInterval = setInterval(async () => {
//         try {
//             logger.info("Executing trading iteration...");

//             logger.info("Wallet size : " + wallets.length)
//             // Example logic: log balances
//             for (const wallet of wallets) {
//                 const balance = await connection.getBalance(wallet.publicKey);
//                 logger.info(`Wallet ${wallet.publicKey.toBase58()} has ${balance} lamports`);
//             }

//         } catch (err) {
//             logger.error("Trading iteration error: " + err);
//         }
//     }, 15000); // Every 15 seconds
// }

export async function startTradingLoop() {
    if (store.getState().bot.isRunning) {
        logger.warn("Trading loop is already running.");
        return;
    }

    logger.info("Starting trading loop...");
    await reloadWallets(); // Load wallets before starting

    if (wallets.length === 0) {
        logger.error("No wallets found. Cannot start trading loop.");
        return;
    }

    // Start the main trading loop. It runs on its own, not in an interval.
    tradingLoop();
}

export function stopTradingLoop() {
    if (tradingInterval) {
        clearInterval(tradingInterval);
        tradingInterval = null;
        logger.info("Trading loop stopped.");
    } else {
        logger.warn("Trading loop is not running.");
    }
}

let lastOutput: number | null = null;
async function secureSwap(
    wallet: Keypair,
    inputMint: PublicKey,
    outputMint: PublicKey,
    amountIn: number,
    direction: string,
    p0: boolean,
    poolKeys: LiquidityPoolKeys
): Promise<string | null> {
    const connection = await getVerifiedConnection();
    const walletIndex = wallets.findIndex(w => w.publicKey.equals(wallet.publicKey));

    try {
        // --- 1. Create Token and TokenAmount objects ---
        const inputToken = new Token(TOKEN_PROGRAM_ID, inputMint, 6); // Assuming 6 decimals
        const outputToken = new Token(TOKEN_PROGRAM_ID, outputMint, 6);
        const amountInToken = new TokenAmount(inputToken, amountIn, false); // false = not raw amount

        // --- 2. Fetch pool info and compute the swap amount ---
        const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });
        const { minAmountOut, priceImpact } = Liquidity.computeAmountOut({
            poolKeys,
            poolInfo,
            amountIn: amountInToken,
            currencyOut: outputToken,
            slippage: new Percent(1, 100), // Using 1% slippage
        });

        // --- 3. Validate Price Impact ---
        const value = priceImpact.numerator.toNumber() / priceImpact.denominator.toNumber();
        if (value > 0.05) {
            throw new Error(`Price impact is too high (${priceImpact.toFixed(2)}%). Aborting.`);
        }

        // --- 4. Create the swap transaction instructions ---
        const userTokenAccounts = await getWalletTokenAccounts(connection, wallet.publicKey);

        // --- FIX: Correctly handle the new return structure ---
        const swapInstructionResult = await Liquidity.makeSwapInstructionSimple({
            connection,
            poolKeys,
            userKeys: {
                tokenAccounts: userTokenAccounts,
                owner: wallet.publicKey,
            },
            amountIn: amountInToken,
            amountOut: minAmountOut,
            fixedSide: 'in',
            makeTxVersion: 0,
        });

        const transaction = new Transaction();
        const signers: Signer[] = [];

        // Combine instructions and signers from inner transactions
        for (const innerTx of swapInstructionResult.innerTransactions) {
            transaction.add(...innerTx.instructions);
            signers.push(...innerTx.signers);
        }

        // --- 5. Build, sign, and send the transaction ---
        const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.recentBlockhash = recentBlockhash;
        transaction.feePayer = wallet.publicKey;

        // Add any additional signers from the instruction
        const allSigners = [wallet, ...signers];
        transaction.sign(...allSigners);

        const rawTransaction = transaction.serialize();
        const txId = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 5,
        });

        // --- 6. Confirm the transaction ---
        const confirmation = await connection.confirmTransaction({
            signature: txId,
            blockhash: recentBlockhash,
            lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight,
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(`Transaction failed to confirm: ${JSON.stringify(confirmation.value.err)}`);
        }

        await logToGUI(`Swap successful! TX ID: ${txId}`, 'info');
        if (walletIndex > -1) {
            walletPerformance[walletIndex].success++;
        }
        // Uncomment these lines if you have redux/state management setup
        // store.dispatch(incrementTrade());
        // store.dispatch(resetFailure());
        return txId;

    } catch (error: any) {
        await logToGUI(`Swap failed: ${error.message}`, 'error');
        if (walletIndex > -1) {
            walletPerformance[walletIndex].failure++;
        }
        // Uncomment these lines if you have redux/state management setup
        // store.dispatch(incrementFailure());
        return null;
    }
}

async function getWalletTokenAccounts(connection: Connection, owner: PublicKey): Promise<TokenAccount[]> {
    const tokenResp = await connection.getTokenAccountsByOwner(owner, {
        programId: TOKEN_PROGRAM_ID
    });

    const accounts: TokenAccount[] = [];
    for (const { pubkey, account } of tokenResp.value) {
        accounts.push({
            pubkey,
            programId: TOKEN_PROGRAM_ID,
            accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data)
        });
    }
    return accounts;
}

async function getAssociatedTokenAccounts(connection: Connection, owner: PublicKey): Promise<TokenAccount[]> {
    const tokenResp = await connection.getTokenAccountsByOwner(owner, {
        programId: TOKEN_PROGRAM_ID
    });

    const accounts: TokenAccount[] = [];
    for (const {
        pubkey,
        account
    } of tokenResp.value) {
        accounts.push({
            pubkey,
            programId: TOKEN_PROGRAM_ID,
            accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data)
        });
    }
    return accounts;
}


async function getCompetitiveFee(): Promise<number> {
    const connection = await getVerifiedConnection();
    const fees = await connection.getRecentPrioritizationFees();
    const recentFee = Math.max(...fees.map(f => f.prioritizationFee), BASE_PRIORITY_FEE);

    const networkCongestion = await connection.getRecentPerformanceSamples(1);
    const congestionMultiplier = networkCongestion[0].numTransactions > 2000 ? 1.2 : 1;

    return Math.min(
        Math.floor(recentFee * congestionMultiplier),
        BASE_PRIORITY_FEE * 3 // Cap at 3x base fee
    );
}

async function fetchExternalPrice(): Promise<number> {
    try {
        if (BIRDEYE_API_KEY) {
            const response = await withRetry(() =>
                axios.get(`https://public-api.birdeye.so/public/price?address=${C2SD_MINT.toBase58()}`, {
                    headers: { 'X-API-KEY': BIRDEYE_API_KEY },
                })
            );
            const price = parseFloat(response.data.data.value);
            store.dispatch(setPrice(price));
            store.dispatch(addPriceHistory({ price, timestamp: Date.now() }));
            const washScore = await detectWashTrading(C2SD_MINT);
            if (washScore > 0.7) {
                await logToGUI(`Wash trading detected (score=${washScore})`, 'error');
                throw new Error("Aborting trade - wash trading detected");
            }
            return price;
        }
        if (COINGECKO_C2SD_ID) {
            const response = await withRetry(() =>
                axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_C2SD_ID}&vs_currencies=usd`)
            );
            const price = parseFloat(response.data[COINGECKO_C2SD_ID].usd);
            store.dispatch(setPrice(price));
            store.dispatch(addPriceHistory({ price, timestamp: Date.now() }));
            const washScore = await detectWashTrading(C2SD_MINT);
            if (washScore > 0.7) {
                await logToGUI(`Wash trading detected (score=${washScore})`, 'error');
                throw new Error("Aborting trade - wash trading detected");
            }
            return price;
        }
        throw new Error('No external price feed available');
    } catch (error) {
        await logToGUI(`External price fetch failed: ${error}`, 'error');
        await sendAlert(`External price fetch failed: ${error}`, 'error');
        const poolInfo = await checkLiquidity(await fetchPoolKeys(USDC_MINT, C2SD_MINT));
        const price = poolInfo.baseReserve.toNumber() / poolInfo.quoteReserve.toNumber();
        store.dispatch(setPrice(price));
        store.dispatch(addPriceHistory({ price, timestamp: Date.now() }));
        return price;
    }
}

async function detectWashTrading(mint: PublicKey): Promise<number> {
    const response = await axios.get(`https://api.birdeye.so/v1/wash/${mint.toBase58()}`, {
        headers: { 'X-API-KEY': BIRDEYE_API_KEY }
    });
    return response.data.score; // 0-1 (1 = wash trading)
}

async function checkPriceVolatility(poolInfo: any): Promise<boolean> {
    const currentPrice = poolInfo.baseReserve.toNumber() / poolInfo.quoteReserve.toNumber();
    store.dispatch(addPriceHistory({ price: currentPrice, timestamp: Date.now() }));
    const priceHistory = store.getState().bot.priceHistory;
    if (priceHistory.length < 2) return true;
    const maxPrice = Math.max(...priceHistory.map(p => p.price));
    const minPrice = Math.min(...priceHistory.map(p => p.price));
    const volatility = (maxPrice - minPrice) / minPrice;
    if (volatility > 0.1) {
        await logToGUI(`Volatility ${volatility * 100}% exceeds 10%. Pausing.`, 'warn');
        await sendAlert(`Volatility ${volatility * 100}% exceeds 10%. Pausing.`, 'warning');
        return false;
    }
    return true;
}

async function getDynamicSlippage(liquidityUSD: number, volatility: number): Promise<Percent> {
    const baseSlippage = liquidityUSD < 25_000 ? 0.05 : 0.01; // 5% or 1%
    const volatilityMultiplier = 1 + (volatility / 0.1); // Scale with volatility
    return new Percent(
        Math.min(Math.floor(baseSlippage * volatilityMultiplier * 100), 100),
        100
    );
}

const POOL_CACHE_FILE = './pool_cache.json'; 
async function saveCachedPools(pools: any[]): Promise<void> {
    try {
        await fs.writeFile(POOL_CACHE_FILE, JSON.stringify(pools), { mode: 0o600 });
    } catch (error) {
        await logToGUI(`Failed to save pool cache: ${error}`, 'error');
        throw error;
    }
}

let lastPoolFetch = 0;
let cachedPools: any = null;
// async function fetchPoolKeys(baseMint: PublicKey, quoteMint: PublicKey): Promise<any> {
//     if (Date.now() - lastPoolFetch < CACHE_TTL && cachedPools) {
//         return cachedPools;
//     }
//     try {
//         const response = await withRetry(() => axios.get(`https://api.raydium.io/v2/sdk/liquidity/${NETWORK}.json`));
//         const pools = [...response.data.official, ...response.data.unOfficial];
//         await saveCachedPools(pools);
//         const poolData = pools.filter(
//             p => (
//                 (p.baseMint === baseMint.toBase58() && p.quoteMint === quoteMint.toBase58()) ||
//                 (p.baseMint === quoteMint.toBase58() && p.quoteMint === baseMint.toBase58())
//             )
//         );
//         if (poolData.length === 0) throw new Error('C2SD/USDC pool not found');
//         const selectedPool = poolData.reduce((best, curr) => {
//             const currLiquidity = parseFloat(curr.tvl) || 0;
//             const bestLiquidity = parseFloat(best.tvl) || 0;
//             return currLiquidity > bestLiquidity ? curr : best;
//         }, poolData[0]);
//         lastPoolFetch = Date.now();
//         cachedPools = {
//             id: new PublicKey(selectedPool.id),
//             baseMint: new PublicKey(selectedPool.baseMint),
//             quoteMint: new PublicKey(selectedPool.quoteMint),
//             programId: PROGRAM_ID.AmmV4,
//         };
//         if (await isNewPool(cachedPools)) {
//             // await logToGUI(`Skipping new pool (age: ${await connection.getAccountInfo(cachedPools.id).then(acc => (Date.now() - acc.owner) / 1000 / 60)}m)`, 'warn');
//             return null;
//         }
//         return cachedPools;
//     } catch (error) {
//         await logToGUI(`Error fetching pool keys: ${error}`, 'error');
//         try {
//             const pools = await loadCachedPools();
//             const poolData = pools.filter(
//                 p => (
//                     (p.baseMint === baseMint.toBase58() && p.quoteMint === quoteMint.toBase58()) ||
//                     (p.baseMint === quoteMint.toBase58() && p.quoteMint === baseMint.toBase58())
//                 )
//             );
//             if (poolData.length === 0) throw new Error('C2SD/USDC pool not found in cache');
//             const selectedPool = poolData.reduce((best, curr) => {
//                 const currLiquidity = parseFloat(curr.tvl) || 0;
//                 const bestLiquidity = parseFloat(best.tvl) || 0;
//                 return currLiquidity > bestLiquidity ? curr : best;
//             }, poolData[0]);
//             lastPoolFetch = Date.now();
//             cachedPools = {
//                 id: new PublicKey(selectedPool.id),
//                 baseMint: new PublicKey(selectedPool.baseMint),
//                 quoteMint: new PublicKey(selectedPool.quoteMint),
//                 programId: PROGRAM_ID.AmmV4,
//             };
//             if (await isNewPool(cachedPools)) {
//                 // await logToGUI(`Skipping new pool (age: ${await connection.getAccountInfo(cachedPools.id).then(acc => (Date.now() - acc.owner) / 1000 / 60)}m)`, 'warn');
//                 return null;
//             }
//             return cachedPools;
//         } catch (cacheError) {
//             await logToGUI(`Cache fallback failed: ${cacheError}. Relying on Jupiter.`, 'error');
//             await sendAlert(`Pool fetch failed: ${cacheError}. Relying on Jupiter.`, 'error');
//             return null;
//         }
//     }
// }

// FIX: This function now tries the local cache first before falling back to the API
async function fetchPoolKeys(baseMint: PublicKey, quoteMint: PublicKey): Promise<any> {
    // 1. Try to load from the local cache first
    try {
        const pools = await loadCachedPools();
        const poolData = pools.filter(
            p => (
                (p.baseMint === baseMint.toBase58() && p.quoteMint === quoteMint.toBase58()) ||
                (p.baseMint === quoteMint.toBase58() && p.quoteMint === baseMint.toBase58())
            )
        );
        if (poolData.length === 0) throw new Error('C2SD/USDC pool not found in cache');
        
        const selectedPool = poolData.reduce((best, curr) => {
            const currLiquidity = parseFloat(curr.tvl) || 0;
            const bestLiquidity = parseFloat(best.tvl) || 0;
            return currLiquidity > bestLiquidity ? curr : best;
        }, poolData[0]);

        return {
            id: new PublicKey(selectedPool.id),
            baseMint: new PublicKey(selectedPool.baseMint),
            quoteMint: new PublicKey(selectedPool.quoteMint),
            programId: PROGRAM_ID.AmmV4,
        };
    } catch (cacheError: any) {
        logger.warn(`Could not load pool keys from cache: ${cacheError.message}. Falling back to API.`);
    }

    // 2. If cache fails, try the API as a fallback
    try {
        const response = await withRetry(() => axios.get(`https://api.raydium.io/v2/sdk/liquidity/${NETWORK}.json`));
        const pools = [...response.data.official, ...response.data.unOfficial];
        await saveCachedPools(pools); // Save for next time
        const poolData = pools.filter(
            p => (
                (p.baseMint === baseMint.toBase58() && p.quoteMint === quoteMint.toBase58()) ||
                (p.baseMint === quoteMint.toBase58() && p.quoteMint === baseMint.toBase58())
            )
        );
        if (poolData.length === 0) throw new Error('C2SD/USDC pool not found');
        const selectedPool = poolData.reduce((best, curr) => {
            const currLiquidity = parseFloat(curr.tvl) || 0;
            const bestLiquidity = parseFloat(best.tvl) || 0;
            return currLiquidity > bestLiquidity ? curr : best;
        }, poolData[0]);
        
        return {
            id: new PublicKey(selectedPool.id),
            baseMint: new PublicKey(selectedPool.baseMint),
            quoteMint: new PublicKey(selectedPool.quoteMint),
            programId: PROGRAM_ID.AmmV4,
        };
    } catch (apiError: any) {
        await logToGUI(`Error fetching pool keys from API: ${apiError.message}`, 'error');
        await sendAlert(`FATAL: Pool fetch failed from both cache and API.`, 'error');
        return null;
    }
}


async function isNewPool(poolKeys: any): Promise<boolean> {
    const acc = await connection.getAccountInfo(poolKeys.id);

    if (!acc) {
        console.warn('Pool account not found');
        return false;
    }

    // ⚠️ Placeholder: No way to get actual creation time
    // You must fetch age from on-chain data or your metadata, if available

    return false; // default fallback
}

async function loadCachedPools(): Promise<any[]> {
    try {
        const content = await fs.readFile(POOL_CACHE_FILE, 'utf-8'); // specify encoding
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`Failed to load pool cache: ${error}`);
    }
}
