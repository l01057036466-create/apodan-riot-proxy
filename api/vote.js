// ═══════════════════════════════════════════════════════════════
// 아포단 유저 배당 투표 API — v4 (최종)
// 위치: 저장소 api/vote.js
// 특징: 어떤 Vercel 설정에서도 작동(CommonJS) + 환경변수 자가 치유
//       (KEY="값" 줄 전체를 붙여넣어도 알맹이만 추출) + 회차 키(#2, #A) 지원
// 필요 환경변수: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// ═══════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 환경변수 자가 치유: 'KEY=' 접두, 따옴표, 공백을 알아서 벗겨냄
    function cleanEnv(v) {
      v = String(v || '').trim();
      v = v.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '');
      v = v.replace(/^["']+|["']+$/g, '');
      return v.trim();
    }
    var URL_ = cleanEnv(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, '');
    var TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
    if (URL_ && !/^https:\/\//.test(URL_)) URL_ = 'https://' + URL_;
    if (!URL_ || !TOKEN) {
      return res.status(500).json({ error: 'Upstash 환경변수가 없어요 (UPSTASH_REDIS_REST_URL / TOKEN)' });
    }

    async function redis(cmd) {
      var r = await fetch(URL_ + '/' + cmd.map(encodeURIComponent).join('/'), {
        headers: { Authorization: 'Bearer ' + TOKEN },
      });
      var j = await r.json();
      if (j && j.error) throw new Error('Upstash: ' + j.error);
      return j ? j.result : null;
    }

    // 회차 키 허용: 2026-06-12 또는 2026-06-12#2, 2026-06-12#A
    function safeDate(d) { return /^\d{4}-\d{2}-\d{2}(#[A-Za-z0-9]{1,4})?$/.test(String(d || '')); }

    if (req.method === 'GET') {
      var qd = (req.query && req.query.date) || '';
      if (!safeDate(qd)) return res.status(400).json({ error: 'date 형식: YYYY-MM-DD (#회차 허용)' });
      var alpha = await redis(['GET', 'vote:' + qd + ':alpha']);
      var beta = await redis(['GET', 'vote:' + qd + ':beta']);
      return res.status(200).json({ date: qd, alpha: Number(alpha) || 0, beta: Number(beta) || 0 });
    }

    if (req.method === 'POST') {
      var body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      var date = body.date, team = body.team, key = body.key;
      if (!safeDate(date)) return res.status(400).json({ error: 'date 형식: YYYY-MM-DD (#회차 허용)' });
      if (team !== 'alpha' && team !== 'beta') return res.status(400).json({ error: 'team은 alpha 또는 beta' });
      key = String(key || '');
      if (key.length < 8 || key.length > 64) return res.status(400).json({ error: 'key 필요' });

      // 기기 키 기준 1인 1표 (90일 보관)
      var first = await redis(['SET', 'vote:' + date + ':key:' + key, team, 'NX', 'EX', String(60 * 60 * 24 * 90)]);
      if (first !== 'OK') {
        var prev = await redis(['GET', 'vote:' + date + ':key:' + key]);
        return res.status(409).json({ error: '이미 투표했어요', myVote: prev });
      }
      var count = await redis(['INCR', 'vote:' + date + ':' + team]);
      await redis(['EXPIRE', 'vote:' + date + ':' + team, String(60 * 60 * 24 * 90)]);
      return res.status(200).json({ ok: true, team: team, count: Number(count) });
    }

    return res.status(405).json({ error: 'GET 또는 POST만' });
  } catch (e) {
    return res.status(500).json({ error: '서버 오류: ' + (e && e.message ? e.message : String(e)) });
  }
};
