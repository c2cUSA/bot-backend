// wallet.ts

export interface WalletData {
  publicKey: string;
  secretKey: Uint8Array;
  name?: string;
  balance?: number;
  createdAt?: Date;
}

// export function isWalletData(obj: any): obj is WalletData {
//   return (
//     typeof obj === 'object' &&
//     obj !== null &&
//     typeof obj.publicKey === 'string' &&
//     obj.secretKey instanceof Uint8Array &&
//     (typeof obj.name === 'undefined' || typeof obj.name === 'string') &&
//     (typeof obj.balance === 'undefined' || typeof obj.balance === 'number') &&
//     (typeof obj.createdAt === 'undefined' || obj.createdAt instanceof Date)
//   );
// }

export function isWalletData(obj: any): obj is WalletData {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    Array.isArray(obj.secretKey)
  );
}