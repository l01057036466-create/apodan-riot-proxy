// ═══════════════════════════════════════════════════════════════
// 아포단 내전실록 — 실시간 댓글 API
// 위치: 저장소 api/comments.js  (bank.js · vote.js 옆)
// 필요 환경변수: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  ← bank.js와 동일 (추가 설정 X)
// 저장 구조:
//   cmt:<board>   = Redis LIST, 각 항목 JSON {id,nick,text,ts,parent,uid}
//   cmtL:<board>  = Redis HASH, field=댓글id value=좋아요수
//   board 예: 라인업은 라인업ID, 경기결과는 "m:"+경기ID
// 누구나(닉네임만) 작성 가능. 토큰(은행 세션)이 있으면 작성자 표식만 부가.
// ═══════════════════════════════════════════════════════════════
var crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    function cleanEnv(v) {
      v = String(v || '').trim();
      v = v.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '').replace(/^["']+|["']+$/g, '');
      return v.trim();
    }
    var URL_ = cleanEnv(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, '');
    var TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
    if (URL_ && !/^https:\/\//.test(URL_)) URL_ = 'https://' + URL_;
    if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Upstash 환경변수가 없어요' });

    async function redis(cmd) {
      var r = await fetch(URL_ + '/' + cmd.map(encodeURIComponent).join('/'), {
        headers: { Authorization: 'Bearer ' + TOKEN },
      });
      var j = await r.json();
      if (j && j.error) throw new Error('Upstash: ' + j.error);
      return j ? j.result : null;
    }
    // 본문 파싱 (Vercel은 보통 req.body 제공, 혹시 문자열이면 직접 파싱)
    var body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    var q = req.query || {};
    var action = String(q.action || body.action || '').trim();

    function boardOk(b) { b = String(b || '').trim(); return /^[A-Za-z0-9:_\-]{1,80}$/.test(b) ? b : null; }
    function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.slice(0, n); }
    function idOk(s) { s = String(s || '').trim(); return /^[A-Za-z0-9:_\-|.]{1,80}$/.test(s) ? s : ''; }
    var SEC60 = String(60 * 60 * 24 * 60); // 댓글 보관 60일

    // 닉/본문 안전성: 제어문자 제거 + 길이 제한
    function safeNick(n) { n = clip(n, 20); n = n.replace(/[\u0000-\u001f]/g, ''); return n || '익명'; }
    function safeText(t) { t = clip(t, 300); t = t.replace(/[\u0000-\u001f]/g, ''); return t; }

    // 로그인 세션 토큰 → 작성자 정보 {nick, uid, role} | null  (bank.js 세션과 동일 구조)
    async function whoami(token) {
      token = String(token || '').trim();
      if (!token) return null;
      var v;
      try { v = await redis(['GET', 'sess:' + token]); } catch (e) { return null; }
      if (!v) return null;
      if (v === '__dev__') return { nick: '운영자', uid: 'dev', role: 'dev' };
      var raw;
      try { raw = await redis(['GET', 'acct:' + v]); } catch (e) { return null; }
      if (!raw) return null;
      var a; try { a = JSON.parse(raw); } catch (e) { return null; }
      if (!a || a.status !== 'active') return null;
      return { nick: a.name || v, uid: crypto.createHash('sha256').update('u|' + v).digest('hex').slice(0, 12), role: a.role || 'member' };
    }

    // ── 목록 ──
    if (action === 'list') {
      var board = boardOk(q.board || body.board);
      if (!board) return res.status(400).json({ error: 'board 형식 오류' });
      var raw = await redis(['LRANGE', 'cmt:' + board, '0', '799']) || [];
      var likeArr = await redis(['HGETALL', 'cmtL:' + board]) || [];
      var likes = {};
      for (var i = 0; i + 1 < likeArr.length; i += 2) likes[likeArr[i]] = parseInt(likeArr[i + 1], 10) || 0;
      var out = [];
      for (var k = 0; k < raw.length; k++) {
        try {
          var c = JSON.parse(raw[k]);
          c.like = likes[c.id] || 0;
          out.push(c);
        } catch (e) {}
      }
      // 오래된 것부터(작성순) 정렬해서 내려줌
      out.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      return res.status(200).json({ comments: out });
    }

    // ── 작성 (로그인 필수) ──
    if (action === 'add') {
      var board2 = boardOk(body.board);
      if (!board2) return res.status(400).json({ error: 'board 형식 오류' });
      var who = await whoami(body.token);
      if (!who) return res.status(401).json({ error: '로그인 후 댓글을 달 수 있어요' });
      var text = safeText(body.text);
      var parent = idOk(body.parent);
      if (!text) return res.status(400).json({ error: '내용을 입력해주세요' });

      // 가벼운 도배 방지: 같은 작성자(uid) 2초 쿨다운
      var cdKey = 'cmtcd:' + who.uid + ':' + board2;
      var cd = await redis(['SET', cdKey, '1', 'NX', 'EX', '2']);
      if (cd === null) return res.status(429).json({ error: '너무 빨라요 — 잠깐 뒤에 다시 ㅎㅎ' });

      // 보드당 최대 800개 (LTRIM으로 유지). 작성자는 로그인 계정명 고정 (사칭 방지)
      var id = 'u' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      var item = { id: id, nick: who.nick, text: text, ts: Date.now(), parent: parent, uid: who.uid };
      await redis(['RPUSH', 'cmt:' + board2, JSON.stringify(item)]);
      await redis(['LTRIM', 'cmt:' + board2, '-800', '-1']);
      await redis(['EXPIRE', 'cmt:' + board2, SEC60]);
      item.like = 0;
      return res.status(200).json({ comment: item });
    }

    // ── 좋아요(추천) — 로그인 필수 ──
    if (action === 'like') {
      var board3 = boardOk(body.board);
      var cid = idOk(body.id);
      if (!board3 || !cid) return res.status(400).json({ error: '요청 형식 오류' });
      var meLike = await whoami(body.token);
      if (!meLike) return res.status(401).json({ error: '로그인 후 추천할 수 있어요' });
      var n = await redis(['HINCRBY', 'cmtL:' + board3, cid, '1']);
      await redis(['EXPIRE', 'cmtL:' + board3, SEC60]);
      return res.status(200).json({ id: cid, like: parseInt(n, 10) || 0 });
    }

    // ── 삭제 (작성자 uid 일치 또는 dev) ──
    if (action === 'del') {
      var board4 = boardOk(body.board);
      var did = idOk(body.id);
      if (!board4 || !did) return res.status(400).json({ error: '요청 형식 오류' });
      var me = await whoami(body.token);
      if (!me) return res.status(401).json({ error: '로그인이 필요해요' });
      var list = await redis(['LRANGE', 'cmt:' + board4, '0', '799']) || [];
      var target = null;
      for (var j = 0; j < list.length; j++) { try { var cc = JSON.parse(list[j]); if (cc.id === did) { target = { raw: list[j], c: cc }; break; } } catch (e) {} }
      if (!target) return res.status(404).json({ error: '댓글을 찾을 수 없어요' });
      if (me.role !== 'dev' && me.uid !== target.c.uid) return res.status(403).json({ error: '본인 댓글만 지울 수 있어요' });
      await redis(['LREM', 'cmt:' + board4, '1', target.raw]);
      return res.status(200).json({ ok: true, id: did });
    }

    return res.status(400).json({ error: '알 수 없는 action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
