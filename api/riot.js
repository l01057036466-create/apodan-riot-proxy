// ============================================================
// 아포단 내전실록 — 라이엇 API 중계 서버 (Vercel Serverless Function)
// 파일 위치: api/riot.js  (이 경로 그대로여야 합니다)
// 필수 설정: Vercel 프로젝트 환경변수 RIOT_API_KEY = RGAPI-로 시작하는 키
// 하는 일: 사이트(브라우저)는 라이엇을 직접 못 부르므로,
//          이 함수가 키를 숨긴 채 대신 호출해서 결과만 돌려줍니다.
// ============================================================
const HOST = 'https://asia.api.riotgames.com'; // 한국 계정·경기 라우팅

export default async function handler(req, res) {
  // 어디서 열든(file:// 포함) 사이트가 부를 수 있게 CORS 개방
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const KEY = process.env.RIOT_API_KEY;
  if (!KEY) return res.status(500).json({ error: '서버에 RIOT_API_KEY 환경변수가 설정되지 않았어요.' });

  const q = req.query || {};
  let url;
  if (q.action === 'resolve') {            // 롤닉#태그 → 계정(puuid)
    if (!q.name) return res.status(400).json({ error: 'name이 필요해요.' });
    url = `${HOST}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(q.name)}/${encodeURIComponent(q.tag || 'KR1')}`;
  } else if (q.action === 'ids') {         // puuid → 최근 경기 ID 목록 (queue=0이면 사용자 설정 게임만)
    if (!q.puuid) return res.status(400).json({ error: 'puuid가 필요해요.' });
    const count = Math.min(20, parseInt(q.count || '10', 10) || 10);
    const queue = q.queue !== undefined && q.queue !== '' ? `&queue=${encodeURIComponent(q.queue)}` : '';
    url = `${HOST}/lol/match/v5/matches/by-puuid/${encodeURIComponent(q.puuid)}/ids?start=0&count=${count}${queue}`;
  } else if (q.action === 'match') {       // 경기 ID → 전체 상세 (10명 KDA·딜량·시야·밴 등)
    if (!q.id) return res.status(400).json({ error: 'id가 필요해요.' });
    url = `${HOST}/lol/match/v5/matches/${encodeURIComponent(q.id)}`;
  } else {
    return res.status(400).json({ error: 'action은 resolve / ids / match 중 하나여야 해요.' });
  }

  try {
    const r = await fetch(url, { headers: { 'X-Riot-Token': KEY } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg =
        r.status === 401 || r.status === 403 ? '라이엇 API 키가 만료됐거나 잘못됐어요. 키를 재발급해서 Vercel 환경변수를 갱신해주세요. (' + r.status + ')'
        : r.status === 404 ? '대상을 찾지 못했어요. 롤 닉네임#태그를 확인해주세요. (404)'
        : r.status === 429 ? '요청이 너무 많아요. 1~2분 뒤 다시 시도해주세요. (429)'
        : '라이엇 서버 오류 (' + r.status + ')';
      return res.status(r.status).json({ error: msg });
    }
    if (q.action === 'ids') return res.status(200).json({ ids: body });
    return res.status(200).json(body);
  } catch (e) {
    return res.status(500).json({ error: '중계 서버 오류: ' + e.message });
  }
}
