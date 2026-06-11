// ═══════════════════════════════════════════════════════════════
// 아포단 거래소(APEX) 은행 API — v3: 계정·베팅 + 멤버 주식 거래소 + 내전 참여 수당
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
        if (a && a.status === 'active') out.push({ name: a.name, bal: a.bal, role: a.role === 'admin' ? 'admin' : 'member', bust: a.bust || 0, lastBustAt: a.lastBustAt || '' });
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
      var hRawMe = await redis(['GET', 'hold:' + a3.name]);
      var pxRawMe = await redis(['GET', 'stock:px']);
      return res.status(200).json({ name: a3.name, role: a3.role, bal: a3.bal, bust: a3.bust || 0,
        holdings: hRawMe ? JSON.parse(hRawMe) : {}, prices: pxRawMe ? JSON.parse(pxRawMe) : {},
        ledger: led.map(function (x) { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
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
    async function busted(a) { // 파산: 박제 + 구제는 하루 1회만 (무한 셔틀 금지)
      if (a.bal > 0) return a;
      a.bust = (a.bust || 0) + 1;
      a.lastBustAt = new Date().toISOString();
      var today = kstDate();
      if (a.lastBustDay !== today) { // 오늘 첫 파산 → 새출발 지원금
        a.lastBustDay = today; a.bal = 1000;
        await putAcct(a);
        await ledger(a.name, '💀 파산 ' + a.bust + '호 → 새출발 지원금 (1일 1회)', 1000, a.bal);
      } else { // 오늘 두 번째 파산 → 무일푼. 내일 출석 수당으로 재기
        await putAcct(a);
        await ledger(a.name, '💀💀 같은 날 ' + a.bust + '호 파산 — 지원금 소진, 내일까지 무일푼', 0, 0);
      }
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

    // ═══════════ Phase 3: 멤버 주식 + 참여 수당 ═══════════
    // 공시 시세 (운영진 클라이언트가 게시 때마다 자동 푸시)
    if (req.method === 'POST' && action === 'setPrices') {
      var sP = await auth(body.token);
      if (!sP || (sP.role !== 'admin' && sP.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var pr = body.prices;
      if (!pr || typeof pr !== 'object') return res.status(400).json({ error: 'prices 필요' });
      var clean = {};
      Object.keys(pr).slice(0, 200).forEach(function (k) {
        var v = Math.round(Number(pr[k]) || 0);
        if (v >= 10 && v <= 100000 && String(k).length <= 24) clean[k] = v;
      });
      await redis(['SET', 'stk:prices', JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, count: Object.keys(clean).length });
    }
    if (req.method === 'GET' && action === 'prices') {
      var raw0 = await redis(['GET', 'stk:prices']);
      return res.status(200).json({ prices: raw0 ? JSON.parse(raw0) : {} });
    }

    // 매수/매도 (거래세 1% — 인플레 싱크)
    if (req.method === 'POST' && action === 'trade') {
      var sT = await auth(body.token);
      if (!sT || !sT.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var side = body.side, target = nameOk(body.target);
      var qty = Math.round(Number(body.qty) || 0);
      if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'side는 buy/sell' });
      if (!target) return res.status(400).json({ error: '종목(멤버) 이름 필요' });
      if (qty < 1 || qty > 10000) return res.status(400).json({ error: '수량 1~10000' });
      var rawP = await redis(['GET', 'stk:prices']);
      var prices = rawP ? JSON.parse(rawP) : {};
      var px = Number(prices[target]) || 0;
      if (!px) return res.status(404).json({ error: '아직 시세가 없는 종목이에요 (운영진 게시 후 갱신)' });
      var aT = sT.acct;
      var rawH = await redis(['GET', 'hold:' + aT.name]);
      var hold = rawH ? JSON.parse(rawH) : {};
      var h = hold[target] || { sh: 0, cost: 0 };
      if (side === 'buy') {
        var costGross = Math.ceil(px * qty * 1.01);
        if (aT.bal < costGross) return res.status(400).json({ error: '잔액 부족 (필요 ' + costGross + ' APO, 세금 1% 포함)' });
        aT.bal -= costGross;
        h.sh += qty; h.cost += costGross;
        hold[target] = h;
        await putAcct(aT);
        await redis(['SET', 'hold:' + aT.name, JSON.stringify(hold)]);
        await ledger(aT.name, '📈 매수: ' + target + ' ' + qty + '주 @' + px, -costGross, aT.bal);
        return res.status(200).json({ ok: true, bal: aT.bal, hold: h, price: px });
      } else {
        if (h.sh < qty) return res.status(400).json({ error: '보유 ' + h.sh + '주뿐이에요' });
        var proceeds = Math.floor(px * qty * 0.99);
        var avg = h.sh ? h.cost / h.sh : 0;
        h.cost = Math.max(0, Math.round(h.cost - avg * qty));
        h.sh -= qty;
        if (h.sh === 0) { h.cost = 0; delete hold[target]; } else hold[target] = h;
        aT.bal += proceeds;
        await putAcct(aT);
        await redis(['SET', 'hold:' + aT.name, JSON.stringify(hold)]);
        await ledger(aT.name, '📉 매도: ' + target + ' ' + qty + '주 @' + px, proceeds, aT.bal);
        aT = await busted(aT);
        return res.status(200).json({ ok: true, bal: aT.bal, hold: hold[target] || { sh: 0, cost: 0 }, price: px });
      }
    }

    // 내 포트폴리오 (공개 조회 허용: name 파라미터 — 포인트는 명예다!)
    if (req.method === 'GET' && action === 'portfolio') {
      var who = nameOk(q.name);
      if (!who) { var sPf = await auth(q.token); if (!sPf || !sPf.name) return res.status(401).json({ error: '이름 또는 로그인 필요' }); who = sPf.name; }
      var rawH2 = await redis(['GET', 'hold:' + who]);
      var rawP2 = await redis(['GET', 'stk:prices']);
      return res.status(200).json({ name: who, hold: rawH2 ? JSON.parse(rawH2) : {}, prices: rawP2 ? JSON.parse(rawP2) : {} });
    }

    // 참여 수당 일괄 지급 (운영진·개발자 — 클라이언트가 게시 직후 자동 호출)
    if (req.method === 'POST' && action === 'reward') {
      var sR = await auth(body.token);
      if (!sR || (sR.role !== 'admin' && sR.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var gs = Array.isArray(body.grants) ? body.grants.slice(0, 100) : [];
      var paidN = 0, skipped = [];
      for (var g = 0; g < gs.length; g++) {
        var gn = nameOk(gs[g].name);
        var ga = Math.round(Number(gs[g].amount) || 0);
        if (!gn || ga < 1 || ga > 100000) continue;
        var acc2 = await getAcct(gn);
        if (!acc2 || acc2.status !== 'active') { skipped.push(gn || '?'); continue; }
        acc2.bal += ga;
        await putAcct(acc2);
        await ledger(acc2.name, String(gs[g].memo || '🎮 내전 참여 수당').slice(0, 60), ga, acc2.bal);
        paidN++;
      }
      return res.status(200).json({ ok: true, paid: paidN, skipped: skipped });
    }

    // ═══ 내전 참여 수당 (운영진, 날짜당 1인 1회 — 중복 지급 서버 차단) ═══
    if (req.method === 'POST' && action === 'reward') {
      var sR = await auth(body.token);
      if (!sR || (sR.role !== 'admin' && sR.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var rd = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rd)) return res.status(400).json({ error: 'date 형식: YYYY-MM-DD' });
      var amtR = Math.round(Number(body.amount) || 500);
      if (amtR < 100 || amtR > 2000) return res.status(400).json({ error: '수당은 100~2,000 APO' });
      var list = Array.isArray(body.names) ? body.names.slice(0, 60) : [];
      var paidN = 0, skipped = [];
      for (var r2 = 0; r2 < list.length; r2++) {
        var nmR = nameOk(list[r2]); if (!nmR) continue;
        var aR = await getAcct(nmR);
        if (!aR || aR.status !== 'active') { skipped.push(nmR); continue; }
        var fresh = await redis(['SADD', 'reward:' + rd, nmR]); // 이미 받았으면 0
        if (Number(fresh) !== 1) { skipped.push(nmR + '(지급됨)'); continue; }
        await redis(['EXPIRE', 'reward:' + rd, SEC90]);
        aR.bal += amtR;
        await putAcct(aR);
        await ledger(aR.name, '🎮 내전 참여 수당 (' + rd + ')', amtR, aR.bal);
        paidN++;
      }
      return res.status(200).json({ ok: true, paid: paidN, amount: amtR, skipped: skipped });
    }

    // ═══ 멤버 주식: 시세 (운영진 클라이언트가 자동 갱신 — 조작 불가) ═══
    if (req.method === 'GET' && action === 'prices') {
      var pxRaw = await redis(['GET', 'stock:px']);
      return res.status(200).json({ prices: pxRaw ? JSON.parse(pxRaw) : {} });
    }
    if (req.method === 'POST' && action === 'setPrices') {
      var sP = await auth(body.token);
      if (!sP || (sP.role !== 'admin' && sP.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var inP = body.prices && typeof body.prices === 'object' ? body.prices : {};
      var pxRaw2 = await redis(['GET', 'stock:px']);
      var px = pxRaw2 ? JSON.parse(pxRaw2) : {};
      var nP = 0;
      for (var kP in inP) {
        var vP = Math.round(Number(inP[kP]) || 0);
        if (nameOk(kP) && vP >= 10 && vP <= 999) { px[kP] = vP; nP++; }
      }
      await redis(['SET', 'stock:px', JSON.stringify(px)]);
      return res.status(200).json({ ok: true, updated: nP });
    }

    // ═══ 주식 매수/매도 (서버 시세 기준, 수수료 1%) ═══
    if (req.method === 'POST' && (action === 'stockBuy' || action === 'stockSell')) {
      var sT = await auth(body.token);
      if (!sT || !sT.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var tgt = nameOk(body.target), qty = Math.round(Number(body.qty) || 0);
      if (!tgt) return res.status(400).json({ error: '종목(멤버) 이름 확인' });
      if (qty < 1 || qty > 999) return res.status(400).json({ error: '수량은 1~999주' });
      var pxRaw3 = await redis(['GET', 'stock:px']);
      var px2 = pxRaw3 ? JSON.parse(pxRaw3) : {};
      var price = Math.round(Number(px2[tgt]) || 0) || 100; // 시세 미등록 종목은 기본가 100 — 즉시 거래 가능
      var aT = sT.acct;
      var hRaw = await redis(['GET', 'hold:' + aT.name]);
      var hold = hRaw ? JSON.parse(hRaw) : {};
      if (action === 'stockBuy') {
        var base = price * qty;
        var royalty = Math.floor(base * 0.02); // 💸 초상권료 2% → 종목 본인에게
        var cost = Math.ceil(base * 1.01) + royalty; // + 거래소 수수료 1%
        if (aT.bal < cost) return res.status(400).json({ error: '잔액 부족 (' + cost + ' APO 필요 = 대금+수수료1%+초상권료2%)' });
        aT.bal -= cost;
        var cur3 = hold[tgt] || { q: 0, avg: 0 };
        cur3.avg = Math.round((cur3.avg * cur3.q + price * qty) / (cur3.q + qty));
        cur3.q += qty;
        hold[tgt] = cur3;
        await redis(['SET', 'hold:' + aT.name, JSON.stringify(hold)]);
        await putAcct(aT);
        await ledger(aT.name, '📈 매수 ' + tgt + ' ' + qty + '주 @' + price + ' (초상권료 ' + royalty + ' 포함)', -cost, aT.bal);
        var paidRoyalty = 0;
        if (royalty > 0 && tgt !== aT.name) { // 셀프 매수엔 초상권료 없음 (자기가 자기에게 ❌)
          var star = await getAcct(tgt);
          if (star && star.status === 'active') {
            star.bal += royalty; paidRoyalty = royalty;
            await putAcct(star);
            await ledger(star.name, '💸 초상권료 — ' + aT.name + '\uAC00(\uC774) \uB0B4 \uC8FC\uC2DD ' + qty + '\uC8FC \uB9E4\uC218', royalty, star.bal);
          }
        }
        aT = await busted(aT);
        return res.status(200).json({ ok: true, bal: aT.bal, holding: hold[tgt], price: price, royalty: paidRoyalty });
      } else {
        var cur4 = hold[tgt] || { q: 0, avg: 0 };
        if (cur4.q < qty) return res.status(400).json({ error: '보유 ' + cur4.q + '주뿐이에요' });
        var gain = Math.floor(price * qty * 0.99);
        cur4.q -= qty;
        if (cur4.q === 0) delete hold[tgt]; else hold[tgt] = cur4;
        aT.bal += gain;
        await redis(['SET', 'hold:' + aT.name, JSON.stringify(hold)]);
        await putAcct(aT);
        await ledger(aT.name, '📉 매도 ' + tgt + ' ' + qty + '주 @' + price, gain, aT.bal);
        return res.status(200).json({ ok: true, bal: aT.bal, price: price });
      }
    }

    // ═══ 공개 장부: 베팅 현황 (누가 어디에 얼마) ═══
    if (req.method === 'GET' && action === 'bets') {
      var mkB = String(q.market || '');
      if (!mktOk(mkB)) return res.status(400).json({ error: 'market 형식 오류' });
      var bn = (await redis(['SMEMBERS', 'mkt:' + mkB + ':bettors'])) || [];
      var listB = [];
      for (var b2 = 0; b2 < bn.length; b2++) {
        var bRaw2 = await redis(['GET', 'bet:' + mkB + ':' + bn[b2]]);
        if (!bRaw2) continue;
        var bo = JSON.parse(bRaw2);
        listB.push({ name: bn[b2], team: bo.team, amt: bo.amt, allin: !!bo.allin });
      }
      listB.sort(function (x, y) { return y.amt - x.amt; });
      return res.status(200).json({ market: mkB, bets: listB });
    }

    // ═══ 공개 장부: 주주 명부 (누가 누구 주식을 몇 주) ═══
    if (req.method === 'GET' && action === 'holders') {
      var allN = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      var map = {};
      for (var h2 = 0; h2 < allN.length; h2++) {
        var hR = await redis(['GET', 'hold:' + allN[h2]]);
        if (!hR) continue;
        var hh = JSON.parse(hR);
        for (var tgt2 in hh) {
          if (!map[tgt2]) map[tgt2] = [];
          map[tgt2].push({ owner: allN[h2], q: hh[tgt2].q });
        }
      }
      for (var t3 in map) map[t3].sort(function (x, y) { return y.q - x.q; });
      return res.status(200).json({ holders: map });
    }

    return res.status(400).json({ error: '알 수 없는 요청: ' + action });
  } catch (e) {
    return res.status(500).json({ error: '서버 오류: ' + (e && e.message ? e.message : String(e)) });
  }
};
