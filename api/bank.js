// ═══════════════════════════════════════════════════════════════
// 아포단 거래소(APEX) 은행 API — v2: 계정·승인·권한·지갑 + 승부 예측 베팅(패리뮤추얼)
// 위치: 저장소 api/bank.js  (vote.js 옆)
// 필요 환경변수: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//               BANK_DEV_CODE  ← 개발자 마스터 코드 (주형만 아는 비밀번호, 새로 추가!)
// 권한: dev(유령 세션, 목록에 안 나옴) > admin > member
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
    var DEV_CODE = cleanEnv(process.env.BANK_DEV_CODE);
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

    var SEC90 = String(60 * 60 * 24 * 90), SEC30 = String(60 * 60 * 24 * 30);
    function hash(pin, salt) { return crypto.createHash('sha256').update(salt + '|' + pin).digest('hex'); }
    function kstDate() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
    function nameOk(n) { n = String(n || '').trim(); return n.length >= 1 && n.length <= 24 ? n : null; }
    function pinOk(p) { return /^\d{4,8}$/.test(String(p || '')); }

    async function getAcct(name) {
      var raw = await redis(['GET', 'acct:' + name]);
      return raw ? JSON.parse(raw) : null;
    }
    async function putAcct(a) { await redis(['SET', 'acct:' + a.name, JSON.stringify(a)]); }
    async function ledger(name, d, v, bal) {
      var e = JSON.stringify({ t: new Date().toISOString(), d: d, v: v, bal: bal });
      await redis(['LPUSH', 'ledger:' + name, e]);
      await redis(['LTRIM', 'ledger:' + name, '0', '199']);
    }
    async function auth(token) { // 세션 → {role, name} | null
      if (!token) return null;
      var v = await redis(['GET', 'sess:' + token]);
      if (!v) return null;
      if (v === '__dev__') return { role: 'dev', name: null }; // 유령 개발자
      var a = await getAcct(v);
      if (!a || a.status !== 'active') return null;
      return { role: a.role || 'member', name: a.name, acct: a };
    }
    function tok() { return crypto.randomBytes(24).toString('hex'); }

    var q = req.query || {};
    var body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    var action = String(q.action || body.action || '');

    // ── 공개: 부자 랭킹 (포인트는 모두에게 보인다!) ──
    if (req.method === 'GET' && action === 'roster') {
      var names = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      var out = [];
      for (var i = 0; i < names.length; i++) {
        var a = await getAcct(names[i]);
        if (a && a.status === 'active') out.push({ name: a.name, bal: a.bal, role: a.role === 'admin' ? 'admin' : 'member', bust: a.bust || 0 });
      }
      out.sort(function (x, y) { return y.bal - x.bal; });
      return res.status(200).json({ roster: out });
    }

    // ── 가입 신청 ──
    if (req.method === 'POST' && action === 'register') {
      var name = nameOk(body.name), pin = body.pin;
      if (!name) return res.status(400).json({ error: '이름을 확인해주세요' });
      if (!pinOk(pin)) return res.status(400).json({ error: '비밀번호는 숫자 4~8자리' });
      if (await getAcct(name)) return res.status(409).json({ error: '이미 신청·가입된 이름이에요' });
      var salt = crypto.randomBytes(8).toString('hex');
      var acct = { name: name, salt: salt, pin: hash(pin, salt), role: 'member', status: 'pending', bal: 0, bust: 0, created: new Date().toISOString(), lastDaily: '' };
      await putAcct(acct);
      await redis(['SADD', 'acct:_all', name]);
      return res.status(200).json({ ok: true, status: 'pending' });
    }

    // ── 로그인 (개발자 마스터 코드 = 유령 세션) ──
    if (req.method === 'POST' && action === 'login') {
      var pin2 = String(body.pin || '');
      if (DEV_CODE && pin2 === DEV_CODE) { // 이름 무관, 마스터 코드면 개발자
        var t0 = tok();
        await redis(['SET', 'sess:' + t0, '__dev__', 'EX', SEC30]);
        return res.status(200).json({ ok: true, token: t0, role: 'dev', name: '시스템' });
      }
      var name2 = nameOk(body.name);
      var a2 = name2 ? await getAcct(name2) : null;
      if (!a2 || hash(pin2, a2.salt) !== a2.pin) return res.status(401).json({ error: '이름 또는 비밀번호가 달라요' });
      if (a2.status === 'pending') return res.status(403).json({ error: '아직 승인 대기 중이에요 — 운영자 승인을 기다려주세요' });
      if (a2.status === 'frozen') return res.status(403).json({ error: '계좌가 동결 상태예요 (휴면/외출)' });
      var t1 = tok();
      await redis(['SET', 'sess:' + t1, a2.name, 'EX', SEC30]);
      return res.status(200).json({ ok: true, token: t1, role: a2.role || 'member', name: a2.name });
    }

    // ── 내 정보 (+출석 수당 200/일 자동 지급) ──
    if (req.method === 'GET' && action === 'me') {
      var s = await auth(q.token);
      if (!s) return res.status(401).json({ error: '세션 만료 — 다시 로그인해주세요' });
      if (s.role === 'dev') return res.status(200).json({ name: '시스템', role: 'dev', bal: null });
      var a3 = s.acct, today = kstDate();
      if (a3.lastDaily !== today) {
        a3.lastDaily = today; a3.bal += 200;
        await putAcct(a3);
        await ledger(a3.name, '출석 수당 ☀', 200, a3.bal);
      }
      var led = (await redis(['LRANGE', 'ledger:' + a3.name, '0', '29'])) || [];
      return res.status(200).json({ name: a3.name, role: a3.role, bal: a3.bal, bust: a3.bust || 0, ledger: led.map(function (x) { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
    }

    // ── 운영자/개발자: 승인 대기 목록 ──
    if (req.method === 'GET' && action === 'pending') {
      var s2 = await auth(q.token);
      if (!s2 || (s2.role !== 'admin' && s2.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var names2 = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      var pend = [];
      for (var k = 0; k < names2.length; k++) {
        var p = await getAcct(names2[k]);
        if (p && p.status === 'pending') pend.push({ name: p.name, created: p.created });
      }
      return res.status(200).json({ pending: pend });
    }

    // ── 운영자/개발자: 승인 / 거절 / 동결 / 해동 ──
    if (req.method === 'POST' && ['approve', 'reject', 'freeze', 'unfreeze'].indexOf(action) >= 0) {
      var s3 = await auth(body.token);
      if (!s3 || (s3.role !== 'admin' && s3.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var tn = nameOk(body.name);
      var ta = tn ? await getAcct(tn) : null;
      if (!ta) return res.status(404).json({ error: '계정을 못 찾았어요' });
      if (action === 'approve') {
        if (ta.status !== 'pending') return res.status(400).json({ error: '대기 상태가 아니에요' });
        ta.status = 'active'; ta.bal = 10000;
        await putAcct(ta);
        await ledger(ta.name, '🎉 가입 축하 자본금', 10000, ta.bal);
        return res.status(200).json({ ok: true });
      }
      if (action === 'reject') {
        await redis(['DEL', 'acct:' + ta.name]);
        await redis(['SREM', 'acct:_all', ta.name]);
        return res.status(200).json({ ok: true });
      }
      ta.status = action === 'freeze' ? 'frozen' : 'active';
      await putAcct(ta);
      return res.status(200).json({ ok: true, status: ta.status });
    }

    // ── 개발자 전용: 운영자 임명/해임 + 포인트 발권 (전부 "시스템" 명의) ──
    if (req.method === 'POST' && ['promote', 'demote', 'mint'].indexOf(action) >= 0) {
      var s4 = await auth(body.token);
      if (!s4 || s4.role !== 'dev') return res.status(403).json({ error: '권한 없음' }); // 운영자에게도 숨김
      var tn2 = nameOk(body.name);
      var ta2 = tn2 ? await getAcct(tn2) : null;
      if (!ta2) return res.status(404).json({ error: '계정을 못 찾았어요' });
      if (action === 'promote') { ta2.role = 'admin'; await putAcct(ta2); return res.status(200).json({ ok: true }); }
      if (action === 'demote') { ta2.role = 'member'; await putAcct(ta2); return res.status(200).json({ ok: true }); }
      var amt = Math.round(Number(body.amount) || 0);
      if (!amt || Math.abs(amt) > 1000000) return res.status(400).json({ error: '금액 확인 (±100만 이내)' });
      ta2.bal = Math.max(0, ta2.bal + amt);
      await putAcct(ta2);
      await ledger(ta2.name, amt > 0 ? '시스템 지급' : '시스템 회수', amt, ta2.bal);
      return res.status(200).json({ ok: true, bal: ta2.bal });
    }

    // ═══════════ Phase 2: 승부 예측 베팅 (패리뮤추얼) ═══════════
    function mktOk(m) { return /^\d{4}-\d{2}-\d{2}(#[A-Za-z0-9]{1,4})?$/.test(String(m || '')); }
    async function busted(a) { // 파산 구제: 0 APO → 새출발 지원금 1,000 + 파산 박제
      if (a.bal > 0) return a;
      a.bust = (a.bust || 0) + 1; a.bal = 1000;
      await putAcct(a);
      await ledger(a.name, '💀 파산 ' + a.bust + '호 → 새출발 지원금', 1000, a.bal);
      return a;
    }

    // 판 상태 조회 (공개 — 토큰 있으면 내 베팅 포함)
    if (req.method === 'GET' && action === 'market') {
      var mk = String(q.market || '');
      if (!mktOk(mk)) return res.status(400).json({ error: 'market 형식 오류' });
      var st = (await redis(['GET', 'mkt:' + mk + ':status'])) || 'open';
      var pa = Number(await redis(['GET', 'mkt:' + mk + ':pool:alpha'])) || 0;
      var pb = Number(await redis(['GET', 'mkt:' + mk + ':pool:beta'])) || 0;
      var cnt = Number(await redis(['SCARD', 'mkt:' + mk + ':bettors'])) || 0;
      var my = null;
      var sM = await auth(q.token);
      if (sM && sM.name) {
        var raw = await redis(['GET', 'bet:' + mk + ':' + sM.name]);
        if (raw) my = JSON.parse(raw);
      }
      return res.status(200).json({ market: mk, status: st, alpha: pa, beta: pb, bettors: cnt, my: my });
    }

    // 베팅 (올인 허용 🚨)
    if (req.method === 'POST' && action === 'bet') {
      var sB = await auth(body.token);
      if (!sB || !sB.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var mk2 = String(body.market || ''), team2 = body.team;
      var amt2 = Math.round(Number(body.amount) || 0);
      if (!mktOk(mk2)) return res.status(400).json({ error: 'market 형식 오류' });
      if (team2 !== 'alpha' && team2 !== 'beta') return res.status(400).json({ error: 'team은 alpha/beta' });
      if (amt2 < 100) return res.status(400).json({ error: '최소 베팅 100 APO' });
      var st2 = (await redis(['GET', 'mkt:' + mk2 + ':status'])) || 'open';
      if (st2 !== 'open') return res.status(403).json({ error: st2.indexOf('settled') === 0 ? '이미 정산된 판이에요' : '베팅이 마감됐어요' });
      var aB = sB.acct;
      if (aB.bal < amt2) return res.status(400).json({ error: '잔액 부족 (보유 ' + aB.bal + ' APO)' });
      var prevRaw = await redis(['GET', 'bet:' + mk2 + ':' + aB.name]);
      var prev = prevRaw ? JSON.parse(prevRaw) : null;
      if (prev && prev.team !== team2) return res.status(409).json({ error: '이미 ' + (prev.team === 'alpha' ? '알파' : '베타') + '에 베팅했어요 — 팀 변경 불가, 추가 베팅만 가능' });
      aB.bal -= amt2;
      var allin = aB.bal === 0;
      await putAcct(aB);
      await ledger(aB.name, (allin ? '🚨 올인! ' : '🎰 ') + '베팅: ' + (team2 === 'alpha' ? '알파' : '베타') + ' 승리', -amt2, aB.bal);
      var newBet = { team: team2, amt: (prev ? prev.amt : 0) + amt2, t: new Date().toISOString(), allin: allin || (prev && prev.allin) || false };
      await redis(['SET', 'bet:' + mk2 + ':' + aB.name, JSON.stringify(newBet), 'EX', SEC90]);
      await redis(['SADD', 'mkt:' + mk2 + ':bettors', aB.name]);
      await redis(['INCRBY', 'mkt:' + mk2 + ':pool:' + team2, String(amt2)]);
      await redis(['EXPIRE', 'mkt:' + mk2 + ':pool:' + team2, SEC90]);
      await redis(['EXPIRE', 'mkt:' + mk2 + ':bettors', SEC90]);
      aB = await busted(aB);
      return res.status(200).json({ ok: true, bal: aB.bal, bet: newBet, allin: allin });
    }

    // 마감/재개 (운영자·개발자)
    if (req.method === 'POST' && action === 'lock') {
      var sL = await auth(body.token);
      if (!sL || (sL.role !== 'admin' && sL.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var mk3 = String(body.market || '');
      if (!mktOk(mk3)) return res.status(400).json({ error: 'market 형식 오류' });
      var cur = (await redis(['GET', 'mkt:' + mk3 + ':status'])) || 'open';
      if (cur.indexOf('settled') === 0) return res.status(400).json({ error: '이미 정산된 판' });
      var next = body.open ? 'open' : 'locked';
      await redis(['SET', 'mkt:' + mk3 + ':status', next, 'EX', SEC90]);
      return res.status(200).json({ ok: true, status: next });
    }

    // 정산 (패리뮤추얼: 패자 풀을 승자가 지분대로, 수수료 3%)
    if (req.method === 'POST' && action === 'settle') {
      var sS = await auth(body.token);
      if (!sS || (sS.role !== 'admin' && sS.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var mk4 = String(body.market || ''), win = body.winner;
      if (!mktOk(mk4)) return res.status(400).json({ error: 'market 형식 오류' });
      if (win !== 'alpha' && win !== 'beta') return res.status(400).json({ error: 'winner는 alpha/beta' });
      var cur2 = (await redis(['GET', 'mkt:' + mk4 + ':status'])) || 'open';
      if (cur2.indexOf('settled') === 0) return res.status(400).json({ error: '이미 정산됐어요' });
      var WP = Number(await redis(['GET', 'mkt:' + mk4 + ':pool:' + win])) || 0;
      var lose = win === 'alpha' ? 'beta' : 'alpha';
      var LP = Number(await redis(['GET', 'mkt:' + mk4 + ':pool:' + lose])) || 0;
      var prize = Math.floor(LP * 0.97); // 3% 수수료 싱크
      var names3 = (await redis(['SMEMBERS', 'mkt:' + mk4 + ':bettors'])) || [];
      var paid = 0, winners = 0;
      for (var w = 0; w < names3.length; w++) {
        var bRaw = await redis(['GET', 'bet:' + mk4 + ':' + names3[w]]);
        if (!bRaw) continue;
        var bb = JSON.parse(bRaw);
        var acc = await getAcct(names3[w]);
        if (!acc) continue;
        if (bb.team === win) {
          var share = WP > 0 ? Math.floor(bb.amt + (bb.amt / WP) * prize) : bb.amt;
          acc.bal += share; winners++; paid += share;
          await putAcct(acc);
          await ledger(acc.name, '🎉 예측 적중! (' + (win === 'alpha' ? '알파' : '베타') + ' 승)', share, acc.bal);
        } else {
          await ledger(acc.name, '😭 예측 빗나감 (' + (win === 'alpha' ? '알파' : '베타') + ' 승)', 0, acc.bal);
        }
      }
      await redis(['SET', 'mkt:' + mk4 + ':status', 'settled:' + win, 'EX', SEC90]);
      return res.status(200).json({ ok: true, winner: win, winners: winners, paidOut: paid, fee: LP - prize });
    }

    return res.status(400).json({ error: '알 수 없는 요청: ' + action });
  } catch (e) {
    return res.status(500).json({ error: '서버 오류: ' + (e && e.message ? e.message : String(e)) });
  }
};
