const logger = {
    info: (message: string) => console.log(`[INFO] ${message}`),
    error: (message: string, error?: any) => {
        if (error) {
            console.error(`[ERROR] ${message} -`, error);
        } else {
            console.error(`[ERROR] ${message}`);
        }
    },
    warn: (message: string) => console.warn(`[WARN] ${message}`),
    debug: (message: string) => console.debug(`[DEBUG] ${message}`),
    log: (logObject: { level: string; message: string }) => {
        console.log(`[${logObject.level.toUpperCase()}] ${logObject.message}`);
    }
};

export default logger;