// 아포단 유저 배당 투표 API — 기존 apodan-riot-proxy 저장소의 api/ 폴더에 vote.js로 추가
// 저장소 구조: api/riot.js (기존) + api/vote.js (이 파일)
// 필요한 것: 무료 Upstash Redis (가이드는 채팅 참고). Vercel 환경변수 2개:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const URL_ = process.env.UPSTASH_REDIS_REST_URL;
  const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Upstash 환경변수가 없어요 (UPSTASH_REDIS_REST_URL / TOKEN)' });

  const redis = async (...cmd) => {
    const r = await fetch(`${URL_}/${cmd.map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return (await r.json()).result;
  };

  const safeDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

  if (req.method === 'GET') {
    const { date } = req.query;
    if (!safeDate(date)) return res.status(400).json({ error: 'date 형식: YYYY-MM-DD' });
    const [alpha, beta] = await Promise.all([
      redis('GET', `vote:${date}:alpha`),
      redis('GET', `vote:${date}:beta`),
    ]);
    return res.status(200).json({ date, alpha: Number(alpha) || 0, beta: Number(beta) || 0 });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { date, team, key } = body || {};
    if (!safeDate(date)) return res.status(400).json({ error: 'date 형식: YYYY-MM-DD' });
    if (!['alpha', 'beta'].includes(team)) return res.status(400).json({ error: 'team은 alpha 또는 beta' });
    if (!key || String(key).length < 8 || String(key).length > 64) return res.status(400).json({ error: 'key 필요' });

    // 기기 키 기준 1인 1표: 이미 투표했으면 거절 (90일 보관)
    const first = await redis('SET', `vote:${date}:key:${key}`, team, 'NX', 'EX', 60 * 60 * 24 * 90);
    if (first !== 'OK') {
      const prev = await redis('GET', `vote:${date}:key:${key}`);
      return res.status(409).json({ error: '이미 투표했어요', myVote: prev });
    }
    const count = await redis('INCR', `vote:${date}:${team}`);
    await redis('EXPIRE', `vote:${date}:${team}`, 60 * 60 * 24 * 90);
    return res.status(200).json({ ok: true, team, count: Number(count) });
  }

  return res.status(405).json({ error: 'GET 또는 POST만' });
}
