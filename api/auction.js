// ═══════════════════════════════════════════════════════════════
// 아포단 멸망전 경매 API — bank와 분리된 독립 서버 (같은 Upstash 공유)
// 위치: 저장소 api/auction.js  (bank.js 옆에 둠)
// 필요 환경변수: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (bank와 동일)
// 로그인 세션(sess:TOKEN)을 bank와 공유 → 같은 로그인으로 인증됨
// 관전은 비로그인도 OK · 입찰/운영은 로그인 필요
// ═══════════════════════════════════════════════════════════════
var crypto = require('crypto');

// 🤖 LLM 호출 (무료 Gemini 우선 → 없으면 Claude). 환경변수 GEMINI_API_KEY 또는 ANTHROPIC_API_KEY 필요
async function callLLM(prompt, maxTokens, userKey) {
  var uk = (userKey && /^AIza[0-9A-Za-z_\-]{20,}$/.test(String(userKey).trim())) ? String(userKey).trim() : '';
  var gk = uk || process.env.GEMINI_API_KEY;
  var ak = process.env.ANTHROPIC_API_KEY;
  if (gk) {
    var primary = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
    var gmodels = [primary]; if (gmodels.indexOf('gemini-2.5-flash') < 0) gmodels.push('gemini-2.5-flash'); // 설정 모델이 혼잡(high demand)·빈응답·에러면 안정적인 2.5-flash로 자동 폴백
    var lastErr = '';
    for (var gi = 0; gi < gmodels.length; gi++) {
      var gr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + gmodels[gi] + ':generateContent?key=' + gk, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } })
      });
      var gd = await gr.json();
      if (gr.ok) {
        var gtxt = ((((gd.candidates || [])[0] || {}).content || {}).parts || []).map(function (p) { return p.text || ''; }).join('').trim();
        if (gtxt) return gtxt;
        lastErr = '빈 응답'; continue; // 추론모델이 토큰을 다 써 빈 응답이면 다음 모델로
      }
      lastErr = (gd.error && gd.error.message) || ('HTTP ' + gr.status); // 다음 모델로 폴백
    }
    throw new Error(lastErr || 'Gemini 호출 실패');
  }
  if (ak) {
    var ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ak, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
    });
    var ad = await ar.json();
    if (!ar.ok) throw new Error((ad.error && ad.error.message) || 'Claude 호출 실패');
    return (ad.content || []).map(function (x) { return x.type === 'text' ? x.text : ''; }).join('').trim();
  }
  throw new Error('NOKEY');
}


