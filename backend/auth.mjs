import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import { query } from './db.mjs';

const scrypt = promisify(scryptCallback);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, value] = stored.split(':');
  if (!salt || !value) return false;
  const expected = Buffer.from(value, 'hex');
  const actual = await scrypt(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const sign = value => createHmac('sha256', config.jwtSecret).update(value).digest('base64url');
export function createToken(user) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export function decodeToken(token) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('Invalid token');
  const [header, payload, signature, extra] = token.split('.');
  if (!header || !payload || !signature || extra) throw new Error('Invalid token');
  const algorithm = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  if (algorithm.alg !== 'HS256') throw new Error('Invalid algorithm');
  const expected = Buffer.from(sign(`${header}.${payload}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid signature');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!Number.isFinite(data.exp) || data.exp <= Date.now() / 1000 || !/^[0-9a-f-]{36}$/i.test(data.sub)) throw new Error('Expired token');
  return data;
}

export async function requireAuth(req, res, next) {
  const authorization = req.get('authorization');
  const queryAllowed = req.method === 'GET' && /\/(events|download)$/.test(req.path);
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : queryAllowed ? req.query.token : undefined;
  try {
    const payload = decodeToken(token);
    const { rows } = await query('SELECT id,name,email,role FROM users WHERE id=$1', [payload.sub]);
    if (!rows[0]) throw new Error('Account missing');
    req.user = rows[0];
    next();
  } catch (error) {
    if (error.code?.startsWith('08') || error.code === 'ECONNREFUSED') return next(error);
    res.status(401).json({ error: 'Увійдіть у свій обліковий запис.' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Ця сторінка доступна адміністратору.' });
  next();
}
