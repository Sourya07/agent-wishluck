import crypto from 'node:crypto';
export const uid = (prefix = '') => `${prefix}${crypto.randomBytes(6).toString('hex')}`;
export const shortId = (prefix: string) => `${prefix}${Math.floor(1000 + Math.random() * 9000)}${crypto.randomBytes(1).toString('hex').toUpperCase()}`;