module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    function cleanEnv(v) { v = String(v || '').trim(); v = v.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '').replace(/^["']+|["']+$/g, ''); return v.trim(); }
    var URL_ = cleanEnv(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, '');
    var TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
    if (URL_ && !/^https:\/\//.test(URL_)) URL_ = 'https://' + URL_;
    if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Upstash 환경변수가 없어요' });

    async function redis(cmd) {
      var r = await fetch(URL_ + '/' + cmd.map(encodeURIComponent).join('/'), { headers: { Authorization: 'Bearer ' + TOKEN } });
      var j = await r.json();
      if (j && j.error) throw new Error('Upstash: ' + j.error);
      return j ? j.result : null;
    }
    // bank가 만든 로그인 세션 공유
    async function auth(token) {
      if (!token) return null;
      var v = await redis(['GET', 'sess:' + token]); if (!v) return null;
      if (v === '__dev__') return { role: 'dev', name: '시스템', rank: '' };
      var raw = await redis(['GET', 'acct:' + v]); if (!raw) return { role: 'member', name: v, rank: '' };
      var a; try { a = JSON.parse(raw); } catch (e) { return { role: 'member', name: v, rank: '' }; }
      return { role: a.role || 'member', name: a.name, rank: a.rank || '' };
    }

    var q = req.query || {}, body = req.body || {};
    var action = String(q.action || body.action || '');
    var token = body.token || q.token || '';

    function isOp(s) { return !!(s && (s.role === 'dev' || s.rank === 'chairman')); }
    async function aucGet() { var r = await redis(['GET', 'doom:auc']); return r ? JSON.parse(r) : null; }
    async function aucPut(a) { a.updatedAt = Date.now(); await redis(['SET', 'doom:auc', JSON.stringify(a)]); }
    async function aucBids() { var arr = await redis(['HGETALL', 'doom:auc:bids']); var b = {}; if (Array.isArray(arr)) { for (var i = 0; i < arr.length; i += 2) b[arr[i]] = Number(arr[i + 1]); } else if (arr && typeof arr === 'object') { for (var k in arr) b[k] = Number(arr[k]); } return b; }
    async function aucPasses() { var arr = await redis(['HGETALL', 'doom:auc:passes']); var p = {}; if (Array.isArray(arr)) { for (var i = 0; i < arr.length; i += 2) p[arr[i]] = 1; } else if (arr && typeof arr === 'object') { for (var k in arr) p[k] = 1; } return p; }
    function aucNorm(x) { return String(x || '').replace(/\s+/g, '').toLowerCase(); }
    function aucNick(x) { return String(x || '').replace(/\s+/g, '').replace(/^\d+/, '').toLowerCase(); }
    function aucNameMatch(x, y) { var nx = aucNorm(x), ny = aucNorm(y); if (nx && nx === ny) return true; var kx = aucNick(x), ky = aucNick(y); return !!kx && kx === ky; }
    function aucResolveMyTeam(teams, s, bodyAcct) {
      if (!teams || !teams.length) return null;
      if (isOp(s) && bodyAcct) { for (var iR = 0; iR < teams.length; iR++) if (teams[iR].acct === bodyAcct) return teams[iR]; return null; }
      var nmR = s && s.name;
      for (var jR = 0; jR < teams.length; jR++) { var tR = teams[jR]; if (aucNameMatch(tR.acct, nmR) || aucNameMatch(tR.leader, nmR)) return tR; if ((tR.roster || []).some(function (r) { return aucNameMatch(r.name, nmR); })) return tR; }
      return null;
    }
    async function aucLogBids(a, bids, outcome, winnerAcct, cost) {
      var log = []; try { log = JSON.parse((await redis(['GET', 'doom:auc:bidlog'])) || '[]'); } catch (e) { log = []; }
      var entries = [];
      for (var kLg in bids) { var tb = aucTeam(a, kLg); entries.push({ bidder: kLg, team: tb ? tb.name : '', color: tb ? tb.color : '', amount: a.prior + bids[kLg], won: (kLg === winnerAcct) }); }
      entries.sort(function (x, y) { return y.amount - x.amount; });
      var wtb = winnerAcct ? aucTeam(a, winnerAcct) : null;
      log.push({ player: a.current ? a.current.name : '', position: a.current ? a.current.position : '', tier: a.current ? a.current.tier : '', outcome: outcome, winner: wtb ? wtb.name : '', cost: cost || 0, bids: entries, at: Date.now() });
      if (log.length > 300) log = log.slice(-300);
      await redis(['SET', 'doom:auc:bidlog', JSON.stringify(log)]);
    }
    function aucTeam(a, name) { if (a && a.teams && name) for (var i = 0; i < a.teams.length; i++) if (a.teams[i].acct === name) return a.teams[i]; return null; }
    function aucElig(a) { var out = []; if (!a) return out; var tied = (a.phase === 'tie') ? (a.tied || []) : null; for (var i = 0; i < a.teams.length; i++) { var t = a.teams[i]; if (tied && tied.indexOf(t.acct) < 0) continue; if ((t.roster || []).length >= 5) continue; if (t.points < a.prior + a.minBid) continue; out.push(t.acct); } return out; }
    function aucLoadNext(a) { a.prior = 0; a.minBid = 10; a.capOff = false; a.tied = null; a.timer = null; if (!a.queue || !a.queue.length) { a.current = null; a.phase = 'done'; } else { a.current = a.queue.shift(); a.phase = 'bidding'; } }

    var s = await auth(token);

    if (action === 'aucState') { // 관전 = 로그인 불필요
      var a = await aucGet();
      var dOpen = (await redis(['GET', 'doom:open'])) || 'closed';
      if (!a || !a.active) return res.status(200).json({ active: false, open: dOpen, role: isOp(s) ? 'op' : (aucTeam(a, s && s.name) ? 'leader' : 'spectator'), loggedIn: !!(s && s.name) });
      var op = isOp(s), my = aucTeam(a, s && s.name), bids = await aucBids(), elig = aucElig(a), passes = await aucPasses();
      var pub = {
        active: true, phase: a.phase, current: a.current, prior: a.prior, minBid: a.minBid, capOff: a.capOff, loggedIn: !!(s && s.name),
        teams: a.teams.map(function (t) { return { id: t.id, name: t.name, leader: t.leader, color: t.color, points: t.points, roster: t.roster || [], full: (t.roster || []).length >= 5 }; }),
        queueLeft: (a.queue || []).length, lastResult: a.lastResult || null, unsold: a.unsold || [], eligibleCount: elig.length, submittedCount: Object.keys(bids).length, passedCount: Object.keys(passes).length, test: !!a.test, confirmed: !!a.confirmed, open: dOpen, timer: a.timer || null, tiedCount: (a.tied || []).length
      };
      if (op) { pub.role = 'op'; pub.bids = bids; pub.eligible = elig; pub.passed = Object.keys(passes); pub.tied = a.tied || null; pub.acctTeam = {}; a.teams.forEach(function (t) { pub.acctTeam[t.acct] = { id: t.id, name: t.name, color: t.color, leader: t.leader }; }); try { pub.bidLog = JSON.parse((await redis(['GET', 'doom:auc:bidlog'])) || '[]'); } catch (e) { pub.bidLog = []; } try { pub.teamsLocked = (JSON.parse((await redis(['GET', 'doom:teams'])) || '[]')).length; } catch (e) { pub.teamsLocked = 0; } }
      else if (my) { pub.role = 'leader'; pub.myTeamId = my.id; pub.iEligible = elig.indexOf(s.name) >= 0; pub.iSubmitted = bids[s.name] != null; pub.myBid = (bids[s.name] != null ? bids[s.name] : null); pub.iTied = !!(a.tied && a.tied.indexOf(s.name) >= 0); pub.iPassed = passes[s.name] != null; }
      else pub.role = 'spectator';
      return res.status(200).json(pub);
    }
    if (action === 'aucStart') {
      if (!isOp(s)) return res.status(403).json({ error: '개발자·물방울만 시작할 수 있어요' });
      if (!Array.isArray(body.teams) || !body.teams.length) return res.status(400).json({ error: '팀 정보가 필요해요' });
      if (!Array.isArray(body.queue) || !body.queue.length) return res.status(400).json({ error: '경매 매물이 필요해요' });
      var qST = body.queue.map(function (p) { return { name: String(p.name), position: String(p.position || ''), tier: String(p.tier || ''), cap: (p.cap == null ? 0 : parseInt(p.cap, 10) || 0) }; });
      for (var iST = qST.length - 1; iST > 0; iST--) { var jST = Math.floor(Math.random() * (iST + 1)); var tST = qST[iST]; qST[iST] = qST[jST]; qST[jST] = tST; } // 🎲 순서는 서버에서만 셔플 — 운영자 포함 아무도 다음 매물을 미리 못 봄
      var aST = {
        active: true,
        teams: body.teams.map(function (t, i) { return { id: i, name: String(t.name || ('팀' + (i + 1))), leader: String(t.leader || ''), acct: String(t.acct || ''), color: String(t.color || '#888888'), points: Math.max(0, parseInt(t.points, 10) || 0), roster: [] }; }),
        queue: qST,
        prior: 0, minBid: 10, capOff: false, tied: null, current: null, phase: 'bidding', lastResult: null, unsold: [], startedAt: Date.now(), test: !!body.test
      };
      aucLoadNext(aST); await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await redis(['DEL', 'doom:auc:bidlog']); await aucPut(aST);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucBid') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요 (지갑에서 로그인)' });
      var aBD = await aucGet(); if (!aBD || !aBD.active) return res.status(400).json({ error: '진행 중인 경매가 없어요' });
      if (aBD.phase !== 'bidding' && aBD.phase !== 'tie') return res.status(400).json({ error: '지금은 입찰 시간이 아니에요' });
      var tBD = aucTeam(aBD, s.name); if (!tBD) return res.status(403).json({ error: '팀장만 입찰할 수 있어요' });
      if (aucElig(aBD).indexOf(s.name) < 0) return res.status(400).json({ error: '이번 매물엔 입찰할 수 없어요 (로스터 마감 또는 포인트 부족)' });
      if (aBD.phase === 'tie' && Array.isArray(aBD.tied) && aBD.tied.indexOf(s.name) < 0) return res.status(400).json({ error: '동점자만 재입찰할 수 있어요' });
      var vBD = parseInt(body.amount, 10);
      if (isNaN(vBD) || vBD < aBD.minBid) return res.status(400).json({ error: '최소 ' + aBD.minBid + 'P 이상이어야 해요' });
      if (vBD % 10 !== 0) return res.status(400).json({ error: '10P 단위로 입력해주세요' });
      if (!aBD.capOff && aBD.current && aBD.current.cap > 0 && vBD > aBD.current.cap) return res.status(400).json({ error: '상한 ' + aBD.current.cap + 'P 초과예요' });
      if (aBD.prior + vBD > tBD.points) return res.status(400).json({ error: '포인트 부족 — 낙찰가 ' + (aBD.prior + vBD) + 'P (잔여 ' + tBD.points + 'P)' });
      await redis(['HSET', 'doom:auc:bids', s.name, String(vBD)]);
      await redis(['HDEL', 'doom:auc:passes', s.name]); // 입찰하면 패스 취소
      return res.status(200).json({ ok: true, bid: vBD, total: aBD.prior + vBD });
    }
    if (action === 'aucUnbid') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      await redis(['HDEL', 'doom:auc:bids', s.name]); return res.status(200).json({ ok: true });
    }
    if (action === 'aucPassBid') { // 🙅 팀장이 이 매물 패스 (입찰 안 함 선언)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var aPB = await aucGet(); if (!aPB || !aPB.active) return res.status(400).json({ error: '경매 없음' });
      if (aPB.phase !== 'bidding') return res.status(400).json({ error: '지금은 패스할 수 없어요' });
      var tPB = aucTeam(aPB, s.name); if (!tPB) return res.status(403).json({ error: '팀장만 패스할 수 있어요' });
      await redis(['HDEL', 'doom:auc:bids', s.name]); await redis(['HSET', 'doom:auc:passes', s.name, '1']);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucReveal') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aRV = await aucGet(); if (!aRV || !aRV.active) return res.status(400).json({ error: '경매 없음' });
      if (aRV.phase !== 'bidding' && aRV.phase !== 'tie') return res.status(400).json({ error: '공개 단계가 아니에요' });
      if (aRV.phase === 'tie' && Array.isArray(aRV.tied) && aRV.tied.length === 1) { // 동점 → 한 명만 남음: 경쟁 없으니 현재가(prior)에 단독 낙찰
        var soloNm = aRV.tied[0], soloT = aucTeam(aRV, soloNm);
        if (soloT && (soloT.roster || []).length < 5 && soloT.points >= aRV.prior) {
          soloT.points -= aRV.prior; soloT.roster.push({ name: aRV.current.name, cost: aRV.prior, position: aRV.current.position, tier: aRV.current.tier, cap: aRV.current.cap });
          aRV.lastResult = { player: aRV.current.name, position: aRV.current.position, winner: soloT.name, leader: soloT.leader, color: soloT.color, cost: aRV.prior, prior: aRV.prior, bid: 0, n: 1, sole: true };
          aRV.phase = 'revealed'; aRV.tied = null; aRV.timer = null;
          await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aRV);
          return res.status(200).json({ ok: true, result: 'sold', winner: soloT.name, cost: aRV.prior, sole: true });
        }
      }
      var bRV = await aucBids(), eRV = aucElig(aRV), valid = [];
      for (var kRV in bRV) if (eRV.indexOf(kRV) >= 0) valid.push({ acct: kRV, bid: bRV[kRV] });
      if (!valid.length) { await aucLogBids(aRV, bRV, 'none', null, 0); return res.status(200).json({ ok: true, result: 'none' }); }
      var maxRV = 0; for (var i = 0; i < valid.length; i++) if (valid[i].bid > maxRV) maxRV = valid[i].bid;
      var winRV = valid.filter(function (x) { return x.bid === maxRV; });
      if (winRV.length === 1) {
        var wT = aucTeam(aRV, winRV[0].acct), cost = aRV.prior + maxRV;
        wT.points -= cost; wT.roster.push({ name: aRV.current.name, cost: cost, position: aRV.current.position, tier: aRV.current.tier, cap: aRV.current.cap });
        aRV.lastResult = { player: aRV.current.name, position: aRV.current.position, winner: wT.name, leader: wT.leader, color: wT.color, cost: cost, prior: aRV.prior, bid: maxRV, n: valid.length };
        await aucLogBids(aRV, bRV, 'sold', winRV[0].acct, cost); aRV.phase = 'revealed'; aRV.timer = null; await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aRV);
        return res.status(200).json({ ok: true, result: 'sold', winner: wT.name, cost: cost });
      }
      await aucLogBids(aRV, bRV, 'tie', null, 0); aRV.prior = aRV.prior + maxRV; aRV.minBid = maxRV + 10; aRV.capOff = true; aRV.tied = winRV.map(function (x) { return x.acct; }); aRV.phase = 'tie'; aRV.timer = null;
      await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aRV);
      return res.status(200).json({ ok: true, result: 'tie', tied: aRV.tied.length, prior: aRV.prior, minBid: aRV.minBid });
    }
    if (action === 'aucGiveUp') { // 🏳️ 동점 재입찰 중 포기 선언
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var aGU = await aucGet(); if (!aGU || !aGU.active) return res.status(400).json({ error: '경매 없음' });
      if (aGU.phase !== 'tie') return res.status(400).json({ error: '동점 재입찰 중에만 포기할 수 있어요' });
      if (!Array.isArray(aGU.tied) || aGU.tied.indexOf(s.name) < 0) return res.status(403).json({ error: '동점자만 포기할 수 있어요' });
      aGU.tied = aGU.tied.filter(function (x) { return x !== s.name; });
      await redis(['HDEL', 'doom:auc:bids', s.name]);
      if (aGU.tied.length === 0) { // 전원 포기 → 유찰
        aGU.unsold = aGU.unsold || []; aGU.unsold.push({ name: aGU.current.name, position: aGU.current.position, tier: aGU.current.tier, cap: aGU.current.cap });
        aGU.lastResult = { player: aGU.current.name, passed: true, allGaveUp: true };
        aGU.phase = 'revealed'; aGU.tied = null; aGU.timer = null;
        await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aGU);
        return res.status(200).json({ ok: true, result: 'none', allGaveUp: true });
      }
      await aucPut(aGU); // 1명 이상 남음 → 공개(낙찰) 때 정산 (한 명이면 현재가 단독 낙찰)
      return res.status(200).json({ ok: true, result: 'continue', remaining: aGU.tied.length });
    }

    if (action === 'aucNext') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aNX = await aucGet(); if (!aNX || !aNX.active) return res.status(400).json({ error: '경매 없음' });
      aucLoadNext(aNX); await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aNX);
      return res.status(200).json({ ok: true, phase: aNX.phase });
    }
    if (action === 'aucPass') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aPS = await aucGet(); if (!aPS || !aPS.active) return res.status(400).json({ error: '경매 없음' });
      if (aPS.current) { aPS.unsold.push({ name: aPS.current.name, position: aPS.current.position, tier: aPS.current.tier, cap: aPS.current.cap }); aPS.lastResult = { player: aPS.current.name, passed: true }; }
      aucLoadNext(aPS); await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aPS);
      return res.status(200).json({ ok: true, phase: aPS.phase });
    }
    if (action === 'aucRequeueUnsold') { // 🔁 유찰자 전원을 다시 경매 대기열로 (한 바퀴 돌고 재도전)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aRU = await aucGet(); if (!aRU || !aRU.active) return res.status(400).json({ error: '경매 없음' });
      var usRU = aRU.unsold || []; if (!usRU.length) return res.status(400).json({ error: '유찰된 선수가 없어요' });
      var backRU = usRU.map(function (u) { return (typeof u === 'string') ? { name: u, position: '', tier: '', cap: 0 } : { name: u.name, position: u.position || '', tier: u.tier || '', cap: (u.cap == null ? 0 : u.cap) }; });
      for (var iRU = backRU.length - 1; iRU > 0; iRU--) { var jRU = Math.floor(Math.random() * (iRU + 1)); var tRU = backRU[iRU]; backRU[iRU] = backRU[jRU]; backRU[jRU] = tRU; } // 다시 셔플
      aRU.queue = (aRU.queue || []).concat(backRU); aRU.unsold = [];
      if (aRU.phase === 'done' || !aRU.current) { aRU.active = true; aRU.confirmed = false; aucLoadNext(aRU); } // 끝났으면 다시 진행
      await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aRU);
      return res.status(200).json({ ok: true, requeued: backRU.length, queueLeft: aRU.queue.length });
    }
    if (action === 'aucTimer') { // ⏱ 운영자 타이머 시작 (discuss=토론 / bid=영입제출)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTM = await aucGet(); if (!aTM || !aTM.active) return res.status(400).json({ error: '경매 없음' });
      var kindTM = (body.kind === 'bid') ? 'bid' : 'discuss';
      var secTM = Math.max(1, Math.min(3600, parseInt(body.seconds, 10) || (kindTM === 'bid' ? 10 : 60)));
      aTM.timer = { kind: kindTM, endsAt: Date.now() + secTM * 1000, dur: secTM };
      await aucPut(aTM);
      return res.status(200).json({ ok: true, timer: aTM.timer });
    }
    if (action === 'aucTimerAdjust') { // ⏱ 타이머 정정 (+/- 초)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTA = await aucGet(); if (!aTA || !aTA.active || !aTA.timer) return res.status(400).json({ error: '진행 중인 타이머가 없어요' });
      var dTA = parseInt(body.delta, 10) || 0;
      aTA.timer.endsAt = Math.max(Date.now(), (aTA.timer.endsAt || Date.now()) + dTA * 1000);
      await aucPut(aTA);
      return res.status(200).json({ ok: true, timer: aTA.timer });
    }
    if (action === 'aucTimerClear') { // ⏹ 타이머 정지
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTC = await aucGet(); if (!aTC || !aTC.active) return res.status(400).json({ error: '경매 없음' });
      aTC.timer = null; await aucPut(aTC);
      return res.status(200).json({ ok: true });
    }
    // ===== 📅 경기 일정 + 🙋 대타 구인 =====
    if (action === 'aucSchedList') {
      var schedL = []; try { schedL = JSON.parse((await redis(['GET', 'doom:sched'])) || '[]'); } catch (e) { schedL = []; }
      var recruitL = []; try { recruitL = JSON.parse((await redis(['GET', 'doom:recruit'])) || '[]'); } catch (e) { recruitL = []; }
      var lockedT = []; try { lockedT = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lockedT = []; }
      var availL = []; try { availL = JSON.parse((await redis(['GET', 'doom:avail'])) || '[]'); } catch (e) { availL = []; }
      var resultsL = []; try { resultsL = JSON.parse((await redis(['GET', 'doom:results'])) || '[]'); } catch (e) { resultsL = []; }
      var bracketL = []; try { bracketL = JSON.parse((await redis(['GET', 'doom:bracket'])) || '[]'); } catch (e) { bracketL = []; }
      var mlineL = []; try { mlineL = JSON.parse((await redis(['GET', 'doom:mlineups'])) || '[]'); } catch (e) { mlineL = []; }
      var mlMig = false;
      for (var mmi = 0; mmi < mlineL.length; mmi++) { var mm = mlineL[mmi]; if (!mm.mk && mm.pub !== false && /^\d{4}-\d{2}-\d{2}$/.test(String(mm.date || ''))) { mm.mk = mm.date + '#' + Math.random().toString(36).slice(2, 5); if (mm.pub === undefined) mm.pub = true; if (mm.winner === undefined) mm.winner = null; try { await redis(['SET', 'mkt:' + mm.mk + ':cap', '50000']); } catch (e) {} mlMig = true; } }
      if (mlMig) { try { await redis(['SET', 'doom:mlineups', JSON.stringify(mlineL)]); } catch (e) {} }
      var pubT = lockedT.map(function (t) { return { acct: t.acct, name: t.name, leader: t.leader, leaderPos: t.leaderPos || '', color: t.color, points: t.points, roster: t.roster || [] }; });
      var myAcctS = (s && s.name) || '', mySchedS = null, myPracticeS = [], allSchedS = null, allPracticeS = null, opSchedS = isOp(s);
      if (opSchedS) { allSchedS = {}; allPracticeS = {}; }
      lockedT.forEach(function (t) { if (t.acct === myAcctS) { mySchedS = t.sched || ''; myPracticeS = t.practice || []; } if (opSchedS) { allSchedS[t.acct] = t.sched || ''; allPracticeS[t.acct] = t.practice || []; } });
      return res.status(200).json({ ok: true, sched: schedL, recruit: recruitL, teams: pubT, myAcct: myAcctS, mySched: mySchedS, allSched: allSchedS, allPractice: allPracticeS, avail: availL, results: resultsL, bracket: bracketL, mlineups: mlineL, myPractice: myPracticeS });
    }
    if (action === 'aucMLineupAdd') { // 📢 멸망전/스크림 라인업 공지 (운영 전용)
      if (!isOp(s)) return res.status(403).json({ error: '운영자만 공지할 수 있어요' });
      var aTm = String(body.aTeam || '').trim(), bTm = String(body.bTeam || '').trim();
      if (!aTm || !bTm) return res.status(400).json({ error: '두 팀을 골라주세요' });
      if (aTm === bTm) return res.status(400).json({ error: '같은 팀끼리는 안 돼요' });
      var lkML = []; try { lkML = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkML = []; }
      if (!lkML.length) return res.status(400).json({ error: '먼저 팀 명단을 확정해주세요 (못 박기)' });
      var colML = {}; lkML.forEach(function (t) { colML[t.name] = t.color; });
      if (colML[aTm] === undefined || colML[bTm] === undefined) return res.status(404).json({ error: '확정된 팀만 공지할 수 있어요' });
      var mlA = []; try { mlA = JSON.parse((await redis(['GET', 'doom:mlineups'])) || '[]'); } catch (e) { mlA = []; }
      var dateML = String(body.date || '').slice(0, 10);
      var pubML = !!body.pub;
      var mkML = '';
      if (pubML && /^\d{4}-\d{2}-\d{2}$/.test(dateML)) { mkML = dateML + '#' + Math.random().toString(36).slice(2, 5); }
      if (mkML) { try { await redis(['SET', 'mkt:' + mkML + ':cap', '50000']); } catch (e) {} } // 멸망전 베팅 상한 5만
      var idML = 'ml' + Date.now() + Math.floor(Math.random() * 1000);
      mlA.push({ id: idML, type: (body.type === '멸망전' ? '멸망전' : '스크림'), aTeam: aTm, aColor: colML[aTm] || '', bTeam: bTm, bColor: colML[bTm] || '', date: dateML, time: String(body.time || '').slice(0, 5), note: String(body.note || '').slice(0, 100), pub: pubML, mk: mkML, winner: null, by: s.name, at: Date.now() });
      await redis(['SET', 'doom:mlineups', JSON.stringify(mlA)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucMLineupDel') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var mlD = []; try { mlD = JSON.parse((await redis(['GET', 'doom:mlineups'])) || '[]'); } catch (e) { mlD = []; }
      mlD = mlD.filter(function (x) { return x.id !== body.id; });
      await redis(['SET', 'doom:mlineups', JSON.stringify(mlD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucMLineupSettle') { // 🏁 경기 결과 확정 (베팅 정산은 클라가 bank로 별도 호출)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var winML = (body.winner === 'a' || body.winner === 'b') ? body.winner : null;
      var mlS = []; try { mlS = JSON.parse((await redis(['GET', 'doom:mlineups'])) || '[]'); } catch (e) { mlS = []; }
      mlS = mlS.map(function (x) { if (x.id === body.id) { x.winner = winML; } return x; });
      await redis(['SET', 'doom:mlineups', JSON.stringify(mlS)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucFDraftGet') { // 🎯 모의 밴픽(피어리스) 시리즈 불러오기 (팀별)
      var acctFG = body.team || '';
      var fdRaw = null; try { fdRaw = JSON.parse((await redis(['GET', acctFG ? ('doom:fdraft:' + acctFG) : 'doom:fdraft'])) || 'null'); } catch (e) { fdRaw = null; }
      return res.status(200).json({ fdraft: fdRaw || { blue: '', red: '', games: [], globalBans: [] } });
    }
    if (action === 'aucFDraftSet') { // 🎯 모의 밴픽 시리즈 저장 (그 팀 팀원만)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var acctFS = body.team || '';
      var lkFS = []; try { lkFS = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkFS = []; }
      var myFS = aucResolveMyTeam(lkFS, s, null);
      if (!(isOp(s) || (myFS && acctFS && myFS.acct === acctFS))) return res.status(403).json({ error: '이 팀의 팀원만 저장할 수 있어요' });
      var fd = body.fdraft;
      if (!fd || typeof fd !== 'object') return res.status(400).json({ error: '저장 데이터 오류' });
      var clean = { blue: String(fd.blue || '').slice(0, 40), red: String(fd.red || '').slice(0, 40), games: [], globalBans: (Array.isArray(fd.globalBans) ? fd.globalBans : []).slice(0, 20).map(function (c) { return String(c || '').slice(0, 30); }).filter(Boolean) };
      if (Array.isArray(fd.games)) { clean.games = fd.games.slice(0, 9).map(function (g) { var pick = function (arr) { return (Array.isArray(arr) ? arr : []).slice(0, 5).map(function (c) { return String(c || '').slice(0, 30); }); }; return { bb: pick(g.bb), rb: pick(g.rb), bp: pick(g.bp), rp: pick(g.rp) }; }); }
      await redis(['SET', acctFS ? ('doom:fdraft:' + acctFS) : 'doom:fdraft', JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, fdraft: clean });
    }
    if (action === 'aucFDLiveGet') { // 🔴 실시간 라이브 (팀별 · 읽기)
      var acctLG = body.team || '';
      var lvRaw = null; try { lvRaw = JSON.parse((await redis(['GET', acctLG ? ('doom:fdlive:' + acctLG) : 'doom:fdlive'])) || 'null'); } catch (e) { lvRaw = null; }
      return res.status(200).json({ live: lvRaw });
    }
    if (action === 'aucFDLiveSet') { // 🔴 실시간 라이브 갱신 (그 팀 팀원만)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var acctLS = body.team || '';
      var lkLS = []; try { lkLS = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkLS = []; }
      var myLS = aucResolveMyTeam(lkLS, s, null);
      if (!(isOp(s) || (myLS && acctLS && myLS.acct === acctLS))) return res.status(403).json({ error: '이 팀의 팀원만 사용할 수 있어요' });
      var stIn = body.state || {};
      var clampArr = function (arr) { return (Array.isArray(arr) ? arr : []).slice(0, 5).map(function (c) { return String(c || '').slice(0, 30); }); };
      var ts = Date.now();
      var lv = { step: Math.max(0, Math.min(20, parseInt(stIn.step, 10) || 0)), bb: clampArr(stIn.bb), rb: clampArr(stIn.rb), bp: clampArr(stIn.bp), rp: clampArr(stIn.rp), blue: String(stIn.blue || '').slice(0, 40), red: String(stIn.red || '').slice(0, 40), ts: ts, by: s.name };
      await redis(['SET', acctLS ? ('doom:fdlive:' + acctLS) : 'doom:fdlive', JSON.stringify(lv)]);
      return res.status(200).json({ ok: true, ts: ts });
    }
    if (action === 'aucDraftSim') { // 🤖 AI 드래프트 모의결과 (Gemini/Claude · 본인 키 BYOK 지원)
      var simUK = body.userKey && /^AIza[0-9A-Za-z_\-]{20,}$/.test(String(body.userKey).trim());
      if (!simUK && !process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI가 아직 설정 안 됐어요 — 무료 GEMINI_API_KEY를 Vercel에 추가하거나, 설정에서 본인 키를 등록해주세요' });
      var sBp = (body.bluePicks || []).filter(Boolean), sRp = (body.redPicks || []).filter(Boolean);
      if (sBp.length < 3 || sRp.length < 3) return res.status(400).json({ error: '양 팀 픽이 3명 이상 필요해요' });
      var sL = function (a) { return (a || []).filter(Boolean).join(', ') || '(없음)'; };
      var sPw = function (p) { return (p && p > 0) ? ('\n평균 체급(선수 실력): ' + Math.round(p) + '/100') : ''; };
      var sRoster = function (r) { return (r && String(r).trim()) ? ('\n[내전 선수단 챔프풀]\n' + r) : ''; };
      var sPrompt = '당신은 리그 오브 레전드 드래프트 분석 전문가입니다. 아래 밴픽을 보고 모의 경기 결과를 예측해주세요.\n\n'
        + '🔵 ' + (body.blue || '블루팀') + ' (블루)\n픽: ' + sL(body.bluePicks) + '\n밴: ' + sL(body.blueBans) + sPw(body.bluePow) + sRoster(body.blueRoster) + '\n\n'
        + '🔴 ' + (body.red || '레드팀') + ' (레드)\n픽: ' + sL(body.redPicks) + '\n밴: ' + sL(body.redBans) + sPw(body.redPow) + sRoster(body.redRoster) + '\n\n'
        + '다음을 한국어로, 프로 분석가의 실전 코칭 톤으로 "엄청 디테일하게" 분석하세요. 게임이 실제로 어떻게 흘러갈지 시간순으로 그리되, 모든 주장은 [무엇이(구체적 챔프·선수·매치업) → 왜 → 그래서 어떤 결과]의 인과로 풀고, 추상적 표현("좋다/밸런스 맞다")은 금지합니다.\n\n'
        + ((body.blueRoster || body.redRoster)
            ? '★ 절대 규칙(선수 데이터): 위 [내전 선수단 챔프풀]만 근거로 쓰세요. 데이터 형식은 "포지션 이름 [체급N · 주력: 챔프(N겜 W%)...]"이고 주력은 상위 3개만 줍니다. 각 픽은 그 챔프의 주 포지션을 보고 같은 포지션 선수와 매칭하세요. 그 선수 주력에 그 챔프가 있으면 "○○ 선수 이 챔프 N겜 W%"처럼 실제 수치를 인용하고, 주력에 없으면 "주력 외 — 기록 없음"이라 쓰고 승률을 지어내지 마세요. 데이터에 없는 뜬금없는 선수-챔프 매칭이나 수치 창작은 절대 금지.\n\n'
            : ((body.bluePow && body.redPow) ? '★ 선수별 챔프 기록이 없으니 특정 선수 승률 수치를 지어내지 말 것. 평균 체급 차이가 라인전·한타에 어떻게 작용하는지를 챔프 상성·조합 중심으로 풀어주세요.\n\n' : '★ 선수 기록이 없으니 특정 선수 승률을 지어내지 말고, 순수 챔피언 조합·상성·메타 중심으로 분석하세요.\n\n'))
        + '아래 5단계로 빠짐없이:\n'
        + '1) 【라인전】 탑·정글·미드·원딜·서폿 각 맞라인 — 누가(선수) 무슨 챔프로 상대 누구를 이기는지/지는지. 선수 숙련도(N겜 W%)와 챔프 상성을 둘 다 근거로. 누가 풀리고 누가 막히는지.\n'
        + '2) 【정글·오브젝트】 초반 유충(그럽)·용·(후반)바론 주도권을 어느 팀이 잡는지 — 정글 챔프·라인 우세·이니시 유무로. 그 오브젝트 이득이 어떤 스노우볼로 이어지는지.\n'
        + '3) 【딜 체크·한타】 두 조합의 딜을 직접 비교 — 각 팀이 상대 앞라인(탱)을 녹일 AD/AP·버스트·지속딜이 충분한지 부족한지. 그리고 누구의 챔프가 상대 핵심 캐리(저 원딜/미드)를 짤라내거나 봉쇄할 수 있는지 없는지를 구체적으로. 이니시·보호(피글)·CC·스케일링까지.\n'
        + '4) 【게임 흐름】 위를 종합해 초반→중반→후반이 실제로 어떻게 전개될지 하나의 시나리오로(누구의 어떤 픽 때문에 이 그림인지 이유 포함).\n'
        + '5) 【결론】 최종 예상 승자와 승률(예: 🔵 블루 63%) + 그 %가 나온 핵심 근거 1~2줄, 그리고 약팀이 뒤집을 변수 1~2개.\n\n'
        + '마크다운 헤더(#)·별표(**)는 쓰지 말고, 【】 소제목 + 이모지 + 줄바꿈으로 읽기 좋게. 각 단계는 디테일하게 쓰되, 반드시 5단계 전부와 마지막 【결론(승률%)】까지 빠짐없이 도달하도록 분량을 배분하세요(한 단계에 과하게 길게 쓰다 결론을 빠뜨리지 말 것).';
      try {
        var simText = await callLLM(sPrompt, 8000, body.userKey);
        return res.status(200).json({ ok: true, analysis: simText || '(분석 결과가 비어 있어요)' });
      } catch (e) { return res.status(502).json({ error: 'AI 호출 오류: ' + (e && e.message || '') }); }
    }
    if (action === 'aucDraftSuggest') { // 🤔 모르겠음 — AI가 이번 차례 픽/밴 추천 (솔랭·자랭 추정 + 내전 데이터 · BYOK 지원)
      var sgUK = body.userKey && /^AIza[0-9A-Za-z_\-]{20,}$/.test(String(body.userKey).trim());
      if (!sgUK && !process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI가 아직 설정 안 됐어요 — 무료 GEMINI_API_KEY를 추가하거나, 설정에서 본인 키를 등록해주세요' });
      var sgSide = body.side === 'r' ? '레드' : '블루';
      var sgType = body.type === 'ban' ? '밴' : '픽';
      var sgL = function (a) { return (a || []).filter(Boolean).join(', ') || '(없음)'; };
      var avail = (body.available || []).filter(Boolean);
      if (!avail.length) return res.status(400).json({ error: '선택 가능한 챔피언이 없어요' });
      var sgMeBlue = body.side !== 'r';
      var sgMyPicks = sgMeBlue ? body.bluePicks : body.redPicks;
      var sgMyBans = sgMeBlue ? body.blueBans : body.redBans;
      var sgOppPicks = sgMeBlue ? body.redPicks : body.bluePicks;
      var sgOppBans = sgMeBlue ? body.redBans : body.blueBans;
      var sgFilled = body.myFilled || '(정보 없음)';
      var sgOpen = body.myOpen || '(정보 없음)';
      var sgOpenPools = body.myOpenPools || '';
      var sgOppPool = body.oppRoster || '';
      var sgPrompt = '리그 오브 레전드 5대5 토너먼트 드래프트 진행 중. 나는 ' + sgSide + '팀이고 지금 우리 팀 ' + sgType + ' 차례입니다. 프로 드래프트 코치처럼, 아래 정보를 "모두" 종합해 이번 차례 최적의 한 수를 결정하세요.\n\n'
        + '[우리 팀(' + sgSide + ')]\n'
        + '· 이미 채운 라인: ' + sgFilled + '\n'
        + '· 아직 비어있는 라인: ' + sgOpen + '\n'
        + (sgOpenPools ? ('· 빈 라인 담당 선수의 실제 챔프풀(판수·승률):\n' + sgOpenPools + '\n') : '')
        + '· 우리 전체 픽: ' + sgL(sgMyPicks) + ' / 밴: ' + sgL(sgMyBans) + '\n\n'
        + '[상대 팀]\n'
        + '· 픽: ' + sgL(sgOppPicks) + ' / 밴: ' + sgL(sgOppBans) + '\n'
        + (sgOppPool ? ('· 상대 선수 챔프풀(이 챔프들에 능숙):\n' + sgOppPool + '\n') : '')
        + '\n[진영 전략] 우리 팀은 ' + (sgMeBlue ? '블루 — 선픽 주도권은 있지만 카운터를 당할 수 있음. 카운터당하기 쉬운 라인의존 챔프는 피하고, 여러 라인 가능한 유연픽이나 꼭 가져와야 할 메타 OP를 먼저 확보. 약점 라인을 일찍 노출하지 말 것.' : '레드 — 후픽·막픽 카운터 우위. 지금은 안전·유연한 픽을 하고 상대 핵심 픽이 드러나면 막픽으로 카운터쳐 받는 그림. 이미 드러난 상대 라이너가 있으면 그 카운터를 우선 고려.') + '\n\n'
        + (body.type === 'ban'
            ? '【밴 추천 — 종합해서 가장 위협적인 챔프 1개를 끊기】\n(1) 상대 선수가 잘 다루는 주력 챔프(위 상대 챔프풀)\n(2) 우리 빈 라인 선수에게 까다로운 라인 카운터·우리 조합의 천적\n(3) 진영: 블루면 상대가 선픽으로 가져갈 메타 OP를 선제 차단, 레드면 상대가 막픽 카운터로 쓸 챔프 제거\n(4) 게임을 터뜨리는 메타 OP'
            : '【픽 추천 — 아래를 모두 따져 최적의 한 수】\n(1) 빈 라인 채우기(채운 라인 중복 절대 금지)\n(2) 선수 숙련도 최우선: 그 라인 우리 선수가 실제로 잘 다루는 챔프(높은 판수·승률 = "지금 가능"). 못 다루는 OP보다 잘 다루는 무난한 픽이 낫다\n(3) 상성 카운터: 상대 픽·상대 라이너와의 맞라인에서 유리한(상대를 카운터하는) 챔프. 우리 라이너가 카운터당하는 픽은 피하기\n(4) 팀 조합·승리조건: 기존 픽과 이니시에이터·앞라인(탱)·AD/AP 딜 밸런스·CC·후반 캐리 균형, 우리 승리 플랜(초반 스노우볼/한타/스플릿)에 맞는지\n(5) 진영 전략(위) 반영. 솔로 라인은 맞라인 상성, 정글/서폿은 팀 시너지·갱 동선을 더 중시') + '\n\n'
        + '먼저 유력 후보 2~3개를 실제로 비교하세요 — 각 후보를 (상성 카운터 관계 / 그 라인 우리 선수의 챔프풀 숙련도 / 진영별 라인 선픽 전략: 블루면 카운터 적고 유연한 픽·꼭 챙길 메타OP를 선픽하고 미드·원딜 하드매치업 노출은 자제, 레드면 이미 드러난 상대 라이너의 맞라인 카운터를 우선) 면에서 대조하고, 왜 어떤 건 탈락이고 무엇이 최선인지 따진 뒤 결론을 내세요.\n'
        + '출력 형식(반드시 이 순서로):\n'
        + '1) "분석:" 으로 시작하는 2~4줄 — 후보들을 비교하며 근거를 구체적으로(예: "○○는 상대 △△에게 맞라인 불리해서 탈락", "□□는 우리 선수 12판 67%라 숙련도 높고 상대 카운터도 적어 최선"). 추상적 표현 금지, 챔프·라인·선수·상성으로.\n'
        + '2) 마지막 줄에 결론 — "추천' + sgType + ': " 뒤에 실제 추천 챔피언 이름 하나만(아래 목록 표기 그대로). 예) 추천' + sgType + ': 아리\n\n'
        + '선택 가능 챔피언: ' + avail.join(', ');
      try {
        var sgText = await callLLM(sgPrompt, 1100, body.userKey);
        var sgLines = sgText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        var sgAvailSet = {}; avail.forEach(function (a) { sgAvailSet[a] = 1; });
        var sgChamp = '', sgIdx = -1;
        // 1순위: "추천/결정/최종" 결론 줄에서 챔프 (분석 먼저 → 마지막 줄 결론). 뒤에서부터 스캔
        for (var sgi = sgLines.length - 1; sgi >= 0 && !sgChamp; sgi--) {
          if (/추천|결정|최종/.test(sgLines[sgi])) {
            var sgAfter = sgLines[sgi].replace(/["'`*]/g, '');
            var sgPickHit = avail.filter(function (a) { return sgAfter.indexOf(a) >= 0; }).sort(function (x, y) { return y.length - x.length; })[0];
            if (sgPickHit) { sgChamp = sgPickHit; sgIdx = sgi; }
          }
        }
        // 2순위: 줄 전체가 정확히 챔프명 (뒤에서부터)
        if (!sgChamp) {
          for (var sgj = sgLines.length - 1; sgj >= 0 && !sgChamp; sgj--) {
            var sgCand = sgLines[sgj].replace(/^[0-9.)\-\s:]+/, '').replace(/["'`*]/g, '').trim();
            if (sgAvailSet[sgCand]) { sgChamp = sgCand; sgIdx = sgj; }
          }
        }
        // 3순위: 줄 안에 포함된 챔프명 (뒤에서부터, 가장 긴 매치)
        if (!sgChamp) {
          for (var sgk = sgLines.length - 1; sgk >= 0 && !sgChamp; sgk--) {
            var sgHit = avail.filter(function (a) { return sgLines[sgk].indexOf(a) >= 0; }).sort(function (x, y) { return y.length - x.length; })[0];
            if (sgHit) { sgChamp = sgHit; sgIdx = sgk; }
          }
        }
        var sgReason = '';
        if (sgIdx >= 0) { sgReason = sgLines.filter(function (l, i) { return i !== sgIdx; }).join('\n').replace(/["'`*]/g, '').replace(/^[\s:\-]+/, '').trim(); if (!sgReason) sgReason = sgLines[sgIdx].split(sgChamp).join(' ').replace(/["'`*]/g, '').trim(); }
        if (!sgChamp) { sgChamp = (sgLines[0] || '').replace(/^[0-9.)\-\s:]+/, '').replace(/["'`*]/g, '').trim(); sgReason = sgLines.slice(1).join('\n').trim(); }
        return res.status(200).json({ ok: true, champion: sgChamp, reason: sgReason });
      } catch (e) { return res.status(502).json({ error: 'AI 호출 오류: ' + (e && e.message || '') }); }
    }
    if (action === 'aucBracketSet') { // 🏆 더블 엘리미네이션 대진표 저장 (운영 전용)
      if (!isOp(s)) return res.status(403).json({ error: '운영자만 대진표를 편집할 수 있어요' });
      var mbB = Array.isArray(body.matches) ? body.matches : [];
      var toScoreB = function (x) { if (x === null || x === undefined || x === '') return null; var n = parseInt(x, 10); return isNaN(n) ? null : Math.max(0, Math.min(99, n)); };
      var cleanB = mbB.slice(0, 80).map(function (m, i) {
        m = m || {};
        var brB = ['W', 'L', 'GF'].indexOf(m.br) >= 0 ? m.br : 'W';
        var rdB = parseInt(m.round, 10); if (!(rdB >= 1 && rdB <= 20)) rdB = 1;
        return { id: String(m.id || ('bm' + Date.now() + '_' + i)).slice(0, 40), br: brB, round: rdB, slot: parseInt(m.slot, 10) || (i + 1), a: String(m.a || '').slice(0, 40), b: String(m.b || '').slice(0, 40), sa: toScoreB(m.sa), sb: toScoreB(m.sb), date: String(m.date || '').slice(0, 10), note: String(m.note || '').slice(0, 60) };
      });
      await redis(['SET', 'doom:bracket', JSON.stringify(cleanB)]);
      return res.status(200).json({ ok: true, bracket: cleanB });
    }
    if (action === 'aucSchedAdd') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요 (지갑에서 로그인)' });
      var schA = []; try { schA = JSON.parse((await redis(['GET', 'doom:sched'])) || '[]'); } catch (e) { schA = []; }
      var typeA = ['available', 'scrim', 'match'].indexOf(body.type) >= 0 ? body.type : 'available';
      var dateA = String(body.date || '').slice(0, 10);
      if (!dateA) return res.status(400).json({ error: '날짜를 선택해주세요' });
      var entA = { id: 'S' + Date.now().toString(36) + Math.floor(Math.random() * 1000), type: typeA, teamName: String(body.teamName || '').slice(0, 40), opponent: String(body.opponent || '').slice(0, 40), date: dateA, time: String(body.time || '').slice(0, 5), note: String(body.note || '').slice(0, 120), by: s.name, at: Date.now() };
      schA.push(entA); if (schA.length > 300) schA = schA.slice(-300);
      await redis(['SET', 'doom:sched', JSON.stringify(schA)]);
      return res.status(200).json({ ok: true, entry: entA });
    }
    if (action === 'aucSchedDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var schD = []; try { schD = JSON.parse((await redis(['GET', 'doom:sched'])) || '[]'); } catch (e) { schD = []; }
      var tgtD = schD.filter(function (x) { return x.id === body.id; })[0];
      if (!tgtD) return res.status(404).json({ error: '항목을 찾을 수 없어요' });
      if (tgtD.by !== s.name && !isOp(s)) return res.status(403).json({ error: '본인이 등록한 항목만 지울 수 있어요' });
      schD = schD.filter(function (x) { return x.id !== body.id; });
      await redis(['SET', 'doom:sched', JSON.stringify(schD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucRecruitAdd') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요 (지갑에서 로그인)' });
      var recA = []; try { recA = JSON.parse((await redis(['GET', 'doom:recruit'])) || '[]'); } catch (e) { recA = []; }
      var kindA = (body.kind === 'practice') ? 'practice' : 'scrim';
      var postA = { id: 'R' + Date.now().toString(36) + Math.floor(Math.random() * 1000), teamName: String(body.teamName || '').slice(0, 40), kind: kindA, position: String(body.position || '').slice(0, 20), when: String(body.when || '').slice(0, 40), note: String(body.note || '').slice(0, 120), by: s.name, status: 'open', at: Date.now() };
      recA.unshift(postA); if (recA.length > 200) recA = recA.slice(0, 200);
      await redis(['SET', 'doom:recruit', JSON.stringify(recA)]);
      return res.status(200).json({ ok: true, post: postA });
    }
    if (action === 'aucRecruitDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var recD = []; try { recD = JSON.parse((await redis(['GET', 'doom:recruit'])) || '[]'); } catch (e) { recD = []; }
      var tgtRD = recD.filter(function (x) { return x.id === body.id; })[0];
      if (!tgtRD) return res.status(404).json({ error: '글을 찾을 수 없어요' });
      if (tgtRD.by !== s.name && !isOp(s)) return res.status(403).json({ error: '본인 글만 지울 수 있어요' });
      recD = recD.filter(function (x) { return x.id !== body.id; });
      await redis(['SET', 'doom:recruit', JSON.stringify(recD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucRecruitToggle') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var recT = []; try { recT = JSON.parse((await redis(['GET', 'doom:recruit'])) || '[]'); } catch (e) { recT = []; }
      var tgtT = recT.filter(function (x) { return x.id === body.id; })[0];
      if (!tgtT) return res.status(404).json({ error: '글을 찾을 수 없어요' });
      if (tgtT.by !== s.name && !isOp(s)) return res.status(403).json({ error: '본인 글만 수정할 수 있어요' });
      tgtT.status = (tgtT.status === 'open') ? 'closed' : 'open';
      await redis(['SET', 'doom:recruit', JSON.stringify(recT)]);
      return res.status(200).json({ ok: true, status: tgtT.status });
    }

    if (action === 'aucTestBid') { // 🧪 운영자가 특정 팀 대신 입찰 (테스트 모드 전용)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTB = await aucGet(); if (!aTB || !aTB.active) return res.status(400).json({ error: '경매 없음' });
      if (!aTB.test) return res.status(403).json({ error: '테스트 모드에서만 대리 입찰돼요' });
      if (aTB.phase !== 'bidding' && aTB.phase !== 'tie') return res.status(400).json({ error: '입찰 단계가 아니에요' });
      var accTB = String(body.acct || ''); var tTB = aucTeam(aTB, accTB); if (!tTB) return res.status(400).json({ error: '없는 팀' });
      if (aucElig(aTB).indexOf(accTB) < 0) return res.status(400).json({ error: (tTB.name || accTB) + '은(는) 이번 매물에 입찰 불가' });
      var vTB = parseInt(body.amount, 10);
      if (isNaN(vTB) || vTB < aTB.minBid) return res.status(400).json({ error: '최소 ' + aTB.minBid + 'P 이상' });
      if (vTB % 10 !== 0) return res.status(400).json({ error: '10P 단위' });
      if (!aTB.capOff && aTB.current && aTB.current.cap > 0 && vTB > aTB.current.cap) return res.status(400).json({ error: '상한 ' + aTB.current.cap + 'P 초과' });
      if (aTB.prior + vTB > tTB.points) return res.status(400).json({ error: '포인트 부족' });
      await redis(['HSET', 'doom:auc:bids', accTB, String(vTB)]);
      return res.status(200).json({ ok: true, acct: accTB, bid: vTB });
    }
    if (action === 'aucTestFill') { // 🎲 입찰가능 팀 전원 랜덤 입찰 (테스트 모드 전용)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTF = await aucGet(); if (!aTF || !aTF.active) return res.status(400).json({ error: '경매 없음' });
      if (!aTF.test) return res.status(403).json({ error: '테스트 모드 전용' });
      if (aTF.phase !== 'bidding' && aTF.phase !== 'tie') return res.status(400).json({ error: '입찰 단계가 아니에요' });
      var eligTF = aucElig(aTF), capTF = (!aTF.capOff && aTF.current && aTF.current.cap > 0) ? aTF.current.cap : 0, filled = [];
      for (var i = 0; i < eligTF.length; i++) {
        var tF = aucTeam(aTF, eligTF[i]); var hi = tF.points - aTF.prior; if (capTF > 0) hi = Math.min(hi, capTF);
        if (hi < aTF.minBid) continue;
        var steps = Math.floor((hi - aTF.minBid) / 10); var bidF = aTF.minBid + (steps > 0 ? Math.floor(Math.random() * (steps + 1)) * 10 : 0);
        await redis(['HSET', 'doom:auc:bids', eligTF[i], String(bidF)]); filled.push({ team: tF.name, bid: bidF });
      }
      return res.status(200).json({ ok: true, filled: filled });
    }
    if (action === 'aucTestUnbid') { // 🧪 운영자가 특정 팀 입찰 취소 (테스트 모드 전용)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTU = await aucGet(); if (!aTU || !aTU.active) return res.status(400).json({ error: '경매 없음' });
      if (!aTU.test) return res.status(403).json({ error: '테스트 모드 전용' });
      await redis(['HDEL', 'doom:auc:bids', String(body.acct || '')]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucRemovePlayer') { // 운영 — 선수 한 명 빼기(환불) · 선택시 재경매 대기열로
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aRP = await aucGet(); if (!aRP || !aRP.active) return res.status(400).json({ error: '경매 없음' });
      var tidRP = parseInt(body.teamId, 10); var nmRP = String(body.name || '');
      var tRP = null; for (var i = 0; i < aRP.teams.length; i++) if (aRP.teams[i].id === tidRP) tRP = aRP.teams[i];
      if (!tRP) return res.status(400).json({ error: '없는 팀' });
      var idxRP = -1; for (var j = 0; j < (tRP.roster || []).length; j++) if (tRP.roster[j].name === nmRP) { idxRP = j; break; }
      if (idxRP < 0) return res.status(400).json({ error: '그 선수가 이 팀 로스터에 없어요' });
      var remRP = tRP.roster.splice(idxRP, 1)[0];
      tRP.points += (remRP.cost || 0); // 환불
      if (body.requeue) aRP.queue.push({ name: remRP.name, position: remRP.position || '', tier: remRP.tier || '', cap: (remRP.cap == null ? 0 : remRP.cap) });
      if (aRP.phase === 'done' && body.requeue) { aRP.active = true; if (!aRP.current) aucLoadNext(aRP); } // 확정 후 재경매면 다시 진행
      await aucPut(aRP);
      return res.status(200).json({ ok: true, refunded: (remRP.cost || 0), requeued: !!body.requeue });
    }
    if (action === 'aucClearTeam') { // 운영 — 팀 로스터 전부 비우기(환불)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aCT = await aucGet(); if (!aCT || !aCT.active) return res.status(400).json({ error: '경매 없음' });
      var tidCT = parseInt(body.teamId, 10); var tCT = null;
      for (var i = 0; i < aCT.teams.length; i++) if (aCT.teams[i].id === tidCT) tCT = aCT.teams[i];
      if (!tCT) return res.status(400).json({ error: '없는 팀' });
      var refCT = 0; (tCT.roster || []).forEach(function (r) { refCT += (r.cost || 0); });
      tCT.points += refCT; tCT.roster = [];
      await aucPut(aCT);
      return res.status(200).json({ ok: true, refunded: refCT });
    }
    if (action === 'aucSetPosition') { // 🎯 로스터 선수 포지션 확정 (팀장/운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var plPos = String(body.player || '').trim();
      var posPos = String(body.position || '').slice(0, 10);
      var lkPos = []; try { lkPos = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkPos = []; }
      if (!lkPos.length) return res.status(400).json({ error: '먼저 팀 명단을 확정해주세요' });
      var tPos = aucResolveMyTeam(lkPos, s, body.acct);
      if (!tPos) return res.status(403).json({ error: '본인 팀만 설정할 수 있어요' });
      if (body.isLeader) { tPos.leaderPos = posPos; }
      else { if (!plPos) return res.status(400).json({ error: '선수를 지정해주세요' }); var foundPos = false; (tPos.roster || []).forEach(function (r) { if (r.name === plPos) { r.position = posPos; foundPos = true; } }); if (!foundPos) return res.status(404).json({ error: '선수를 찾을 수 없어요' }); }
      await redis(['SET', 'doom:teams', JSON.stringify(lkPos)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucTeamPage') { // 👥 팀 페이지 — 전체 팀 목록 + 선택 팀(비공개는 팀원/운영만)
      var opTP = isOp(s);
      var lkTP = []; try { lkTP = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkTP = []; }
      var myT = (s && s.name) ? aucResolveMyTeam(lkTP, s, null) : null;
      var selAcctTP = (body.acct && lkTP.some(function (t) { return t.acct === body.acct; })) ? body.acct : (myT ? myT.acct : (lkTP.length ? lkTP[0].acct : ''));
      var selTP = null; for (var iTP = 0; iTP < lkTP.length; iTP++) if (lkTP[iTP].acct === selAcctTP) selTP = lkTP[iTP];
      var canPrivTP = !!(opTP || (myT && selTP && myT.acct === selTP.acct));
      var pubTP = lkTP.map(function (t) { return { acct: t.acct, name: t.name, leader: t.leader, leaderPos: t.leaderPos || '', color: t.color, roster: (t.roster || []).map(function (r) { return { name: r.name, position: r.position, cost: r.cost, tier: r.tier }; }) }; });
      var selData = null;
      if (selTP) {
        selData = { acct: selTP.acct, name: selTP.name, leader: selTP.leader, leaderPos: selTP.leaderPos || '', color: selTP.color, roster: selTP.roster || [], priv: canPrivTP };
        if (canPrivTP) { selData.weekly = selTP.weekly || {}; selData.drafts = selTP.drafts || []; selData.practice = selTP.practice || []; selData.sched = selTP.sched || ''; selData.avail = selTP.avail || {}; var myMemTP = ''; if (s && s.name) { if (aucNameMatch(selTP.leader, s.name) || aucNameMatch(selTP.acct, s.name)) myMemTP = selTP.leader; else (selTP.roster || []).forEach(function (r) { if (!myMemTP && aucNameMatch(r.name, s.name)) myMemTP = r.name; }); } selData.myMember = myMemTP; selData.canEdit = true; }
      }
      return res.status(200).json({ ok: true, isOp: opTP, myAcct: myT ? myT.acct : '', myName: (s && s.name) || '', teams: pubTP, sel: selData });
    }
    if (action === 'aucSetWeekly') { // 📆 주간 가능 시간 (팀원/운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var lkW = []; try { lkW = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkW = []; }
      var tW = aucResolveMyTeam(lkW, s, body.acct);
      if (!tW) return res.status(403).json({ error: '팀원만 입력할 수 있어요' });
      var DAYS = ['월', '화', '수', '목', '금', '토', '일'], w = {};
      var srcW = (body.weekly && typeof body.weekly === 'object') ? body.weekly : {};
      DAYS.forEach(function (d) { if (srcW[d]) w[d] = String(srcW[d]).slice(0, 40); });
      tW.weekly = w;
      await redis(['SET', 'doom:teams', JSON.stringify(lkW)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucSetAvail') { // 🗓️ 개인별 가능 시간 격자 (팀원/운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var lkAv = []; try { lkAv = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkAv = []; }
      var tAv = aucResolveMyTeam(lkAv, s, body.acct);
      if (!tAv) return res.status(403).json({ error: '팀원만 입력할 수 있어요' });
      var memAv = String(body.member || '').trim();
      if (!memAv) return res.status(400).json({ error: '멤버를 지정해주세요' });
      var memNames = [tAv.leader].concat((tAv.roster || []).map(function (r) { return r.name; }));
      if (memNames.indexOf(memAv) < 0) return res.status(400).json({ error: '팀 멤버가 아니에요' });
      var DAYSav = ['월', '화', '수', '목', '금', '토', '일'];
      var srcAv = (body.grid && typeof body.grid === 'object') ? body.grid : {};
      var gAv = {};
      DAYSav.forEach(function (d) { var arr = Array.isArray(srcAv[d]) ? srcAv[d] : []; var clean = []; arr.forEach(function (h) { h = parseFloat(h); if (!isNaN(h) && h >= 12 && h <= 26 && (h * 2) % 1 === 0 && clean.indexOf(h) < 0) clean.push(h); }); if (clean.length) { clean.sort(function (a, b) { return a - b; }); gAv[d] = clean; } });
      tAv.avail = tAv.avail || {};
      tAv.avail[memAv] = gAv;
      Object.keys(tAv.avail).forEach(function (k) { if (memNames.indexOf(k) < 0) delete tAv.avail[k]; });
      await redis(['SET', 'doom:teams', JSON.stringify(lkAv)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucDraftAdd') { // ⚔️ 밴픽/전적 기록 (팀원/운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var lkD = []; try { lkD = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkD = []; }
      var tD = aucResolveMyTeam(lkD, s, body.acct);
      if (!tD) return res.status(403).json({ error: '팀원만 입력할 수 있어요' });
      if (!Array.isArray(tD.drafts)) tD.drafts = [];
      tD.drafts.push({ id: 'dr' + Date.now() + Math.floor(Math.random() * 1000), date: String(body.date || '').slice(0, 10), vs: String(body.vs || '').slice(0, 30), ourPick: String(body.ourPick || '').slice(0, 120), theirPick: String(body.theirPick || '').slice(0, 120), ban: String(body.ban || '').slice(0, 120), result: String(body.result || '').slice(0, 10), note: String(body.note || '').slice(0, 200), at: Date.now() });
      if (tD.drafts.length > 100) tD.drafts = tD.drafts.slice(-100);
      await redis(['SET', 'doom:teams', JSON.stringify(lkD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucDraftDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var lkDD = []; try { lkDD = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkDD = []; }
      var tDD = aucResolveMyTeam(lkDD, s, body.acct);
      if (!tDD) return res.status(403).json({ error: '권한 없음' });
      if (Array.isArray(tDD.drafts)) tDD.drafts = tDD.drafts.filter(function (x) { return x.id !== body.id; });
      await redis(['SET', 'doom:teams', JSON.stringify(lkDD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucTeamPracAdd') { // 📅 비공개 팀 연습 날짜 추가 (팀장/운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var dtP = String(body.date || '').slice(0, 10); if (!dtP) return res.status(400).json({ error: '날짜를 선택해주세요' });
      var lkP = []; try { lkP = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkP = []; }
      if (!lkP.length) return res.status(400).json({ error: '먼저 팀 명단을 확정해주세요' });
      var tgtP = (isOp(s) && body.acct) ? String(body.acct) : s.name, foundP = false;
      lkP.forEach(function (t) { if (t.acct === tgtP) { if (!Array.isArray(t.practice)) t.practice = []; t.practice.push({ id: 'tp' + Date.now() + Math.floor(Math.random() * 1000), date: dtP, note: String(body.note || '').slice(0, 80) }); foundP = true; } });
      if (!foundP) return res.status(403).json({ error: '본인 팀만 쓸 수 있어요' });
      await redis(['SET', 'doom:teams', JSON.stringify(lkP)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucTeamPracDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var lkPD = []; try { lkPD = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkPD = []; }
      var tgtPD = (isOp(s) && body.acct) ? String(body.acct) : s.name;
      lkPD.forEach(function (t) { if (t.acct === tgtPD && Array.isArray(t.practice)) t.practice = t.practice.filter(function (x) { return x.id !== body.id; }); });
      await redis(['SET', 'doom:teams', JSON.stringify(lkPD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucResultAdd') { // 🏆 경기 결과 기록 (운영)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aN = String(body.aName || '').trim(), bN = String(body.bName || '').trim();
      if (!aN || !bN) return res.status(400).json({ error: '두 팀을 선택해주세요' });
      if (aN === bN) return res.status(400).json({ error: '같은 팀끼리는 안 돼요' });
      var sA = parseInt(body.scoreA, 10), sB = parseInt(body.scoreB, 10);
      if (isNaN(sA) || isNaN(sB) || sA < 0 || sB < 0) return res.status(400).json({ error: '점수를 입력해주세요' });
      var lkR = []; try { lkR = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkR = []; }
      var colOf = {}; lkR.forEach(function (t) { colOf[t.name] = t.color; });
      var resR = []; try { resR = JSON.parse((await redis(['GET', 'doom:results'])) || '[]'); } catch (e) { resR = []; }
      var lnR = null;
      if (body.lineup && typeof body.lineup === 'object') {
        var cleanSideR = function (sd) { sd = sd || {}; var picks = (Array.isArray(sd.picks) ? sd.picks : []).slice(0, 5).map(function (x) { x = x || {}; return { p: String(x.p || '').slice(0, 30), c: String(x.c || '').slice(0, 30) }; }); var bans = (Array.isArray(sd.bans) ? sd.bans : []).slice(0, 5).map(function (x) { return String(x || '').slice(0, 30); }); return { picks: picks, bans: bans }; };
        lnR = { a: cleanSideR(body.lineup.a), b: cleanSideR(body.lineup.b) };
      }
      resR.push({ id: 'r' + Date.now() + Math.floor(Math.random() * 1000), type: (body.type === '스크림' ? '스크림' : '멸망전'), date: String(body.date || '').slice(0, 10), aName: aN, aColor: colOf[aN] || '', bName: bN, bColor: colOf[bN] || '', scoreA: sA, scoreB: sB, round: String(body.round || '').slice(0, 30), note: String(body.note || '').slice(0, 100), lineup: lnR, at: Date.now() });
      await redis(['SET', 'doom:results', JSON.stringify(resR)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucResultDel') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var resD = []; try { resD = JSON.parse((await redis(['GET', 'doom:results'])) || '[]'); } catch (e) { resD = []; }
      resD = resD.filter(function (x) { return x.id !== body.id; });
      await redis(['SET', 'doom:results', JSON.stringify(resD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucAvailAdd') { // 🟢 연습 가능 날짜 등록 (로그인 누구나)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var dtAv = String(body.date || '').slice(0, 10); if (!dtAv) return res.status(400).json({ error: '날짜를 선택해주세요' });
      var avA = []; try { avA = JSON.parse((await redis(['GET', 'doom:avail'])) || '[]'); } catch (e) { avA = []; }
      if (avA.some(function (x) { return x.by === s.name && x.date === dtAv; })) return res.status(400).json({ error: '이미 등록한 날짜예요' });
      var lkAv = []; try { lkAv = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkAv = []; }
      var myTeamAv = null;
      lkAv.forEach(function (t) { if (t.acct === s.name) myTeamAv = t; (t.roster || []).forEach(function (r) { if (r.name === s.name) myTeamAv = t; }); });
      avA.push({ id: 'av' + Date.now() + Math.floor(Math.random() * 1000), date: dtAv, by: s.name, teamName: myTeamAv ? myTeamAv.name : '', color: myTeamAv ? myTeamAv.color : '', note: String(body.note || '').slice(0, 80), at: Date.now() });
      await redis(['SET', 'doom:avail', JSON.stringify(avA)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucAvailDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var avD = []; try { avD = JSON.parse((await redis(['GET', 'doom:avail'])) || '[]'); } catch (e) { avD = []; }
      var opAvD = isOp(s);
      avD = avD.filter(function (x) { return !(x.id === body.id && (x.by === s.name || opAvD)); });
      await redis(['SET', 'doom:avail', JSON.stringify(avD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucLockTeams') { // 🔒 현재 로스터를 영구 확정(못 박기)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aLK = await aucGet(); if (!aLK || !aLK.teams || !aLK.teams.length) return res.status(400).json({ error: '확정할 팀이 없어요' });
      var prevLK = []; try { prevLK = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { prevLK = []; }
      var prevByA = {}; prevLK.forEach(function (t) { prevByA[t.acct] = t; });
      var locked = aLK.teams.map(function (t) { var p = prevByA[t.acct] || {}; var prevPos = {}; (p.roster || []).forEach(function (r) { prevPos[r.name] = r.position; }); return { acct: t.acct, name: p.name || t.name, leader: t.leader, color: t.color, points: t.points, leaderPos: p.leaderPos || '', roster: (t.roster || []).map(function (r) { return { name: r.name, cost: r.cost, position: r.position || prevPos[r.name] || '', tier: r.tier }; }), sched: p.sched || '', practice: p.practice || [], weekly: p.weekly || {}, drafts: p.drafts || [], avail: p.avail || {} }; });
      await redis(['SET', 'doom:teams', JSON.stringify(locked)]);
      aLK.phase = 'done'; aLK.confirmed = true; aLK.queue = []; aLK.current = null;
      await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aLK);
      return res.status(200).json({ ok: true, teams: locked.length });
    }
    if (action === 'aucSetTeamName') { // ✏️ 팀명 변경 (팀장 본인 or 운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var nmN = String(body.name || '').trim().slice(0, 20); if (!nmN) return res.status(400).json({ error: '팀명을 입력해주세요' });
      var lkN = []; try { lkN = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkN = []; }
      if (!lkN.length) return res.status(400).json({ error: '먼저 팀 명단을 확정(못 박기)해주세요' });
      var tN = aucResolveMyTeam(lkN, s, body.acct);
      if (!tN) return res.status(403).json({ error: '본인 팀만 바꿀 수 있어요' });
      tN.name = nmN;
      await redis(['SET', 'doom:teams', JSON.stringify(lkN)]);
      return res.status(200).json({ ok: true, name: nmN });
    }
    if (action === 'aucSetTeamSched') { // 📋 팀 비공개 일정 메모 (팀장 본인 or 운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var txtS = String(body.sched || '').slice(0, 1500);
      var lkS = []; try { lkS = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkS = []; }
      if (!lkS.length) return res.status(400).json({ error: '먼저 팀 명단을 확정해주세요' });
      var tgtS = (isOp(s) && body.acct) ? String(body.acct) : s.name, foundS = false;
      lkS.forEach(function (t) { if (t.acct === tgtS) { t.sched = txtS; foundS = true; } });
      if (!foundS) return res.status(403).json({ error: '본인 팀만 쓸 수 있어요' });
      await redis(['SET', 'doom:teams', JSON.stringify(lkS)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucFinalize') { // 운영 — 현재 로스터로 확정·종료
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aFN = await aucGet(); if (!aFN || !aFN.active) return res.status(400).json({ error: '경매 없음' });
      aFN.phase = 'done'; aFN.confirmed = true; aFN.queue = []; aFN.current = null;
      await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aFN);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucPublish') { // 운영 — 멸망전 페이지를 다른 팀장·관전자에게 공개/숨김
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      await redis(['SET', 'doom:open', String(body.level || 'closed')]);
      return res.status(200).json({ ok: true, open: String(body.level || 'closed') });
    }
    if (action === 'aucReset') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      await redis(['DEL', 'doom:auc']); await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await redis(['DEL', 'doom:auc:bidlog']); return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '알 수 없는 요청: ' + action });
  } catch (e) {
    return res.status(500).json({ error: '경매 서버 오류: ' + (e && e.message ? e.message : String(e)) });
  }
};
