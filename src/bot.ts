// backend/src/bot.ts

import { config } from 'dotenv';
import { createSlice, PayloadAction, configureStore } from '@reduxjs/toolkit';
import { promises as fs } from 'fs';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { LedgerWalletAdapter } from '@solana/wallet-adapter-ledger';
import { WalletData, isWalletData } from './types/wallet';
import logger from './logger';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
let ipcRenderer: any;
config();
const rateLimiter = new RateLimiterMemory({
  points: 50,
  duration: 5 * 60,
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

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
export let wallets: Keypair[] = [];
export let externalWallets: Array<{ publicKey: PublicKey }> = [];

export async function reloadWallets(): Promise<void> {
    try {
        const walletFiles = await fs.readdir('./wallets');
        const loadedWallets: Keypair[] = [];

        for (const file of walletFiles) {
            if (file.endsWith('.json')) {
                const data = await fs.readFile(`../../wallets/${file}`, 'utf-8');
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

async function tradingLoop(): Promise<void> {
  store.dispatch(setRunning(true));
  try {
    await verifyC2SDToken();
  } catch (error) {
    await logToGUI(`Initial token verification failed: ${error.message}`, 'error');
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
      await logToGUI(`Health check failed: ${error.message}`, 'error');
      await sendAlert(`Health check failed: ${error.message}`, 'error');
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
      config({ path: '../../.env' });
      await validateEnvironment();
      await reloadWallets();
      await updateWalletBalances();

      const walletIndex = selectWallet();
      const allWallets = [...wallets, ...externalWallets];
      let wallet = allWallets[walletIndex];
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
        (await secureSwap(wallet, inputMint, outputMint, amountIn, direction, !poolKeys)) ||
        (await secureSwap(wallet, inputMint, outputMint, amountIn, direction, true));

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
      await logToGUI(`Trading loop error: ${error.message}`, 'error');
      await sendAlert(`Trading loop error: ${error.message}`, 'error');
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

async function verifyC2SDToken(): Promise<void> {
  try {
    let tokenData;
    const cacheKey = C2SD_MINT.toBase58();
    if (tokenCache.has(cacheKey) && Date.now() - tokenCache.get(cacheKey)!.timestamp < 24 * 60 * 60 * 1000) {
      tokenData = tokenCache.get(cacheKey)!.data;
    } else {
      const response = await withRetry(() => axios.get(`https://api.solscan.io/token/meta?token=${cacheKey}`));
      tokenData = response.data.data;
      const rugCheck = await withRetry(() => axios.get(`https://api.rugcheck.xyz/v1/tokens/${cacheKey}/report`));
      if (rugCheck.data.riskLevel > 0.5) {
        throw new Error(`C2SD token rug check failed: Risk level ${rugCheck.data.riskLevel}`);
      }
      const { buyTax, sellTax } = await checkTokenTax(C2SD_MINT);
      if (buyTax > 5 || sellTax > 5) {
        throw new Error(`High token tax (buy=${buyTax}%, sell=${sellTax}%)`);
      }
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

export async function startTradingLoop() {
    if (tradingInterval) {
        logger.warn("Trading loop is already running.");
        return;
    }

    logger.info("Starting trading loop...");
    tradingInterval = setInterval(async () => {
        try {
            logger.info("Executing trading iteration...");

            logger.info("Wallet size : " + wallets.length)
            // Example logic: log balances
            for (const wallet of wallets) {
                const balance = await connection.getBalance(wallet.publicKey);
                logger.info(`Wallet ${wallet.publicKey.toBase58()} has ${balance} lamports`);
            }

        } catch (err) {
            logger.error("Trading iteration error: " + err);
        }
    }, 15000); // Every 15 seconds
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
