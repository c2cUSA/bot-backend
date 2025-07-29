// backend/src/auth.ts
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import { User } from './db'; // Import the User model
import logger from './logger';

export async function initializeAdmin(username: string, password: string) {
    const existingAdmin = await User.findOne({ where: { username } });
    if (existingAdmin) {
        logger.info(`Admin user "${username}" already exists.`);
        return { message: 'Admin already initialized.' };
    }

    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const secret = speakeasy.generateSecret({ length: 20 });

    await User.create({
        username,
        passwordHash,
        twofaSecret: secret.base32,
    });
    
    logger.info(`Admin user "${username}" has been created successfully.`);
    return {
        message: 'Admin initialized successfully.',
        secret: secret.base32,
        otpauth_url: secret.otpauth_url,
    };
}

export async function login(req: express.Request, res: express.Response) {
    const { username, password, token } = req.body;

    const user = await User.findOne({ where: { username } });
    if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    const verified = speakeasy.totp.verify({
        secret: user.twofaSecret,
        encoding: 'base32',
        token,
    });

    if (!verified) {
        return res.status(401).json({ error: 'Invalid 2FA token' });
    }

    const jwtSecret = process.env.ENCRYPTION_KEY!;
    const accessToken = jwt.sign({ username: user.username, id: user.id }, jwtSecret, { expiresIn: '24h' });

    res.json({ accessToken });
}

export async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
    // FIX: Allow all preflight OPTIONS requests to pass through for CORS.
    if (req.method === 'OPTIONS') {
        return next();
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const jwtSecret = process.env.ENCRYPTION_KEY!;
        const decoded = jwt.verify(token, jwtSecret) as { username: string, id: number };
        
        const user = await User.findByPk(decoded.id);
        if (!user) {
            return res.status(403).json({ error: 'Invalid admin user' });
        }
        
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}
