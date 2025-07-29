// backend/src/index.ts
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { connectToDatabase } from './db'; // Import DB connection
import { initializeAdmin, login, requireAdmin } from './auth';
import { startTradingLoop, stopTradingLoop, getBotState } from './bot';
import logger from './logger';
import usersRouter from './users'; // Import the new user router

async function startServer() {
    // Connect to the database first
    await connectToDatabase();

    const app = express();
    app.use(cors({
        origin: 'http://localhost:3000', // Frontend origin
        credentials: true
    }));

    
    app.use(express.json());

    // --- PUBLIC ROUTES ---
    app.post('/api/login', login);

    // Note: init-admin is now handled on first startup automatically
    // You can still expose it as an API if you want, but it's less secure.

    // --- PROTECTED ROUTES ---
    // All routes below this point require a valid JWT
    app.use(requireAdmin);

    app.get('/api/status', (req, res) => res.json(getBotState()));
    app.post('/api/start-bot', async (req, res) => {
        await startTradingLoop();
        res.json({ message: 'Bot start command issued.' });
    });
    app.post('/api/stop-bot', (req, res) => {
        stopTradingLoop();
        res.json({ message: 'Bot stop command issued.' });
    });

    // Use the user management router under the /api/users path
    app.use('/api/users', usersRouter);

    // --- SERVER START ---
    const PORT = parseInt(process.env.PORT || '8081', 10);
    app.listen(PORT, '0.0.0.0', async () => {
        logger.info(`Backend server is running on http://localhost:${PORT}`);

        // On first run, create the default admin user
        await initializeAdmin('admin', 'admin123');
    });
}

startServer().catch(error => {
    logger.error('Failed to start server:', error);
});