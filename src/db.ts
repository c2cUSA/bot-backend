// backend/src/db.ts
import { Sequelize, DataTypes, Model } from 'sequelize';
import logger from './logger';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    const errorMessage = 'DATABASE_URL is not set in the environment variables.';
    logger.error(errorMessage);
    // Throwing an error stops execution and satisfies the type checker.
    throw new Error(errorMessage);
}

// Initialize Sequelize
// TypeScript now knows `databaseUrl` must be a string at this point.
export const sequelize = new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: (msg) => logger.debug(msg), // Use your logger
});

// Define the User model
export class User extends Model {
    public id!: number;
    public username!: string;
    public passwordHash!: string;
    public twofaSecret!: string;
    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

User.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    username: {
        type: new DataTypes.STRING(128),
        allowNull: false,
        unique: true,
    },
    passwordHash: {
        type: new DataTypes.STRING(255),
        allowNull: false,
    },
    twofaSecret: {
        type: new DataTypes.STRING(255),
        allowNull: false,
    },
}, {
    tableName: 'users',
    sequelize, // passing the connection instance
});

// Function to connect and sync the database
export async function connectToDatabase() {
    try {
        await sequelize.authenticate();
        logger.info('Connection to the database has been established successfully.');
        await sequelize.sync({ alter: true }); // This will create/update tables
        logger.info('Database synchronized.');
    } catch (error) {
        logger.error('Unable to connect to the database:', error);
        // It's better to let the error propagate up to the main server start function
        throw error;
    }
}
