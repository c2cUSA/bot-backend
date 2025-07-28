// backend/src/users.ts
import express from 'express';
import bcrypt from 'bcryptjs';
import { User } from './db';

const router = express.Router();

// GET /api/users - List all users
router.get('/', async (req, res) => {
    const users = await User.findAll({
        attributes: ['id', 'username', 'createdAt', 'updatedAt'] // Exclude sensitive fields
    });
    res.json(users);
});

// POST /api/users - Create a new user
router.post('/', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    // Note: For simplicity, we use a placeholder for 2FA. In a real app, you'd generate a new secret.
    const twofaSecret = 'NEW_USER_PLACEHOLDER_SECRET';

    try {
        const newUser = await User.create({ username, passwordHash, twofaSecret });
        res.status(201).json({ id: newUser.id, username: newUser.username });
    } catch (error: any) {
        res.status(400).json({ error: 'Username may already be taken.' });
    }
});

// DELETE /api/users/:id - Delete a user
router.delete('/:id', async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const user = await User.findByPk(userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found.' });
    }

    // Prevent deleting the initial admin user (ID 1)
    if (user.id === 1) {
        return res.status(403).json({ error: 'Cannot delete the primary admin account.' });
    }

    await user.destroy();
    res.status(204).send(); // No Content
});

export default router;