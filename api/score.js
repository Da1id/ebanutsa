// Vercel serverless function: глобальный рейтинг для Telegram Mini App.
// GET  /api/score            -> { top: [{name, time}, ...] }  (топ-3, лучшее время каждого игрока)
// POST /api/score            -> { time, initData } -> сохраняет лучшее время, возвращает { ok, best, rank }
//
// Нужны переменные окружения:
//   BOT_TOKEN                      — токен бота из BotFather (для проверки initData)
//   UPSTASH_REDIS_REST_URL/TOKEN   — или KV_REST_API_URL/TOKEN (создаются при подключении Upstash Redis в Vercel)

const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const BOT_TOKEN = process.env.BOT_TOKEN;

const LB_KEY = 'cr:lb';        // sorted set: member = telegram user id, score = лучшее время (сек)
const NAMES_KEY = 'cr:names';  // hash: user id -> отображаемое имя
const MIN_TIME = 1.5;          // быстрее физически невозможно — отбрасываем
const MAX_TIME = 3600;
const MAX_AGE_SEC = 24 * 3600; // initData не старше суток

async function redis(commands) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const out = await r.json();
  return out.map((x) => {
    if (x.error) throw new Error('redis: ' + x.error);
    return x.result;
  });
}

function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string' || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return user && user.id ? user : null;
  } catch (_) {
    return null;
  }
}

function displayName(user) {
  const raw = user.username ? '@' + user.username : [user.first_name, user.last_name].filter(Boolean).join(' ');
  return (raw || 'PLAYER').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'PLAYER';
}

// Маскировка имени для публичного списка: @davidmccall -> @dav***, Иван Петров -> Ив*** Пе***
function maskName(name) {
  const at = name.startsWith('@') ? '@' : '';
  const words = name.slice(at.length).split(/\s+/).filter(Boolean);
  const masked = words.map((w) => {
    const chars = Array.from(w);
    const keep = chars.length >= 6 ? 3 : chars.length >= 3 ? 2 : 1;
    return chars.slice(0, keep).join('') + '***';
  });
  return at + (masked.join(' ') || 'PLA***');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'database not configured' });

  try {
    if (req.method === 'GET') {
      const [flat] = await redis([['ZRANGE', LB_KEY, 0, 2, 'WITHSCORES']]);
      const ids = [];
      const scores = [];
      for (let i = 0; i < flat.length; i += 2) {
        ids.push(flat[i]);
        scores.push(Number(flat[i + 1]));
      }
      let names = [];
      if (ids.length) [names] = await redis([['HMGET', NAMES_KEY, ...ids]]);
      const top = ids.map((id, i) => ({ name: maskName((names && names[i]) || 'PLAYER'), time: scores[i] }));
      return res.status(200).json({ top });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const user = verifyInitData(body.initData);
      if (!user) return res.status(401).json({ error: 'invalid telegram auth' });
      const time = Math.round(Number(body.time) * 100) / 100;
      if (!Number.isFinite(time) || time < MIN_TIME || time > MAX_TIME) {
        return res.status(400).json({ error: 'invalid time' });
      }
      const id = String(user.id);
      // LT: обновляем только если новое время лучше (меньше) сохранённого
      await redis([
        ['ZADD', LB_KEY, 'LT', time, id],
        ['HSET', NAMES_KEY, id, displayName(user)],
      ]);
      const [best, rank] = await redis([['ZSCORE', LB_KEY, id], ['ZRANK', LB_KEY, id]]);
      return res.status(200).json({ ok: true, best: Number(best), rank: Number(rank) + 1 });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
