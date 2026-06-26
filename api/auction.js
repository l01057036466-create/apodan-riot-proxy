// ═══════════════════════════════════════════════════════════════
// 아포단 멸망전 경매 API — bank와 분리된 독립 서버 (같은 Upstash 공유)
// 위치: 저장소 api/auction.js  (bank.js 옆에 둠)
// 필요 환경변수: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (bank와 동일)
// 로그인 세션(sess:TOKEN)을 bank와 공유 → 같은 로그인으로 인증됨
// 관전은 비로그인도 OK · 입찰/운영은 로그인 필요
// ═══════════════════════════════════════════════════════════════
var crypto = require('crypto');

// 🤖 LLM 호출 (무료 Gemini 우선 → 없으면 Claude). 환경변수 GEMINI_API_KEY 또는 ANTHROPIC_API_KEY 필요
async function callLLM(prompt, maxTokens) {
  var gk = process.env.GEMINI_API_KEY;
  var ak = process.env.ANTHROPIC_API_KEY;
  if (gk) {
    var gm = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    var gr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + gm + ':generateContent?key=' + gk, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } })
    });
    var gd = await gr.json();
    if (!gr.ok) throw new Error((gd.error && gd.error.message) || 'Gemini 호출 실패');
    return ((((gd.candidates || [])[0] || {}).content || {}).parts || []).map(function (p) { return p.text || ''; }).join('').trim();
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
    if (action === 'aucDraftSim') { // 🤖 AI 드래프트 모의결과 (Claude API)
      if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI가 아직 설정 안 됐어요 — 무료 GEMINI_API_KEY(또는 ANTHROPIC_API_KEY)를 Vercel에 추가해주세요' });
      var sBp = (body.bluePicks || []).filter(Boolean), sRp = (body.redPicks || []).filter(Boolean);
      if (sBp.length < 3 || sRp.length < 3) return res.status(400).json({ error: '양 팀 픽이 3명 이상 필요해요' });
      var sL = function (a) { return (a || []).filter(Boolean).join(', ') || '(없음)'; };
      var sPw = function (p) { return (p && p > 0) ? ('\n평균 체급(선수 실력): ' + Math.round(p) + '/100') : ''; };
      var sRoster = function (r) { return (r && String(r).trim()) ? ('\n[내전 선수단 챔프풀]\n' + r) : ''; };
      var sPrompt = '당신은 리그 오브 레전드 드래프트 분석 전문가입니다. 아래 밴픽을 보고 모의 경기 결과를 예측해주세요.\n\n'
        + '🔵 ' + (body.blue || '블루팀') + ' (블루)\n픽: ' + sL(body.bluePicks) + '\n밴: ' + sL(body.blueBans) + sPw(body.bluePow) + sRoster(body.blueRoster) + '\n\n'
        + '🔴 ' + (body.red || '레드팀') + ' (레드)\n픽: ' + sL(body.redPicks) + '\n밴: ' + sL(body.redBans) + sPw(body.redPow) + sRoster(body.redRoster) + '\n\n'
        + '다음을 한국어로, 간결하고 실전 코칭 톤으로 분석해주세요:\n'
        + '1) 예상 승자와 승률 (예: 블루 62%)\n'
        + '2) 각 팀 조합 평가 — 딜 구성(AD/AP)/탱킹/이니시에이팅/스케일링/라인전 강약\n'
        + '3) 핵심 승부처와 그 이유 (챔피언 시너지·카운터·한타 구도·게임 흐름)\n'
        + '4) 약한 팀이 뒤집을 수 있는 변수\n\n'
        + ((body.blueRoster || body.redRoster) ? '위 내전 챔프풀(주력 챔프·승률)을 반영해서, 각 선수가 이 픽을 잘 다루는 챔프인지/숙련도까지 평가에 넣어주세요.\n' : ((body.bluePow && body.redPow) ? '체급(선수 실력)도 참고하되, 챔피언 조합 중심으로 분석해주세요.\n' : ''))
        + '마크다운 헤더(#)나 별표(**)는 쓰지 말고, 이모지와 줄바꿈으로 읽기 좋게 정리해주세요. 5~8줄 정도로.';
      try {
        var simText = await callLLM(sPrompt, 1100);
        return res.status(200).json({ ok: true, analysis: simText || '(분석 결과가 비어 있어요)' });
      } catch (e) { return res.status(502).json({ error: 'AI 호출 오류: ' + (e && e.message || '') }); }
    }
    if (action === 'aucDraftSuggest') { // 🤔 모르겠음 — AI가 이번 차례 픽/밴 추천 (솔랭·자랭 추정 + 내전 데이터)
      if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI가 아직 설정 안 됐어요 — 무료 GEMINI_API_KEY를 추가해주세요' });
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
      var sgPrompt = '리그 오브 레전드 드래프트 진행 중. 나는 ' + sgSide + '팀이고, 지금 우리 팀의 ' + sgType + ' 차례입니다.\n\n'
        + '【우리 팀(' + sgSide + ')】 픽: ' + sgL(sgMyPicks) + ' / 밴: ' + sgL(sgMyBans) + '\n'
        + '【상대 팀】 픽: ' + sgL(sgOppPicks) + ' / 밴: ' + sgL(sgOppBans) + '\n\n'
        + (body.roster ? ('우리 팀(' + sgSide + ') 선수 내전 챔프풀(솔랭·자랭 경향 추정 포함):\n' + body.roster + '\n\n') : '')
        + '진영 참고: 우리 팀은 ' + (sgMeBlue ? '블루(선픽 주도권 — 좋은 챔프를 먼저 선점하는 진영)' : '레드(후픽·막픽 카운터 우위 — 상대 픽을 보고 대응하는 진영)') + '입니다.\n'
        + '우리 팀에게 가장 유리한 ' + sgType + '을 아래 목록에서 하나만 고르세요.\n'
        + (body.type === 'ban'
            ? '밴 기준: 우리 팀 선수에게 까다로운(상대가 우리 상대로 쓰면 위협적인) 챔피언, 또는 상대가 잘 다룰 챔피언을 밴해 상대를 견제하세요. (= 우리에게 불리한 챔프를 지우는 것)'
            : '픽 기준: 우리 팀 기존 픽과 시너지가 좋고, 상대 팀 픽을 카운터하며, 우리 팀 선수가 잘 다루는 챔피언을 고르세요. 아직 안 뽑힌 포지션을 우선하세요.') + '\n\n'
        + '출력 형식: 첫 줄에 챔피언 이름만 (반드시 아래 목록에 있는 그대로), 둘째 줄에 25자 이내 이유 한 줄.\n\n'
        + '가능 챔피언 목록: ' + avail.join(', ');
      try {
        var sgText = await callLLM(sgPrompt, 120);
        var sgLines = sgText.split('\n').filter(function (l) { return l.trim(); });
        var sgChamp = (sgLines[0] || '').replace(/^[0-9.)\-\s]+/, '').replace(/["'`]/g, '').trim();
        var sgReason = (sgLines.slice(1).join(' ') || '').trim();
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
